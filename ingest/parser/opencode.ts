/**
 * OpenCode SQLite Parser
 *
 * Reads opencode sessions from opencode.db (SQLite) and produces canonical
 * ParseResult objects. Stateless: open readonly per call, close after.
 *
 * Per Phase 17 decisions D-01 through D-11.
 *
 * @module ingest/parser/opencode
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  TraceSession,
  TraceMessage,
  TraceToolCall,
  TraceThinkingBlock,
  TraceSystemEvent,
  TraceSubagentLink,
  TraceActivity,
  TraceToolResultEvent,
  ToolCategory,
  SourceMetadata,
  TokenUsage,
} from '@/types/trace';
import { ParseResult, ParseError } from './types';
import { normalizeModelName } from '../pricing/normalize-model.js';
import { inspectOpencodeSchema, listOpencodeSessions, openOpencodeReadonly, withOpencodeRetry } from './opencode-storage';

const OPENCODE_SKIP_KEY_VERSION = 'opencode-parser-v5-v2-storage';
type OpencodeTimestamp = string | number | null;

interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface OpencodeSessionRow {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  slug: string | null;
  directory: string | null;
  title: string | null;
  version: string | null;
  agent: string | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  time_created: OpencodeTimestamp;
  time_updated: OpencodeTimestamp;
  time_archived: OpencodeTimestamp;
  path: string | null;
  workspace_id: string | null;
}

interface OpencodeProjectRow {
  id: string;
  worktree: string | null;
  name: string | null;
  vcs: string | null;
}

interface OpencodeMessageRow {
  id: string;
  session_id: string;
  time_created: OpencodeTimestamp;
  time_updated: OpencodeTimestamp;
  data: string | null;
}

interface OpencodePartRow {
  type?: string;
  id: string;
  message_id: string;
  session_id: string;
  time_created: OpencodeTimestamp;
  time_updated: OpencodeTimestamp;
  data: string | null;
}

function inferOpencodeToolCategory(name: string): ToolCategory {
  const lower = name.toLowerCase();
  if (lower === 'bash' || lower.includes('shell')) return 'Bash';
  if (lower === 'read') return 'Read';
  if (lower === 'write' || lower === 'edit') return 'Edit';
  if (lower === 'grep' || lower === 'glob') return 'Grep';
  if (lower === 'task') return 'Task';
  if (lower === 'agent') return 'Agent';
  return 'Other';
}

function parseModelJson(modelStr: string | null): string | undefined {
  if (!modelStr) return undefined;
  try {
    const parsed = JSON.parse(modelStr);
    if (parsed && typeof parsed === 'object') {
      const provider = parsed.providerID ?? parsed.providerId ?? '';
      const id = parsed.id ?? '';
      const normalized = normalizeModelName(provider ? `${provider}/${id}` : id);
      return normalized || undefined;
    }
    if (typeof parsed === 'string') {
      const normalized = normalizeModelName(parsed);
      return normalized || undefined;
    }
    return undefined;
  } catch {
    const normalized = normalizeModelName(modelStr);
    return normalized || undefined;
  }
}

function parseJsonData(dataStr: string | null): Record<string, unknown> | null {
  if (!dataStr) return null;
  try {
    return asRecord(JSON.parse(dataStr)) ?? null;
  } catch {
    return null;
  }
}

function safeTimestamp(val: OpencodeTimestamp): string | null {
  if (val == null) return null;

  if (typeof val === 'number') {
    return timestampNumberToIso(val);
  }

  const trimmed = val.trim();
  if (!trimmed) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return timestampNumberToIso(Number(trimmed));
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  return trimmed;
}

function timestampNumberToIso(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;

  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function safeNumber(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
  if (typeof val === 'string') {
    const parsed = Number(val);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

function safeNullableNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function createTokenAccumulator(): TokenAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.totalTokens
    ?? usage.inputTokens
      + usage.outputTokens
      + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0)
      + (usage.reasoningTokens ?? 0);
}

function mergeTokenUsage(existing: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  if (!existing) return { ...usage };

  return {
    inputTokens: existing.inputTokens + usage.inputTokens,
    outputTokens: existing.outputTokens + usage.outputTokens,
    cacheReadTokens: (existing.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: (existing.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: (existing.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
    totalTokens: tokenUsageTotal(existing) + tokenUsageTotal(usage),
    usageSemantics: existing.usageSemantics === usage.usageSemantics ? existing.usageSemantics : undefined,
  };
}

function addUsageToAccumulator(accumulator: TokenAccumulator, usage?: TokenUsage): void {
  if (!usage) return;

  accumulator.inputTokens += usage.inputTokens;
  accumulator.outputTokens += usage.outputTokens;
  accumulator.cacheReadTokens += usage.cacheReadTokens ?? 0;
  accumulator.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  accumulator.reasoningTokens += usage.reasoningTokens ?? 0;
  accumulator.totalTokens += tokenUsageTotal(usage);
}

function parseOpencodeTokenUsage(source: Record<string, unknown> | null | undefined): TokenUsage | undefined {
  const tokens = asRecord(source?.tokens);
  if (!tokens) return undefined;

  const cache = asRecord(tokens.cache);
  const inputTokens = safeNumber(tokens.input ?? tokens.input_tokens);
  const outputTokens = safeNumber(tokens.output ?? tokens.output_tokens);
  const cacheReadTokens = safeNumber(cache?.read ?? tokens.cache_read ?? tokens.cacheRead);
  const cacheWriteTokens = safeNumber(cache?.write ?? tokens.cache_write ?? tokens.cacheWrite);
  const reasoningTokens = safeNumber(tokens.reasoning ?? tokens.reasoning_tokens);
  const totalTokens = safeNumber(tokens.total ?? tokens.total_tokens);

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0 &&
    reasoningTokens === 0 &&
    totalTokens === 0
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: totalTokens || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
    usageSemantics: 'additive',
  };
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return undefined;
}

function pickString(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function stringifyValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;

  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return String(value);
  }
}

function opencodeToolStatus(
  rawStatus: unknown,
  hasOutput: boolean,
): TraceToolCall['status'] {
  if (typeof rawStatus === 'string') {
    const status = rawStatus.toLowerCase();
    if (status === 'completed' || status === 'success') return 'success';
    if (status === 'error' || status === 'failed') return 'error';
  }
  return hasOutput ? 'success' : 'pending';
}

function opencodeDurationMs(
  state: Record<string, unknown> | undefined,
): number | undefined {
  const time = asRecord(state?.time);
  const start = safeNullableNumber(time?.start);
  const end = safeNullableNumber(time?.end);
  if (start == null || end == null || end < start) return undefined;
  return end - start;
}

export async function parseOpencodeSession(
  dbPath: string,
  rawSessionId: string,
  projectOverride?: string,
): Promise<ParseResult> {
  const errors: ParseError[] = [];
  const warnings: string[] = [];
  const messages: TraceMessage[] = [];
  const activities: TraceActivity[] = [];

  let db: Database.Database | undefined;

  try {
    db = openOpencodeReadonly(dbPath);
    const schema = inspectOpencodeSchema(db);
    const sessionRow = listOpencodeSessions(db, schema, rawSessionId).find(row => row.id === rawSessionId);

    if (!sessionRow) {
      return {
        session: createEmptySession(rawSessionId, projectOverride ?? ''),
        messages: [],
        activities: [],
        errors: [
          {
            line: 0,
            raw: rawSessionId,
            error: `Session not found: ${rawSessionId}`,
          },
        ],
        warnings: [],
      };
    }

    let projectPath = projectOverride ?? sessionRow.directory ?? '';

    if (!projectOverride && sessionRow.project_id) {
      const projectRow = withOpencodeRetry(() =>
        db!.prepare('SELECT * FROM project WHERE id = ?').get(
          sessionRow.project_id,
        ),
      ) as OpencodeProjectRow | undefined;

      if (projectRow?.worktree) {
        projectPath = projectRow.worktree;
      }
    }

    const isV2 = sessionRow.storage_layout === 'v2';
    const messageRows = withOpencodeRetry(() => db!.prepare(
      isV2
        ? 'SELECT * FROM session_message WHERE session_id = ? ORDER BY seq, id'
        : 'SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id',
    ).all(rawSessionId)) as (OpencodeMessageRow & { type?: string })[];
    const partRows = withOpencodeRetry(() => !isV2
      ? db!.prepare('SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id').all(rawSessionId)
      : schema.splitParts
        ? db!.prepare("SELECT *, message_id || ':' || ordinal AS id FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal").all(rawSessionId)
        : []) as (OpencodePartRow & { type?: string })[];

    const partsByMessage = new Map<string, OpencodePartRow[]>();
    for (const part of partRows) {
      const existing = partsByMessage.get(part.message_id) ?? [];
      existing.push(part);
      partsByMessage.set(part.message_id, existing);
    }

    const sessionId = `opencode:${sessionRow.id}`;
    let model = parseModelJson(sessionRow.model);
    let ordinal = 0;
    let currentTurnIndex = -1;
    let v2TurnClosed = true;
    let currentTurnId: string | undefined;
    let startedAt: string | null = safeTimestamp(sessionRow.time_created);
    let endedAt: string | null = null;
    let hasToolCalls = false;
    const messageTokenTotals = createTokenAccumulator();

    const sourceMetadata: SourceMetadata = {
      sourceType: 'opencode',
      sourceFile: dbPath,
      sourceVersion: sessionRow.version ?? undefined,
    };

    for (const msgRow of messageRows) {
      const msgData = parseJsonData(msgRow.data);
      if (!msgData) {
        errors.push({ line: ordinal, raw: msgRow.id, error: 'Invalid OpenCode message JSON' });
        continue;
      }
      const role = isV2 ? msgRow.type : msgData.role ?? 'unknown';
      if (isV2 && msgData.model) model = parseModelJson(JSON.stringify(msgData.model)) ?? model;

      const ts = safeTimestamp(msgRow.time_created);
      if (ts) {
        if (!startedAt || ts < startedAt) startedAt = ts;
        if (!endedAt || ts > endedAt) endedAt = ts;
      }

      if (role === 'user' && (!isV2 || v2TurnClosed)) {
        currentTurnIndex++;
        currentTurnId = `turn-${currentTurnIndex}`;
        v2TurnClosed = false;
      }
      // V2 idle markers close turns; steered prompts before idle remain in the same turn.
      if (isV2 && role === 'idle') v2TurnClosed = true;

      const turnId = currentTurnId;
      const turnIndex = currentTurnIndex >= 0 ? currentTurnIndex : undefined;

      const msgParts = [...(partsByMessage.get(msgRow.id) ?? [])];
      if (isV2) {
        const inline = Array.isArray(msgData.content) ? msgData.content : [];
        const content = role === 'assistant' ? inline : [
          ...(typeof msgData.text === 'string' ? [{ type: 'text', text: msgData.text }] : []),
          ...(Array.isArray(msgData.files) ? msgData.files.map(file => ({ ...asRecord(file), type: 'file' })) : []),
        ];
        for (const [index, part] of content.entries()) msgParts.push({ ...msgRow, id: `${msgRow.id}:inline:${index}`, message_id: msgRow.id, type: undefined, data: JSON.stringify(part) });
      }
      const textParts: string[] = [];
      const fileAttachments: string[] = [];
      const messageLevelTokenUsage = parseOpencodeTokenUsage(msgData);
      let partLevelTokenUsage: TokenUsage | undefined;

      for (const partRow of msgParts) {
        const partData = parseJsonData(partRow.data);
        if (!partData) continue;

        if (!messageLevelTokenUsage) {
          const partTokenUsage = parseOpencodeTokenUsage(partData);
          if (partTokenUsage) {
            partLevelTokenUsage = mergeTokenUsage(partLevelTokenUsage, partTokenUsage);
          }
        }

        const partType = partRow.type ?? partData.type as string | undefined;
        if (!partType) continue;

        switch (partType) {
          case 'text': {
            const text =
              typeof partData.text === 'string' ? partData.text : '';
            if (text) textParts.push(text);
            break;
          }

          case 'tool': {
            hasToolCalls = true;
            const state = asRecord(partData.state);
            const toolName =
              pickString(partData, ['tool', 'name']) ?? 'unknown';
            const callId =
              pickString(partData, ['callID', 'callId', 'call_id', 'id']) ??
              partRow.id;
            const input = stringifyValue(
              state && 'input' in state ? state.input : partData.input,
              '{}',
            );
            const outputValue = state && 'output' in state
              ? state.output
              : state?.content != null ? opencodeContentText(state.content) : state?.error ?? partData.output;
            const output = stringifyValue(outputValue);
            const hasOutput = outputValue != null && output.length > 0;
            const resultTimestamp =
              (isV2 ? safeTimestamp(asRecord(partData.time)?.completed as OpencodeTimestamp) : null) ??
              safeTimestamp(partRow.time_updated) ??
              safeTimestamp(partRow.time_created);

            const resultEvents: TraceToolResultEvent[] = hasOutput
              ? [
                  {
                    type: 'result_event',
                    timestamp: resultTimestamp ?? undefined,
                    content: output,
                    isPartial: false,
                  },
                ]
              : [];

            const toolCall: TraceToolCall = {
              type: 'tool_call',
              id: callId,
              name: toolName,
              category: inferOpencodeToolCategory(toolName),
              inputJson: input,
              resultEvents,
              status: opencodeToolStatus(state?.status ?? partData.status, hasOutput),
              durationMs: opencodeDurationMs(isV2 ? { time: { start: asRecord(partData.time)?.ran ?? asRecord(partData.time)?.created, end: asRecord(partData.time)?.completed } } : state),
              messageOrdinal: ordinal,
            };

            activities.push(toolCall);
            break;
          }

          case 'reasoning': {
            const content =
              typeof partData.text === 'string' ? partData.text : '';
            activities.push({
              type: 'thinking',
              content,
              isRedacted: false,
            } as TraceThinkingBlock);
            break;
          }

          case 'patch': {
            hasToolCalls = true;
            const patchCallId =
              typeof partData.id === 'string'
                ? partData.id
                : partRow.id;
            const files = partData.files ?? partData.patches;
            const patchInput =
              files !== undefined ? stringifyValue(files, '{}') : '{}';

            const toolCall: TraceToolCall = {
              type: 'tool_call',
              id: patchCallId,
              name: 'patch',
              category: 'Edit',
              inputJson: patchInput,
              resultEvents: [],
              status: 'pending',
              messageOrdinal: ordinal,
            };

            activities.push(toolCall);
            break;
          }

          case 'step-start':
          case 'step-finish': {
            const stepContent =
              typeof partData.text === 'string'
                ? partData.text
                : JSON.stringify(partData);
            activities.push({
              type: 'system',
              subtype: partType,
              content: stepContent,
            } as TraceSystemEvent);
            break;
          }

          case 'subtask': {
            const sessionIdRef = partData.sessionId ?? partData.session_id;
            if (
              typeof sessionIdRef === 'string' &&
              sessionIdRef.length > 0
            ) {
              activities.push({
                type: 'subagent_link',
                subagentSessionId: `opencode:${sessionIdRef}`,
                subagentSource: 'opencode',
                relationship: 'spawned',
                messageOrdinal: ordinal,
              } as TraceSubagentLink);
            } else {
              const subContent =
                typeof partData.text === 'string'
                  ? partData.text
                  : JSON.stringify(partData);
              activities.push({
                type: 'system',
                subtype: 'subtask',
                content: subContent,
              } as TraceSystemEvent);
            }
            break;
          }

          case 'file': {
            const fileName =
              typeof partData.name === 'string' ? partData.name : '';
            const filePath =
              typeof partData.path === 'string' ? partData.path : fileName || (typeof partData.uri === 'string' ? partData.uri : '');
            if (filePath) {
              fileAttachments.push(`[Attachment: ${filePath}]`);
            }
            break;
          }

          default:
            warnings.push(
              `Unknown part type: ${partType} in part ${partRow.id}`,
            );
            break;
        }
      }

      if (isV2 && role !== 'user' && role !== 'assistant') {
        activities.push({ type: 'system', subtype: msgRow.type ?? 'unknown', content: pickString(msgData, ['text', 'summary', 'description']) ?? JSON.stringify(msgData) } as TraceSystemEvent);
        if (!textParts.length && typeof msgData.summary === 'string') textParts.push(msgData.summary);
      }

      let content = textParts.join('\n');
      if (fileAttachments.length > 0) {
        content = content
          ? `${content}\n${fileAttachments.join('\n')}`
          : fileAttachments.join('\n');
      }

      if (!content && msgData) {
        const msgContent = msgData.content;
        if (typeof msgContent === 'string') {
          content = msgContent;
        } else if (Array.isArray(msgContent)) {
          content = msgContent
            .map((block: Record<string, unknown>) => (typeof block?.text === 'string' ? block.text : ''))
            .filter(Boolean)
            .join('\n');
        }
      }

      const message: TraceMessage = {
        id: `${sessionId}-${ordinal}`,
        ordinal,
        role: role === 'user' || role === 'assistant' || role === 'system' || role === 'tool_result'
          ? role
          : 'system',
        content,
        timestamp: safeTimestamp(msgRow.time_created) ?? undefined,
        model,
        turnId,
        turnIndex,
        isRealUserInput: role === 'user',
        tokenUsage: messageLevelTokenUsage ?? partLevelTokenUsage,
        sourceMetadata,
      };

      addUsageToAccumulator(messageTokenTotals, message.tokenUsage);
      messages.push(message);
      ordinal++;
    }

    // V2 stores authoritative totals, including explicit zeros. Legacy exports may omit them.
    const hasSessionUsage = isV2 || [sessionRow.tokens_input, sessionRow.tokens_output, sessionRow.tokens_cache_read, sessionRow.tokens_cache_write, sessionRow.tokens_reasoning].some(value => safeNumber(value) > 0);
    const inputTokens = hasSessionUsage ? safeNumber(sessionRow.tokens_input) : messageTokenTotals.inputTokens;
    const outputTokens = hasSessionUsage ? safeNumber(sessionRow.tokens_output) : messageTokenTotals.outputTokens;
    const cacheReadTokens = hasSessionUsage ? safeNumber(sessionRow.tokens_cache_read) : messageTokenTotals.cacheReadTokens;
    const cacheWriteTokens = hasSessionUsage ? safeNumber(sessionRow.tokens_cache_write) : messageTokenTotals.cacheWriteTokens;
    const reasoningTokens = hasSessionUsage ? safeNumber(sessionRow.tokens_reasoning) : messageTokenTotals.reasoningTokens;
    const totalTokens =
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
    const sourceCostUsd = safeNullableNumber(sessionRow.cost);

    const session: TraceSession = {
      id: sessionId,
      source: 'opencode',
      project: projectPath,
      name: sessionRow.title || sessionRow.slug || undefined,
      startedAt,
      endedAt,
      updatedAt: safeTimestamp(sessionRow.time_updated) ?? undefined,
      status: sessionRow.time_archived ? 'idle' : endedAt ? 'idle' : 'active',
      parentSessionId: sessionRow.parent_id || sessionRow.fork_session_id
        ? `opencode:${sessionRow.parent_id || sessionRow.fork_session_id}`
        : undefined,
      relationshipType: sessionRow.parent_id ? 'subagent' : sessionRow.fork_session_id ? 'fork' : 'root',
      sourceSessionId: rawSessionId,
      cwd: sessionRow.directory ?? undefined,
      model,
      sourceCostUsd,
      costSource: sourceCostUsd == null ? null : 'source-reported',
      costPricingStatus: sourceCostUsd == null
        ? null
        : sourceCostUsd === 0 && totalTokens > 0
          ? 'reported_zero'
          : 'priced',
      metrics: {
        messageCount: messages.length,
        userMessageCount: messages.filter((m) => m.role === 'user').length,
        inputTokens: inputTokens || undefined,
        outputTokens: outputTokens || undefined,
        cacheReadTokens: cacheReadTokens || undefined,
        cacheWriteTokens: cacheWriteTokens || undefined,
        reasoningTokens: reasoningTokens || undefined,
        totalTokens: isV2 ? totalTokens : totalTokens || undefined,
        hasToolCalls,
        parserMalformedLines: errors.length,
        isTruncated: false,
      },
      turns: [],
    };

    return { session, messages, activities, errors, warnings };
  } catch (err) {
    return {
      session: createEmptySession(rawSessionId, projectOverride ?? ''),
      messages: [],
      activities: [],
      errors: [
        {
          line: 0,
          raw: dbPath,
          error: err instanceof Error ? err.message : String(err),
        },
      ],
      warnings,
    };
  } finally {
    db?.close();
  }
}

function createEmptySession(
  rawSessionId: string,
  project: string,
): TraceSession {
  return {
    id: `opencode:${rawSessionId}`,
    source: 'opencode',
    project,
    startedAt: null,
    endedAt: null,
    status: 'error',
    relationshipType: 'root',
    sourceSessionId: rawSessionId,
    metrics: {
      messageCount: 0,
      userMessageCount: 0,
      totalTokens: 0,
      hasToolCalls: false,
      parserMalformedLines: 0,
      isTruncated: false,
    },
    turns: [],
  };
}

export function computeOpencodeSkipKey(
  session: OpencodeSessionRow,
  messageCount: number,
  partCount: number,
  storageFingerprint = '',
): string {
  const composite = `${OPENCODE_SKIP_KEY_VERSION}:opencode:${session.id}:${session.time_updated}:${messageCount}:${partCount}:${storageFingerprint}`;
  return crypto.createHash('sha256').update(composite).digest('hex');
}

function opencodeContentText(value: unknown): string {
  if (!Array.isArray(value)) return stringifyValue(value);
  return value.map(item => {
    const block = asRecord(item);
    return block?.type === 'text' ? stringifyValue(block.text) : block?.type === 'file' ? `[Attachment: ${block.name ?? block.uri ?? ''}]` : stringifyValue(item);
  }).join('\n');
}
