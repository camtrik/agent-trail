/**
 * Turn Assembler
 *
 * Enhanced turn assembly with compact/system/queued boundary handling,
 * tool call pairing, and subagent linking.
 *
 * Per D-08: user message opens a new turn, subsequent messages belong to that turn.
 * Per D-10: compact/system boundaries are detected and stored as activities.
 * Per D-11: tool calls paired with result events, subagent sessions linked.
 *
 * @module ingest/turns/assembler
 */

import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import {
  TraceTurn,
  TraceMessage,
  TraceActivity,
  TraceToolCall,
  TraceSubagentLink,
  TraceSystemEvent,
  TraceSource,
  MessageRole,
  ToolCategory,
  TokenUsage,
  TurnEnrichment,
} from '@/types/trace';

const QODER_INJECTED_CONTEXT_MARKER = '[[qoder-injected-context]]\n';

// ============================================================================
// Public API
// ============================================================================

/**
 * Assemble messages into turn-first representation.
 *
 * Handles compact/system/queued boundaries (D-10), pairs tool calls
 * with result events (D-11), and links subagent sessions (D-11).
 *
 * Each user message opens a new turn. Consecutive user messages are merged
 * as queued commands (D-05). Compact events mark turns as truncated.
 *
 * @param sessionId - Session to assemble turns for
 * @param db - Optional database connection (defaults to getDatabase())
 * @returns Array of assembled TraceTurn objects
 */
export async function assembleTurns(
  sessionId: string,
  db?: Database.Database
): Promise<TraceTurn[]> {
  const database = db || getDatabase();

  // Fetch all messages for the session, ordered by ordinal
  const messages = database.prepare(`
    SELECT
      m.id, m.ordinal, m.role, m.content, m.timestamp, m.model,
      m.token_usage_json, m.source_file, m.source_line,
      m.turn_id, m.turn_index, m.is_real_user_input,
      s.source
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.session_id = ?
    ORDER BY m.ordinal ASC
  `).all(sessionId) as MessageRow[];

  if (messages.some((msg) => msg.turn_index !== null && msg.turn_index !== undefined)) {
    const turns = assembleTurnsFromStoredBoundaries(messages, sessionId);
    await pairToolCalls(turns, sessionId, database);
    await attachPersistedSubagentLinks(turns, sessionId, database);
    await linkSubagents(turns, sessionId, database);
    return turns.map(enrichTurn);
  }

  const turns: TraceTurn[] = [];
  let currentTurn: Partial<TraceTurn> | null = null;
  let turnIndex = 0;

  for (const msg of messages) {
    const message = parseMessageRow(msg);

    // D-10: Compact boundary handling — check before system message handling
    if (message.role === 'system') {
      const isCompact =
        message.content?.includes('[compact]') ||
        message.content?.toLowerCase().includes('compact');

      if (isCompact) {
        // D-10: Mark preceding turn messages as truncated
        if (currentTurn) {
          currentTurn.isTruncated = true;
          currentTurn.activities = currentTurn.activities || [];
          currentTurn.activities.push({
            type: 'system',
            subtype: 'compact',
            content: message.content,
          } as TraceSystemEvent);
        }
        continue;
      }

      // D-02, D-10: Non-compact system messages stored as system events
      if (currentTurn) {
        currentTurn.activities = currentTurn.activities || [];
        currentTurn.activities.push(systemEventFromMessage(message));
      }
      continue;
    }

    // D-05: Queued command detection and merging
    if (message.role === 'user') {
      const isQueuedPrefix = message.content?.startsWith('[QUEUED]');

      // Check if this is a queued command continuation (D-05)
      // Either it has [QUEUED] prefix, or it's a consecutive user message
      // without intervening assistant messages
      const isConsecutiveUser =
        currentTurn &&
        currentTurn.userMessage &&
        !currentTurn.assistantMessages?.length;

      if (isQueuedPrefix || isConsecutiveUser) {
        if (currentTurn && currentTurn.userMessage) {
          // Merge: strip [QUEUED] prefix and append to existing user message
          const queuedContent = isQueuedPrefix
            ? (message.content?.replace(/^\[QUEUED\]\s*/, '') || message.content)
            : message.content;
          currentTurn.userMessage.content += '\n' + queuedContent;
          continue; // Don't start a new turn
        }
      }

      // Close previous turn if it has content
      if (
        currentTurn &&
        currentTurn.assistantMessages &&
        currentTurn.assistantMessages.length > 0
      ) {
        currentTurn.endedAt = message.timestamp || null;
        currentTurn.durationMs = calculateDuration(
          currentTurn.startedAt ?? null,
          currentTurn.endedAt ?? null
        );
        turns.push(finalizeTurn(currentTurn, sessionId, turnIndex));
        turnIndex++;
      }

      // Start new turn
      currentTurn = {
        id: `${sessionId}-turn-${turnIndex}`,
        sessionId,
        index: turnIndex,
        userMessage: message,
        assistantMessages: [],
        activities: [],
        startedAt: message.timestamp || null,
        endedAt: null,
        durationMs: null,
        tokenUsage: message.tokenUsage,
      };
    } else if (currentTurn) {
      // Non-user message belongs to current turn
      if (message.role === 'assistant') {
        currentTurn.assistantMessages!.push(message);
      } else if (message.role === 'tool_result') {
        currentTurn.assistantMessages!.push(message);
      }
    }
  }

  // Close final turn
  if (
    currentTurn &&
    currentTurn.assistantMessages &&
    currentTurn.assistantMessages.length > 0
  ) {
    turns.push(finalizeTurn(currentTurn, sessionId, turnIndex));
  }

  // D-11: Post-processing — pair tool calls with result events
  await pairToolCalls(turns, sessionId, database);

  // D-11: Post-processing — restore parser-emitted subagent links
  await attachPersistedSubagentLinks(turns, sessionId, database);

  // D-11: Post-processing — link subagent sessions
  await linkSubagents(turns, sessionId, database);

  return turns.map(enrichTurn);
}

// ============================================================================
// Tool Call Pairing (D-11)
// ============================================================================

/**
 * Pair tool calls with result events for all turns in a session.
 *
 * Queries tool_calls and tool_result_events tables, matches by
 * tool_call_id, and adds TraceToolCall activities to each turn.
 *
 * @param turns - Assembled turns
 * @param sessionId - Session ID
 * @param db - Database connection
 */
async function pairToolCalls(
  turns: TraceTurn[],
  sessionId: string,
  db: Database.Database
): Promise<void> {
  for (const turn of turns) {
    if (!turn.assistantMessages?.length) continue;

    const ordinals = turn.assistantMessages.map((m) => m.ordinal);
    const placeholders = ordinals.map(() => '?').join(',');

    const toolCalls = db
      .prepare(
        `
      SELECT id, message_ordinal, tool_id, name, category, input_json, status, error, duration_ms
      FROM tool_calls
      WHERE session_id = ? AND message_ordinal IN (${placeholders})
      ORDER BY message_ordinal ASC, id ASC
    `
      )
      .all(sessionId, ...ordinals) as ToolCallRow[];

    for (const tc of toolCalls) {
      // Query result events for this tool call
      const resultEvents = db
        .prepare(
          `
        SELECT content, is_partial, timestamp
        FROM tool_result_events
        WHERE tool_call_id = ?
        ORDER BY id ASC
      `
        )
        .all(tc.id) as ResultEventRow[];

      const activity: TraceToolCall = {
        type: 'tool_call',
        id: tc.tool_id,
        name: tc.name,
        category: (tc.category as ToolCategory) || 'Other',
        inputJson: tc.input_json,
        resultEvents: resultEvents.map((re) => ({
          type: 'result_event' as const,
          content: re.content,
          isPartial: Boolean(re.is_partial),
          timestamp: re.timestamp || undefined,
        })),
        status: tc.status as 'pending' | 'success' | 'error',
        error: tc.error || undefined,
        durationMs: tc.duration_ms || undefined,
        messageOrdinal: tc.message_ordinal,
      };

      addActivityAnchored(turn, activity);
    }
  }
}

// ============================================================================
// Subagent Linking (D-11)
// ============================================================================

/**
 * Link subagent sessions to their parent session's turns.
 *
 * Queries sessions table for child sessions (parent_session_id = sessionId)
 * and anchors each TraceSubagentLink to the turn/tool call that spawned it.
 *
 * @param turns - Assembled turns
 * @param sessionId - Parent session ID
 * @param db - Database connection
 */
async function linkSubagents(
  turns: TraceTurn[],
  sessionId: string,
  db: Database.Database
): Promise<void> {
  // Query child sessions (subagents)
  const childSessions = db
    .prepare(
      `
    SELECT id, source, source_session_id, started_at FROM sessions
    WHERE parent_session_id = ?
  `
    )
    .all(sessionId) as ChildSessionRow[];

  if (childSessions.length === 0) return;

  for (const child of childSessions) {
    if (hasSubagentLink(turns, child.id)) continue;

    const anchor = findSubagentAnchor(turns, child);
    if (!anchor) continue;

    addActivityAnchored(anchor.turn, {
      type: 'subagent_link',
      subagentSessionId: child.id,
      subagentSource: child.source as TraceSource,
      relationship: 'spawned',
      messageOrdinal: anchor.messageOrdinal,
    } as TraceSubagentLink);
  }
}

async function attachPersistedSubagentLinks(
  turns: TraceTurn[],
  sessionId: string,
  db: Database.Database
): Promise<void> {
  const links = db
    .prepare(
      `
    SELECT subagent_session_id, subagent_source, relationship, message_ordinal
    FROM subagent_links
    WHERE session_id = ?
    ORDER BY id ASC
  `
    )
    .all(sessionId) as SubagentLinkRow[];

  for (const link of links) {
    if (hasSubagentLink(turns, link.subagent_session_id)) continue;

    const anchor =
      findTurnForMessageOrdinal(turns, link.message_ordinal) ||
      (turns[0] ? { turn: turns[0], messageOrdinal: undefined } : null);
    if (!anchor) continue;

    addActivityAnchored(anchor.turn, {
      type: 'subagent_link',
      subagentSessionId: link.subagent_session_id,
      subagentSource: link.subagent_source as TraceSource,
      relationship: link.relationship as 'spawned' | 'attached',
      ...(typeof link.message_ordinal === 'number'
        ? { messageOrdinal: link.message_ordinal }
        : {}),
    } as TraceSubagentLink);
  }
}

// ============================================================================
// Internal Types
// ============================================================================

interface MessageRow {
  id: string;
  ordinal: number;
  role: string;
  content: string;
  timestamp: string | null;
  model: string | null;
  token_usage_json: string | null;
  source_file: string;
  source_line: number | null;
  turn_id: string | null;
  turn_index: number | null;
  is_real_user_input: number | null;
  source: string;
}

interface ToolCallRow {
  id: number;
  message_ordinal: number;
  tool_id: string;
  name: string;
  category: string | null;
  input_json: string;
  status: string;
  error: string | null;
  duration_ms: number | null;
}

interface ResultEventRow {
  content: string;
  is_partial: number;
  timestamp: string | null;
}

interface ChildSessionRow {
  id: string;
  source: string;
  source_session_id: string | null;
  started_at: string | null;
}

interface SubagentLinkRow {
  subagent_session_id: string;
  subagent_source: string;
  relationship: string;
  message_ordinal: number | null;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function parseMessageRow(row: MessageRow): TraceMessage {
  return {
    id: row.id,
    ordinal: row.ordinal,
    role: row.role as MessageRole,
    content: row.content,
    timestamp: row.timestamp || undefined,
    model: row.model || undefined,
    turnId: row.turn_id || undefined,
    turnIndex: row.turn_index ?? undefined,
    isRealUserInput: row.is_real_user_input === 1,
    tokenUsage: row.token_usage_json
      ? (JSON.parse(row.token_usage_json) as TokenUsage)
      : undefined,
    sourceMetadata: {
      sourceType: row.source as TraceSource,
      sourceFile: row.source_file,
      sourceLine: row.source_line || undefined,
    },
  };
}

function systemEventFromMessage(message: TraceMessage): TraceSystemEvent {
  if (message.content.startsWith(QODER_INJECTED_CONTEXT_MARKER)) {
    return {
      type: 'system',
      subtype: 'qoder_injected_context',
      content: message.content.slice(QODER_INJECTED_CONTEXT_MARKER.length),
    };
  }

  return {
    type: 'system',
    subtype: message.content.toLowerCase().includes('compact') ? 'compact' : 'system_message',
    content: message.content,
  };
}

function tokenUsageTotal(usage: TokenUsage): number {
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;

  const cacheTokens = usage.usageSemantics === 'overlap'
    ? 0
    : (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.reasoningTokens ?? 0);
  return usage.inputTokens + usage.outputTokens + cacheTokens;
}

function combineTokenUsage(messages: Array<TraceMessage | null | undefined>): TokenUsage | undefined {
  let combined: TokenUsage | undefined;

  for (const message of messages) {
    const usage = message?.tokenUsage;
    if (!usage) continue;

    if (!combined) {
      combined = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        usageSemantics: usage.usageSemantics,
      };
    }

    if (usage.sourceCostUsd !== undefined) combined.sourceCostUsd = (combined.sourceCostUsd ?? 0) + usage.sourceCostUsd;
    combined.inputTokens += usage.inputTokens;
    combined.outputTokens += usage.outputTokens;
    combined.cacheReadTokens = (combined.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
    combined.cacheWriteTokens = (combined.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    combined.reasoningTokens = (combined.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    combined.totalTokens = (combined.totalTokens ?? 0) + tokenUsageTotal(usage);
    if (combined.usageSemantics !== usage.usageSemantics) {
      combined.usageSemantics = undefined;
    }
  }

  return combined;
}

function assembleTurnsFromStoredBoundaries(
  rows: MessageRow[],
  sessionId: string
): TraceTurn[] {
  const grouped = new Map<number, TraceMessage[]>();

  for (const row of rows) {
    if (row.turn_index === null || row.turn_index === undefined) continue;
    const list = grouped.get(row.turn_index) ?? [];
    list.push(parseMessageRow(row));
    grouped.set(row.turn_index, list);
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a - b)
    .map(([storedTurnIndex, messagesForTurn], outputIndex) => {
      const userMessage =
        messagesForTurn.find((message) => message.role === 'user' && message.isRealUserInput) ||
        messagesForTurn.find((message) => message.role === 'user') ||
        null;
      const assistantMessages = messagesForTurn.filter((message) =>
        message.role === 'assistant' || message.role === 'tool_result'
      );
      const systemActivities = messagesForTurn
        .filter((message) => message.role === 'system')
        .map(systemEventFromMessage);

      const startedAt = userMessage?.timestamp || messagesForTurn[0]?.timestamp || null;
      const endedAt =
        messagesForTurn[messagesForTurn.length - 1]?.timestamp ||
        assistantMessages[assistantMessages.length - 1]?.timestamp ||
        null;

      return {
        id: `${sessionId}-turn-${storedTurnIndex}`,
        sessionId,
        index: outputIndex,
        userMessage,
        assistantMessages,
        activities: systemActivities,
        startedAt,
        endedAt,
        durationMs: calculateDuration(startedAt, endedAt),
        tokenUsage: combineTokenUsage(messagesForTurn),
        isTruncated: systemActivities.some((activity) => activity.subtype === 'compact') || undefined,
      };
    });
}

function findSubagentAnchor(
  turns: TraceTurn[],
  child: ChildSessionRow
): { turn: TraceTurn; messageOrdinal?: number } | null {
  let firstAgentToolAnchor: { turn: TraceTurn; messageOrdinal?: number } | null = null;

  for (const turn of turns) {
    for (const activity of turn.activities) {
      if (activity.type !== 'tool_call') continue;
      const isAgentTool =
        activity.category === 'Agent' ||
        activity.category === 'Task' ||
        activity.name.toLowerCase().includes('agent') ||
        activity.name.toLowerCase().includes('task');

      if (isAgentTool && !firstAgentToolAnchor) {
        firstAgentToolAnchor = { turn, messageOrdinal: activity.messageOrdinal };
      }

      if (toolCallReferencesChild(activity, child)) {
        return { turn, messageOrdinal: activity.messageOrdinal };
      }
    }
  }

  return firstAgentToolAnchor || (turns[0] ? { turn: turns[0] } : null);
}

function findTurnForMessageOrdinal(
  turns: TraceTurn[],
  messageOrdinal: number | null
): { turn: TraceTurn; messageOrdinal: number } | null {
  if (typeof messageOrdinal !== 'number') return null;

  for (const turn of turns) {
    const messageOwnsOrdinal = turn.assistantMessages.some(
      (message) => message.ordinal === messageOrdinal
    );
    const activityOwnsOrdinal = turn.activities.some(
      (activity) =>
        activity.type === 'tool_call' &&
        activity.messageOrdinal === messageOrdinal
    );

    if (messageOwnsOrdinal || activityOwnsOrdinal) {
      return { turn, messageOrdinal };
    }
  }

  return null;
}

function hasSubagentLink(turns: TraceTurn[], subagentSessionId: string): boolean {
  return turns.some((turn) =>
    turn.activities.some(
      (activity) =>
        activity.type === 'subagent_link' &&
        activity.subagentSessionId === subagentSessionId
    )
  );
}

function addActivityAnchored(turn: TraceTurn, activity: TraceActivity): void {
  const ordinal = getActivityMessageOrdinal(activity);
  if (typeof ordinal !== 'number') {
    turn.activities.push(activity);
    return;
  }

  const insertAt = turn.activities.findIndex((existing) => {
    const existingOrdinal = getActivityMessageOrdinal(existing);
    return typeof existingOrdinal === 'number' && existingOrdinal > ordinal;
  });

  if (insertAt === -1) {
    turn.activities.push(activity);
  } else {
    turn.activities.splice(insertAt, 0, activity);
  }
}

function getActivityMessageOrdinal(activity: TraceActivity): number | undefined {
  if (activity.type !== 'tool_call' && activity.type !== 'subagent_link') {
    return undefined;
  }
  return typeof activity.messageOrdinal === 'number'
    ? activity.messageOrdinal
    : undefined;
}

function toolCallReferencesChild(toolCall: TraceToolCall, child: ChildSessionRow): boolean {
  const needles = [child.id, child.source_session_id]
    .filter((value): value is string => Boolean(value && value.trim()));
  if (needles.length === 0) return false;

  const haystack = [
    toolCall.inputJson,
    ...toolCall.resultEvents.map((event) => event.content),
  ].join('\n');

  return needles.some((needle) => haystack.includes(needle));
}

function finalizeTurn(
  partial: Partial<TraceTurn>,
  sessionId: string,
  index: number
): TraceTurn {
  const assistantMessages = partial.assistantMessages || [];
  return {
    id: partial.id!,
    sessionId,
    index: partial.index!,
    userMessage: partial.userMessage || null,
    assistantMessages,
    activities: partial.activities || [],
    startedAt: partial.startedAt ?? null,
    endedAt: partial.endedAt ?? null,
    durationMs: partial.durationMs ?? null,
    tokenUsage: combineTokenUsage([partial.userMessage, ...assistantMessages]),
    isTruncated: partial.isTruncated || undefined,
  };
}

/**
 * Enrich a turn with computed metadata for Phase 10 HUD display.
 * Computes activity counts, failure status, warning flags at query time.
 */
function enrichTurn(turn: TraceTurn): TraceTurn {
  const activityCounts: TurnEnrichment['activityCounts'] = {
    toolCalls: turn.activities.filter(a => a.type === 'tool_call').length,
    skills: turn.activities.filter(a => a.type === 'skill_use').length,
    subagents: turn.activities.filter(a => a.type === 'subagent_link').length,
    thinking: turn.activities.filter(a => a.type === 'thinking').length,
    system: turn.activities.filter(a => a.type === 'system').length,
  };

  const hasError = turn.activities.some(a =>
    a.type === 'tool_call' && a.status === 'error'
  );

  const hasWarning = turn.activities.some(a =>
    a.type === 'system' && a.subtype === 'system_message'
  );

  return {
    ...turn,
    enrichment: {
      activityCounts,
      failureStatus: hasError ? 'error' as const : 'success' as const,
      truncated: turn.isTruncated || false,
      warningStatus: hasWarning,
    },
  };
}

function calculateDuration(
  startedAt: string | null,
  endedAt: string | null
): number | null {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  return end - start;
}

// ============================================================================
// Turn Count
// ============================================================================

/**
 * Count turns for a session.
 * Simple heuristic: count user messages (each starts a turn per D-08).
 */
export function getTurnCount(
  sessionId: string,
  db?: Database.Database
): number {
  const database = db || getDatabase();

  const storedBoundaryResult = database
    .prepare(
      `
    SELECT COUNT(DISTINCT turn_index) as count
    FROM messages
    WHERE session_id = ? AND turn_index IS NOT NULL
  `
    )
    .get(sessionId) as { count: number };

  if (storedBoundaryResult.count > 0) {
    return storedBoundaryResult.count;
  }

  const result = database
    .prepare(
      `
    SELECT COUNT(*) as count
    FROM messages
    WHERE session_id = ? AND role = 'user'
  `
    )
    .get(sessionId) as { count: number };

  return result.count;
}
