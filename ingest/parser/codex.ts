/**
 * Codex JSONL Parser
 *
 * Parses Codex session files from JSONL format into canonical trace model.
 * Handles turn_context boundary mapping, response_item field discrimination,
 * function_call pairing, spawn_agent subagent linking, and token_count-based
 * streaming deduplication.
 *
 * Per D-06 through D-09 in Phase 3 CONTEXT.md.
 *
 * @module ingest/parser/codex
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { getCodexSessionMeta } from './codex-meta';
import {
  TraceSession,
  TraceMessage,
  TraceToolCall,
  TraceToolResultEvent,
  TraceSubagentLink,
  TraceActivity,
  ToolCategory,
  MessageRole,
  SourceMetadata,
  TokenUsage,
} from '@/types/trace';
import {
  CodexJsonlLine,
  CodexPayload,
  CodexTurnContext,
  IncrementalParseDelta,
  IncrementalParseOptions,
  ParseResult,
  ParseError,
  SessionContext,
  TokenUsageEvent,
} from './types';

interface PendingCodexUserMessage {
  dedupKey: string;
  tokenCount: number;
  message: TraceMessage;
  lineNum: number;
}

interface JsonlRangeLine {
  line: string;
  lineNumber: number;
}

interface JsonlRangeRead {
  lines: JsonlRangeLine[];
  cursorOffset: number;
  cursorLine: number;
}

function getCodexPayload(parsed: CodexJsonlLine): CodexPayload | undefined {
  return parsed.payload && typeof parsed.payload === 'object'
    ? parsed.payload as CodexPayload
    : undefined;
}

function getCodexTurnContext(parsed: CodexJsonlLine): {
  turn_id?: string;
  model?: string;
  started_at?: string;
  cwd?: string;
  git_branch?: string;
} | undefined {
  if (parsed.turn_context) return parsed.turn_context;
  const payload = getCodexPayload(parsed);
  if (!payload) return undefined;

  return {
    turn_id: payload.turn_id,
    model: payload.model,
    started_at: payload.started_at,
    cwd: payload.cwd,
    git_branch: payload.git_branch || payload.gitBranch,
  };
}

function getCodexResponseItem(parsed: CodexJsonlLine): CodexPayload | undefined {
  if (parsed.response_item) return parsed.response_item as CodexPayload;
  return getCodexPayload(parsed);
}

function getCodexEventMsg(parsed: CodexJsonlLine): CodexPayload | undefined {
  if (parsed.event_msg) return parsed.event_msg as CodexPayload;
  return getCodexPayload(parsed);
}

interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
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

function coerceTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function getCodexUsageTotal(usage: TokenUsage): number {
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
}

function addUsageToAccumulator(accumulator: TokenAccumulator, usage?: TokenUsage): void {
  if (!usage) return;

  accumulator.inputTokens += usage.inputTokens;
  accumulator.outputTokens += usage.outputTokens;
  accumulator.cacheReadTokens += usage.cacheReadTokens ?? 0;
  accumulator.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  accumulator.reasoningTokens += usage.reasoningTokens ?? 0;
  accumulator.totalTokens += getCodexUsageTotal(usage);
}

function addUsageToDelta(delta: IncrementalParseDelta, usage?: TokenUsage): void {
  if (!usage) return;

  delta.metricsDelta.totalInputTokens += usage.inputTokens;
  delta.metricsDelta.totalOutputTokens += usage.outputTokens;
  delta.metricsDelta.totalCacheReadTokens = (delta.metricsDelta.totalCacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  delta.metricsDelta.totalCacheWriteTokens = (delta.metricsDelta.totalCacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  delta.metricsDelta.totalReasoningTokens = (delta.metricsDelta.totalReasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  delta.metricsDelta.totalTokens = (delta.metricsDelta.totalTokens ?? 0) + getCodexUsageTotal(usage);
}

function mergeCodexTokenUsage(existing: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  if (!existing) return { ...usage };

  const existingSemantics = existing.usageSemantics;
  const usageSemantics = usage.usageSemantics;

  return {
    inputTokens: existing.inputTokens + usage.inputTokens,
    outputTokens: existing.outputTokens + usage.outputTokens,
    cacheReadTokens: (existing.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: (existing.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: (existing.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
    totalTokens: getCodexUsageTotal(existing) + getCodexUsageTotal(usage),
    usageSemantics: existingSemantics === usageSemantics ? existingSemantics : undefined,
  };
}

function attachCodexTokenUsageToLatestMessage(
  messageVersions: Map<string, { tokenCount: number; message: TraceMessage }>,
  usage: TokenUsage | undefined,
  currentTurnId: string | undefined,
  currentTurnIndex: number
): void {
  if (!usage) return;

  let target: TraceMessage | undefined;

  for (const entry of messageVersions.values()) {
    const message = entry.message;
    if (message.role !== 'assistant' && message.role !== 'tool_result') continue;
    if (currentTurnId && message.turnId !== currentTurnId) continue;
    if (!currentTurnId && currentTurnIndex >= 0 && message.turnIndex !== currentTurnIndex) continue;
    if (!target || message.ordinal > target.ordinal) {
      target = message;
    }
  }

  if (!target) return;
  target.tokenUsage = mergeCodexTokenUsage(target.tokenUsage, usage);
}

function codexUsageSnapshotKey(usage: TokenUsage): string {
  return [
    usage.inputTokens,
    usage.cacheReadTokens ?? 0,
    usage.outputTokens,
    usage.reasoningTokens ?? 0,
    getCodexUsageTotal(usage),
  ].join(':');
}

function codexTokenEventSnapshotKey(
  tokenUsage: { total?: TokenUsage; last?: TokenUsage },
  timestamp?: string
): string | undefined {
  if (tokenUsage.total) return `total:${codexUsageSnapshotKey(tokenUsage.total)}`;
  if (tokenUsage.last) return `last:${timestamp ?? ''}:${codexUsageSnapshotKey(tokenUsage.last)}`;
  return undefined;
}

function subtractCodexUsage(current: TokenUsage, previous?: TokenUsage): TokenUsage {
  if (!previous) return current;

  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, (current.cacheReadTokens ?? 0) - (previous.cacheReadTokens ?? 0)),
    cacheWriteTokens: Math.max(0, (current.cacheWriteTokens ?? 0) - (previous.cacheWriteTokens ?? 0)),
    reasoningTokens: Math.max(0, (current.reasoningTokens ?? 0) - (previous.reasoningTokens ?? 0)),
    totalTokens: Math.max(0, getCodexUsageTotal(current) - getCodexUsageTotal(previous)),
    usageSemantics: current.usageSemantics,
  };
}

function parseCodexUsageRecord(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const record = value as {
    input_tokens?: unknown;
    cached_input_tokens?: unknown;
    output_tokens?: unknown;
    reasoning_output_tokens?: unknown;
    total_tokens?: unknown;
  };

  const inputTokens = coerceTokenCount(record.input_tokens);
  const cacheReadTokens = coerceTokenCount(record.cached_input_tokens);
  const outputTokens = coerceTokenCount(record.output_tokens);
  const reasoningTokens = coerceTokenCount(record.reasoning_output_tokens);
  const totalTokens = coerceTokenCount(record.total_tokens);

  if (
    inputTokens === 0 &&
    cacheReadTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === 0 &&
    totalTokens === 0
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    reasoningTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
    usageSemantics: 'overlap',
  };
}

function extractCodexTokenUsage(eventMsg: CodexPayload): {
  total?: TokenUsage;
  last?: TokenUsage;
} | undefined {
  if (eventMsg.type !== 'token_count') return undefined;

  const info = eventMsg.info;
  if (!info || typeof info !== 'object') return undefined;

  const tokenInfo = info as {
    total_token_usage?: unknown;
    last_token_usage?: unknown;
  };

  const total = parseCodexUsageRecord(tokenInfo.total_token_usage);
  const last = parseCodexUsageRecord(tokenInfo.last_token_usage);

  if (!total && !last) return undefined;
  return { total, last };
}

function extractCodexMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const value = block as { text?: unknown; input_text?: unknown; output_text?: unknown };
      if (typeof value.text === 'string') return value.text;
      if (typeof value.input_text === 'string') return value.input_text;
      if (typeof value.output_text === 'string') return value.output_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function mapCodexRole(role: unknown): MessageRole | null {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  if (role === 'tool_result') return 'tool_result';
  return null;
}

function extractCodexUserEventContent(eventMsg: CodexPayload): string {
  if (typeof eventMsg.message === 'string') return eventMsg.message;
  if (typeof eventMsg.content === 'string') return eventMsg.content;
  if (typeof eventMsg.text === 'string') return eventMsg.text;
  return '';
}

function normalizeCodexUserContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/<image\b[^>]*>\s*<\/image>\s*/gi, '')
    .trim();
}

function isCodexMetadataUserMessage(content: string): boolean {
  const lower = content.trim().toLowerCase();
  const metadataPrefixes = [
    '# agents.md instructions',
    '<environment_context',
    '<permissions instructions',
    '<collaboration_mode',
    '<personality_spec',
    '<apps_instructions',
    '<skills_instructions',
    '<skill>',
    '<subagent_notification',
    '<turn_aborted',
    '<local-command-caveat',
    '<local-command-stdout',
  ];

  return metadataPrefixes.some((prefix) => lower.startsWith(prefix));
}

// ============================================================================
// Main Entry Point — parseCodexSession
// ============================================================================

/**
 * Parse a Codex session file and return structured trace data
 *
 * @param filePath - Full path to the Codex JSONL session file
 * @param project - Project name for session metadata
 * @returns ParseResult with session, messages, activities, errors, and warnings
 */
export async function parseCodexSession(
  filePath: string,
  project: string
): Promise<ParseResult> {
  const errors: ParseError[] = [];
  const warnings: string[] = [];
  const messages: TraceMessage[] = [];
  const activities: TraceActivity[] = [];

  // Extract session context from file path
  const context = extractCodexSessionContext(filePath, project);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return {
      session: createEmptySession(context),
      messages: [],
      activities: [],
      errors: [
        {
          line: 0,
          raw: filePath,
          error: 'File does not exist',
        },
      ],
      warnings: [],
    };
  }

  // Parse JSONL line by line
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let ordinal = 0;
  let lineNum = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  const tokenTotals = createTokenAccumulator();
  const tokenEvents: TokenUsageEvent[] = [];
  let hasToolCalls = false;

  // Turn context tracking (D-06)
  let currentModel: string | undefined;
  const turnContexts: CodexTurnContext[] = [];

  // Session metadata from session_meta line
  let sessionCwd: string | undefined;
  let sessionGitBranch: string | undefined;
  let sessionModel: string | undefined;
  let sessionId: string = context.uuid;
  let parentSessionId: string | undefined;
  let currentTurnId: string | undefined;
  let currentTurnIndex = -1;
  let pendingUserResponseMessage: PendingCodexUserMessage | undefined;
  let lastTokenSnapshotKey: string | undefined;
  let previousTotalTokenUsage: TokenUsage | undefined;

  // Token-count dedup tracking (D-09)
  // Key: call_id for function_calls, content for text messages
  const messageVersions = new Map<
    string,
    { tokenCount: number; message: TraceMessage }
  >();

  // Tool call registry for pairing with function_call_output events (D-11)
  const toolCallMap = new Map<string, TraceToolCall>();
  const toolCallOrdinalMap = new Map<string, number>();

  const ensureTurn = (turnId?: string, startedAtForTurn?: string | null): void => {
    if (!turnId && currentTurnId) {
      if (startedAtForTurn && !startedAt) {
        startedAt = startedAtForTurn;
      }
      return;
    }
    const nextTurnId = turnId || `turn-${currentTurnIndex + 1}`;
    if (currentTurnId !== nextTurnId) {
      currentTurnId = nextTurnId;
      currentTurnIndex++;
    }
    if (startedAtForTurn && !startedAt) {
      startedAt = startedAtForTurn;
    }
  };

  const currentTurnMetadata = () => ({
    turnId: currentTurnId,
    turnIndex: currentTurnIndex >= 0 ? currentTurnIndex : undefined,
  });

  const flushPendingUserResponseMessage = (): void => {
    if (!pendingUserResponseMessage) return;
    handleDedup(
      pendingUserResponseMessage.dedupKey,
      pendingUserResponseMessage.tokenCount,
      pendingUserResponseMessage.message,
      messageVersions,
      warnings,
      pendingUserResponseMessage.lineNum
    );
    pendingUserResponseMessage = undefined;
  };

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;

    try {
      const parsed: CodexJsonlLine = JSON.parse(line);

      const eventMsgBeforeResponse = getCodexEventMsg(parsed);
      if (parsed.type === 'event_msg' && eventMsgBeforeResponse?.type === 'task_started') {
        ensureTurn(
          eventMsgBeforeResponse.turn_id || eventMsgBeforeResponse.id,
          parsed.timestamp
        );
      }

      // Handle session_meta — extract metadata from first line
      const sessionMeta = getCodexSessionMeta(parsed);
      if (parsed.type === 'session_meta' && sessionMeta) {
        if (sessionMeta.session_id) {
          sessionId = sessionMeta.session_id;
        }
        parentSessionId = sessionMeta.parentSessionId || parentSessionId;
        if (sessionMeta.cwd) {
          sessionCwd = sessionMeta.cwd;
        }
        if (sessionMeta.git_branch) {
          sessionGitBranch = sessionMeta.git_branch;
        }
        if (sessionMeta.model) {
          sessionModel = sessionMeta.model;
        }
        if (parsed.timestamp && !startedAt) {
          startedAt = parsed.timestamp;
        }
        continue;
      }

      // Handle turn_context — extract turn boundary and model (D-06)
      const turnContext = getCodexTurnContext(parsed);
      if (parsed.type === 'turn_context' && turnContext) {
        const turnStartedAt = turnContext.started_at || parsed.timestamp;
        currentModel = turnContext.model || currentModel;
        sessionCwd = turnContext.cwd || sessionCwd;
        sessionGitBranch = turnContext.git_branch || sessionGitBranch;
        if (!currentTurnId) {
          ensureTurn(turnContext.turn_id || `turn-${lineNum}`, turnStartedAt);
        } else if (turnContext.turn_id) {
          currentTurnId = turnContext.turn_id;
        }
        turnContexts.push({
          turnId: currentTurnId || turnContext.turn_id || `turn-${lineNum}`,
          model: turnContext.model,
          startedAt: turnStartedAt,
        });
        if (turnStartedAt && !startedAt) {
          startedAt = turnStartedAt;
        }
        continue;
      }

      // Handle response_item — the core message/activity type (D-07)
      const responseItem = getCodexResponseItem(parsed);
      if (parsed.type === 'response_item' && responseItem) {
        const ri = responseItem;
        const timestamp = parsed.timestamp;

        // Track timestamp boundaries
        if (timestamp) {
          if (!startedAt) startedAt = timestamp;
          endedAt = timestamp;
        }

        // input_text → TraceMessage (user)
        if (ri.type === 'input_text') {
          ensureTurn(undefined, timestamp || null);
          const content = ri.input_text || '';
          const dedupKey = `text:${content}`;
          const tokenCount = ri.token_count ?? 0;
          const sourceMetadata = createSourceMetadata(
            context,
            lineNum,
            sessionCwd,
            sessionGitBranch
          );

          const message: TraceMessage = {
            id: `${sessionId}-${ordinal}`,
            ordinal,
            role: 'user',
            content,
            timestamp,
            model: currentModel || sessionModel,
            ...currentTurnMetadata(),
            isRealUserInput: true,
            sourceMetadata,
          };

          handleDedup(dedupKey, tokenCount, message, messageVersions, warnings, lineNum);
          ordinal++;
          continue;
        }

        // message payloads are the shape emitted by current Codex JSONL logs:
        // { type: "response_item", payload: { type: "message", role, content: [...] } }
        if (ri.type === 'message') {
          const content = extractCodexMessageContent(ri.content);
          const role = mapCodexRole(ri.role);
          if (!content || !role) {
            warnings.push(
              `Line ${lineNum}: Skipping message payload without role/content`
            );
            continue;
          }

          const dedupKey = `message:${role}:${content}`;
          const tokenCount = ri.token_count ?? 0;
          const sourceMetadata = createSourceMetadata(
            context,
            lineNum,
            sessionCwd,
            sessionGitBranch
          );

          const message: TraceMessage = {
            id: `${sessionId}-${ordinal}`,
            ordinal,
            role,
            content,
            timestamp,
            model: currentModel || sessionModel,
            ...currentTurnMetadata(),
            isRealUserInput: role === 'user' && !isCodexMetadataUserMessage(content),
            sourceMetadata,
          };

          if (role === 'user') {
            if (isCodexMetadataUserMessage(content)) {
              continue;
            }
            ensureTurn(undefined, timestamp || null);
            message.turnId = currentTurnId;
            message.turnIndex = currentTurnIndex;
            pendingUserResponseMessage = { dedupKey, tokenCount, message, lineNum };
          } else {
            flushPendingUserResponseMessage();
            handleDedup(dedupKey, tokenCount, message, messageVersions, warnings, lineNum);
          }
          ordinal++;
          continue;
        }

        // text → TraceMessage (assistant)
        if (ri.type === 'text' || ri.type === 'output_text') {
          flushPendingUserResponseMessage();
          const content = ri.text || ri.output_text || '';
          const dedupKey = `text:${content}`;
          const tokenCount = ri.token_count ?? 0;
          const sourceMetadata = createSourceMetadata(
            context,
            lineNum,
            sessionCwd,
            sessionGitBranch
          );

          const message: TraceMessage = {
            id: `${sessionId}-${ordinal}`,
            ordinal,
            role: 'assistant',
            content,
            timestamp,
            model: currentModel || sessionModel,
            ...currentTurnMetadata(),
            isRealUserInput: false,
            sourceMetadata,
          };

          handleDedup(dedupKey, tokenCount, message, messageVersions, warnings, lineNum);
          ordinal++;
          continue;
        }

        // function_call_output as a response_item payload — some Codex versions emit this
        // as { type: "response_item", payload: { type: "function_call_output", call_id, output } }
        if (ri.type === 'function_call_output') {
          flushPendingUserResponseMessage();
          const callId = ri.call_id;
          if (callId && toolCallMap.has(callId)) {
            const toolCall = toolCallMap.get(callId)!;
            const resultEvent: TraceToolResultEvent = {
              type: 'result_event',
              timestamp: parsed.timestamp,
              content: ri.output || extractCodexMessageContent(ri.content),
              isPartial: ri.status !== 'completed',
            };
            toolCall.resultEvents.push(resultEvent);
            if (ri.status === 'completed') {
              toolCall.status = 'success';
            }
          } else {
            warnings.push(
              `Line ${lineNum}: function_call_output response_item for unknown call_id: ${callId}`
            );
          }
          continue;
        }

        // function_call → TraceToolCall (D-07)
        if (ri.type === 'function_call') {
          flushPendingUserResponseMessage();
          const callId = ri.call_id || `call-${lineNum}`;
          const name = ri.name || 'unknown';
          // Normalize arguments from either 'arguments' (string) or 'input' (object)
          const inputJson = ri.arguments
            ? ri.arguments
            : ri.input
              ? JSON.stringify(ri.input)
              : '{}';

          // Dedup function calls by token_count too (D-09)
          const tokenCount = ri.token_count ?? 0;
          const dedupKey = `fc:${callId}`;

          // Check if we've already seen this function_call
          const existing = messageVersions.get(dedupKey);
          if (existing) {
            if (existing.tokenCount >= tokenCount) {
              warnings.push(
                `Line ${lineNum}: Duplicate function_call with same/lower token_count — keeping previous`
              );
              continue;
            }
            // Higher token_count: remove old tool call, will be replaced
            const oldIdx = toolCallMap.get(callId);
            if (oldIdx) {
              toolCallMap.delete(callId);
              toolCallOrdinalMap.delete(callId);
            }
          }

          const toolCall: TraceToolCall = {
            type: 'tool_call',
            id: callId,
            name,
            category: inferToolCategory(name),
            inputJson,
            resultEvents: [],
            status: 'pending',
            messageOrdinal: ordinal,
            sourceLine: lineNum,
          };

          toolCallMap.set(callId, toolCall);
          toolCallOrdinalMap.set(callId, ordinal);
          // Store in messageVersions for dedup tracking
          messageVersions.set(dedupKey, { tokenCount, message: {
            id: callId,
            ordinal,
            role: 'assistant',
            content: '',
            timestamp,
            model: currentModel || sessionModel,
            ...currentTurnMetadata(),
            isRealUserInput: false,
            sourceMetadata: createSourceMetadata(context, lineNum, sessionCwd, sessionGitBranch),
          }});
          hasToolCalls = true;
          ordinal++;
          continue;
        }

        // custom_tool_call → TraceToolCall (same pipeline as function_call)
        if (ri.type === 'custom_tool_call') {
          flushPendingUserResponseMessage();
          const callId = ri.call_id || `call-${lineNum}`;
          const name = ri.name || 'unknown';
          // Normalize arguments from either 'arguments' (string) or 'input' (object)
          const inputJson = ri.arguments
            ? ri.arguments
            : ri.input
              ? JSON.stringify(ri.input)
              : '{}';

          const tokenCount = ri.token_count ?? 0;
          const dedupKey = `ctc:${callId}`;

          const existing = messageVersions.get(dedupKey);
          if (existing) {
            if (existing.tokenCount >= tokenCount) {
              warnings.push(
                `Line ${lineNum}: Duplicate custom_tool_call with same/lower token_count — keeping previous`
              );
              continue;
            }
            toolCallMap.delete(callId);
            toolCallOrdinalMap.delete(callId);
          }

          const toolCall: TraceToolCall = {
            type: 'tool_call',
            id: callId,
            name,
            category: inferToolCategory(name),
            inputJson,
            resultEvents: [],
            status: 'pending',
            messageOrdinal: ordinal,
            sourceLine: lineNum,
          };

          toolCallMap.set(callId, toolCall);
          toolCallOrdinalMap.set(callId, ordinal);
          messageVersions.set(dedupKey, {
            tokenCount,
            message: {
              id: callId,
              ordinal,
              role: 'assistant',
              content: '',
              timestamp,
              model: currentModel || sessionModel,
              ...currentTurnMetadata(),
              isRealUserInput: false,
              sourceMetadata: createSourceMetadata(context, lineNum, sessionCwd, sessionGitBranch),
            },
          });
          hasToolCalls = true;
          ordinal++;
          continue;
        }

        // reasoning → silently skip (internal model reasoning, no canonical message)
        if (ri.type === 'reasoning') {
          continue;
        }

        // web_search_call → silently skip (tool invocation logged separately by event_msg)
        if (ri.type === 'web_search_call') {
          continue;
        }

        // Unknown response_item type
        warnings.push(
          `Line ${lineNum}: Skipping unknown response_item type: ${ri.type}`
        );
        continue;
      }

      // Handle event_msg — function_call_output → TraceToolResultEvent (D-07)
      const eventMsg = getCodexEventMsg(parsed);
      if (parsed.type === 'event_msg' && eventMsg) {
        const ev = eventMsg;

        const tokenUsage = extractCodexTokenUsage(ev);
        if (tokenUsage) {
          const snapshotKey = codexTokenEventSnapshotKey(tokenUsage, parsed.timestamp);
          if (snapshotKey) {
            if (snapshotKey !== lastTokenSnapshotKey) {
              lastTokenSnapshotKey = snapshotKey;
              const dailyUsage = tokenUsage.last
                ?? (tokenUsage.total ? subtractCodexUsage(tokenUsage.total, previousTotalTokenUsage) : undefined);

              if (tokenUsage.total) {
                tokenTotals.inputTokens = tokenUsage.total.inputTokens;
                tokenTotals.outputTokens = tokenUsage.total.outputTokens;
                tokenTotals.cacheReadTokens = tokenUsage.total.cacheReadTokens ?? 0;
                tokenTotals.cacheWriteTokens = tokenUsage.total.cacheWriteTokens ?? 0;
                tokenTotals.reasoningTokens = tokenUsage.total.reasoningTokens ?? 0;
                tokenTotals.totalTokens = getCodexUsageTotal(tokenUsage.total);
                previousTotalTokenUsage = tokenUsage.total;
              } else if (tokenUsage.last) {
                addUsageToAccumulator(tokenTotals, tokenUsage.last);
              }

              if (dailyUsage && getCodexUsageTotal(dailyUsage) > 0) {
                attachCodexTokenUsageToLatestMessage(
                  messageVersions,
                  dailyUsage,
                  currentTurnId,
                  currentTurnIndex
                );
                tokenEvents.push({
                  timestamp: parsed.timestamp,
                  usage: dailyUsage,
                  attribution: 'event',
                });
              }
            }
          }
        }

        if (ev.type === 'user_message') {
          const content = extractCodexUserEventContent(ev);
          if (content && !isCodexMetadataUserMessage(content)) {
            ensureTurn(ev.turn_id, parsed.timestamp);
            if (
              pendingUserResponseMessage &&
              normalizeCodexUserContent(pendingUserResponseMessage.message.content) === normalizeCodexUserContent(content)
            ) {
              pendingUserResponseMessage = undefined;
            }

            const sourceMetadata = createSourceMetadata(
              context,
              lineNum,
              sessionCwd,
              sessionGitBranch
            );
            const message: TraceMessage = {
              id: `${sessionId}-${ordinal}`,
              ordinal,
              role: 'user',
              content,
              timestamp: parsed.timestamp,
              model: currentModel || sessionModel,
              ...currentTurnMetadata(),
              isRealUserInput: true,
              sourceMetadata,
            };
            handleDedup(
              `event_user:${currentTurnId || ordinal}:${content}`,
              0,
              message,
              messageVersions,
              warnings,
              lineNum
            );
            ordinal++;
          }
        }

        if (ev.type === 'function_call_output' || ev.type === 'custom_tool_call_output') {
          flushPendingUserResponseMessage();
          const callId = ev.call_id;
          if (callId && toolCallMap.has(callId)) {
            const toolCall = toolCallMap.get(callId)!;
            const resultEvent: TraceToolResultEvent = {
              type: 'result_event',
              timestamp: parsed.timestamp,
              // Real Codex logs use 'output' field; synthetic fixtures may use 'content'
              content: ev.output || extractCodexMessageContent(ev.content),
              isPartial: ev.status !== 'completed',
            };
            toolCall.resultEvents.push(resultEvent);

            // Update tool call status
            if (ev.status === 'completed') {
              toolCall.status = 'success';
            }
          } else {
            // Orphan function_call_output / custom_tool_call_output
            warnings.push(
              `Line ${lineNum}: ${ev.type} for unknown call_id: ${callId}`
            );
          }
        }

        if (
          ev.type === 'collab_agent_spawn_end' &&
          typeof ev.new_thread_id === 'string' &&
          ev.new_thread_id.length > 0
        ) {
          const messageOrdinal = typeof ev.call_id === 'string'
            ? toolCallOrdinalMap.get(ev.call_id)
            : undefined;
          const subagentLink: TraceSubagentLink = {
            type: 'subagent_link',
            subagentSessionId: ev.new_thread_id,
            subagentSource: 'codex',
            relationship: 'spawned',
            ...(messageOrdinal !== undefined ? { messageOrdinal } : {}),
          };
          activities.push(subagentLink);
        }

        if (parsed.timestamp && !startedAt) {
          startedAt = parsed.timestamp;
        }
        if (parsed.timestamp) {
          endedAt = parsed.timestamp;
        }
        continue;
      }

      // Handle spawn_agent — TraceSubagentLink (D-08)
      if (parsed.type === 'spawn_agent' && parsed.spawn_agent) {
        const sa = parsed.spawn_agent;
        const subagentLink: TraceSubagentLink = {
          type: 'subagent_link',
          subagentSessionId: sa.session_id,
          subagentSource: 'codex',
          relationship:
            sa.type === 'attached' ? 'attached' : 'spawned',
        };
        activities.push(subagentLink);

        if (parsed.timestamp && !startedAt) {
          startedAt = parsed.timestamp;
        }
        if (parsed.timestamp) {
          endedAt = parsed.timestamp;
        }
        continue;
      }

      // Unknown line type
      warnings.push(
        `Line ${lineNum}: Skipping unknown type: ${parsed.type}`
      );
    } catch (err) {
      errors.push({
        line: lineNum,
        raw: line.substring(0, 200),
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  flushPendingUserResponseMessage();

  // Flush deduplicated messages
  Array.from(messageVersions.values())
    .map((entry) => entry.message)
    .sort((a, b) => a.ordinal - b.ordinal)
    .forEach((message) => {
      messages.push(message);
    });

  // Flush tool calls from registry
  toolCallMap.forEach((toolCall) => {
    activities.push(toolCall);
  });

  // Build session
  const session: TraceSession = {
    id: sessionId,
    source: 'codex',
    project: sessionCwd || context.project,
    startedAt,
    endedAt,
    status: endedAt ? 'idle' : 'active',
    rootSessionId: parentSessionId,
    parentSessionId,
    relationshipType: parentSessionId ? 'subagent' : 'root',
    sourceSessionId: sessionId,
    cwd: sessionCwd,
    gitBranch: sessionGitBranch,
    sourceVersion: '1.0',
    metrics: {
      messageCount: messages.length,
      userMessageCount: messages.filter((m) => m.role === 'user').length,
      inputTokens: tokenTotals.inputTokens,
      outputTokens: tokenTotals.outputTokens,
      cacheReadTokens: tokenTotals.cacheReadTokens,
      cacheWriteTokens: tokenTotals.cacheWriteTokens,
      reasoningTokens: tokenTotals.reasoningTokens,
      totalTokens: tokenTotals.totalTokens || tokenTotals.inputTokens + tokenTotals.outputTokens || undefined,
      hasToolCalls,
      terminationStatus: undefined,
      parserMalformedLines: errors.length,
      isTruncated: false,
    },
    turns: [], // Will be populated by turn assembler
  };

  return {
    session,
    messages,
    activities,
    tokenEvents,
    errors,
    warnings,
  };
}

export async function parseCodexSessionAppend(
  filePath: string,
  project: string,
  options: IncrementalParseOptions
): Promise<IncrementalParseDelta> {
  const context = extractCodexSessionContext(filePath, project);
  const baseDelta = () => createCodexIncrementalDelta(context, options);

  if (!fs.existsSync(filePath)) {
    const delta = baseDelta();
    delta.requiresFullReparse = true;
    delta.fallbackReason = 'file_missing';
    delta.errors.push({ line: 0, raw: filePath, error: 'File does not exist' });
    return delta;
  }

  let range: JsonlRangeRead;
  try {
    range = readCompleteJsonlRange(filePath, options.startOffset, options.endOffset, options.startLine);
  } catch (err) {
    const delta = baseDelta();
    delta.requiresFullReparse = true;
    delta.fallbackReason = 'range_read_failed';
    delta.errors.push({
      line: options.startLine,
      raw: filePath,
      error: err instanceof Error ? err.message : 'Failed to read JSONL range',
    });
    return delta;
  }

  const delta = baseDelta();
  const knownToolCallIds = new Set(options.knownToolCallIds ?? []);
  const localToolCallMap = new Map<string, TraceToolCall>();
  const toolCallOrdinalMap = new Map<string, number>();
  const messageVersions = new Map<string, { tokenCount: number; message: TraceMessage }>();
  let pendingUserResponseMessage: PendingCodexUserMessage | undefined;
  let ordinal = options.startOrdinal;
  let currentTurnIndex = options.startTurnIndex;
  let currentTurnId = options.currentTurnId;
  let currentModel = options.currentModel;
  let sessionCwd: string | undefined;
  let sessionGitBranch: string | undefined;
  let sessionModel: string | undefined;
  let sessionId = options.sessionId || context.uuid;
  let lastTokenSnapshotKey = options.codexPreviousTotalUsage
    ? `total:${codexUsageSnapshotKey(options.codexPreviousTotalUsage)}`
    : undefined;

  const markFallback = (reason: string, lineNumber: number, raw: string): IncrementalParseDelta => {
    delta.requiresFullReparse = true;
    delta.fallbackReason = reason;
    delta.errors.push({ line: lineNumber, raw: raw.substring(0, 200), error: reason });
    return delta;
  };

  const ensureTurn = (turnId?: string, startedAtForTurn?: string | null): void => {
    if (!turnId && currentTurnId) {
      return;
    }
    const nextTurnId = turnId || `turn-${currentTurnIndex + 1}`;
    if (currentTurnId !== nextTurnId) {
      currentTurnId = nextTurnId;
      currentTurnIndex++;
    }
    if (startedAtForTurn) {
      delta.sessionPatch.startedAt = delta.sessionPatch.startedAt || startedAtForTurn;
    }
  };

  const currentTurnMetadata = () => ({
    turnId: currentTurnId,
    turnIndex: currentTurnIndex >= 0 ? currentTurnIndex : undefined,
  });

  const flushPendingUserResponseMessage = (): void => {
    if (!pendingUserResponseMessage) return;
    handleDedup(
      pendingUserResponseMessage.dedupKey,
      pendingUserResponseMessage.tokenCount,
      pendingUserResponseMessage.message,
      messageVersions,
      delta.warnings,
      pendingUserResponseMessage.lineNum
    );
    pendingUserResponseMessage = undefined;
  };

  const addToolResultEvent = (
    callId: string | undefined,
    event: TraceToolResultEvent,
    lineNumber: number,
    raw: string
  ): IncrementalParseDelta | undefined => {
    if (!callId) {
      return markFallback('missing_tool_result_id', lineNumber, raw);
    }

    const localToolCall = localToolCallMap.get(callId);
    if (localToolCall) {
      localToolCall.resultEvents.push(event);
      if (!event.isPartial) localToolCall.status = 'success';
      return undefined;
    }

    if (knownToolCallIds.has(callId)) {
      delta.toolResultEvents.push({ toolId: callId, event });
      return undefined;
    }

    return markFallback('missing_tool_context', lineNumber, raw);
  };

  for (const record of range.lines) {
    const line = record.line;
    if (!line.trim()) continue;

    try {
      const parsed: CodexJsonlLine = JSON.parse(line);

      if (parsed.timestamp) {
        delta.sessionPatch.endedAt = parsed.timestamp;
        delta.sessionPatch.status = 'idle';
      }

      const eventMsgBeforeResponse = getCodexEventMsg(parsed);
      if (parsed.type === 'event_msg' && eventMsgBeforeResponse?.type === 'task_started') {
        ensureTurn(
          eventMsgBeforeResponse.turn_id || eventMsgBeforeResponse.id,
          parsed.timestamp
        );
      }

      const sessionMeta = getCodexSessionMeta(parsed);
      if (parsed.type === 'session_meta' && sessionMeta) {
        if (sessionMeta.session_id) {
          if (options.startOffset > 0 && options.sessionId && sessionMeta.session_id !== options.sessionId) {
            return markFallback('session_identity_changed', record.lineNumber, line);
          }
          sessionId = sessionMeta.session_id;
          delta.sessionId = sessionMeta.session_id;
          delta.sessionPatch.id = sessionMeta.session_id;
          delta.sessionPatch.sourceSessionId = sessionMeta.session_id;
        }
        if (sessionMeta.parentSessionId) {
          delta.sessionPatch.parentSessionId = sessionMeta.parentSessionId;
          delta.sessionPatch.rootSessionId = sessionMeta.parentSessionId;
          delta.sessionPatch.relationshipType = 'subagent';
        }
        if (sessionMeta.cwd) {
          sessionCwd = sessionMeta.cwd;
          delta.sessionPatch.cwd = sessionMeta.cwd;
          delta.sessionPatch.project = sessionMeta.cwd;
        }
        if (sessionMeta.git_branch) {
          sessionGitBranch = sessionMeta.git_branch;
          delta.sessionPatch.gitBranch = sessionMeta.git_branch;
        }
        if (sessionMeta.model) {
          sessionModel = sessionMeta.model;
        }
        continue;
      }

      const turnContext = getCodexTurnContext(parsed);
      if (parsed.type === 'turn_context' && turnContext) {
        const turnStartedAt = turnContext.started_at || parsed.timestamp;
        currentModel = turnContext.model || currentModel;
        sessionCwd = turnContext.cwd || sessionCwd;
        sessionGitBranch = turnContext.git_branch || sessionGitBranch;
        delta.sessionPatch.cwd = sessionCwd || delta.sessionPatch.cwd;
        if (turnContext.cwd) {
          delta.sessionPatch.project = turnContext.cwd;
        }
        delta.sessionPatch.gitBranch = sessionGitBranch || delta.sessionPatch.gitBranch;
        if (!currentTurnId) {
          ensureTurn(turnContext.turn_id || `turn-${record.lineNumber}`, turnStartedAt);
        } else if (turnContext.turn_id && currentTurnId !== turnContext.turn_id) {
          currentTurnId = turnContext.turn_id;
          currentTurnIndex++;
        }
        continue;
      }

      const responseItem = getCodexResponseItem(parsed);
      if (parsed.type === 'response_item' && responseItem) {
        const ri = responseItem;
        const timestamp = parsed.timestamp;

        if (ri.type === 'input_text') {
          ensureTurn(undefined, timestamp || null);
          const content = ri.input_text || '';
          const tokenCount = ri.token_count ?? 0;
          const message: TraceMessage = {
            id: `${sessionId}-${ordinal}`,
            ordinal,
            role: 'user',
            content,
            timestamp,
            model: currentModel || sessionModel,
            ...currentTurnMetadata(),
            isRealUserInput: true,
            sourceMetadata: createSourceMetadata(context, record.lineNumber, sessionCwd, sessionGitBranch),
          };
          handleDedup(`text:${content}`, tokenCount, message, messageVersions, delta.warnings, record.lineNumber);
          ordinal++;
          continue;
        }

        if (ri.type === 'message') {
          const content = extractCodexMessageContent(ri.content);
          const role = mapCodexRole(ri.role);
          if (!content || !role) {
            delta.warnings.push(`Line ${record.lineNumber}: Skipping message payload without role/content`);
            continue;
          }
          if (role === 'user') {
            if (isCodexMetadataUserMessage(content)) {
              continue;
            }
            ensureTurn(undefined, timestamp || null);
          } else if (!currentTurnId && currentTurnIndex >= 0) {
            return markFallback('missing_turn_context', record.lineNumber, line);
          }

          const tokenCount = ri.token_count ?? 0;
          const message: TraceMessage = {
            id: `${sessionId}-${ordinal}`,
            ordinal,
            role,
            content,
            timestamp,
            model: currentModel || sessionModel,
            ...currentTurnMetadata(),
            isRealUserInput: role === 'user' && !isCodexMetadataUserMessage(content),
            sourceMetadata: createSourceMetadata(context, record.lineNumber, sessionCwd, sessionGitBranch),
          };
          if (role === 'user') {
            pendingUserResponseMessage = {
              dedupKey: `message:${role}:${content}`,
              tokenCount,
              message,
              lineNum: record.lineNumber,
            };
          } else {
            flushPendingUserResponseMessage();
            handleDedup(
              `message:${role}:${content}`,
              tokenCount,
              message,
              messageVersions,
              delta.warnings,
              record.lineNumber
            );
          }
          ordinal++;
          continue;
        }

        if (ri.type === 'text' || ri.type === 'output_text') {
          if (!currentTurnId && currentTurnIndex >= 0) {
            return markFallback('missing_turn_context', record.lineNumber, line);
          }
          flushPendingUserResponseMessage();
          const content = ri.text || ri.output_text || '';
          const tokenCount = ri.token_count ?? 0;
          const message: TraceMessage = {
            id: `${sessionId}-${ordinal}`,
            ordinal,
            role: 'assistant',
            content,
            timestamp,
            model: currentModel || sessionModel,
            ...currentTurnMetadata(),
            isRealUserInput: false,
            sourceMetadata: createSourceMetadata(context, record.lineNumber, sessionCwd, sessionGitBranch),
          };
          handleDedup(`text:${content}`, tokenCount, message, messageVersions, delta.warnings, record.lineNumber);
          ordinal++;
          continue;
        }

        if (ri.type === 'function_call_output') {
          flushPendingUserResponseMessage();
          const maybeFallback = addToolResultEvent(
            ri.call_id,
            {
              type: 'result_event',
              timestamp,
              content: ri.output || extractCodexMessageContent(ri.content),
              isPartial: ri.status !== 'completed',
            },
            record.lineNumber,
            line
          );
          if (maybeFallback) return maybeFallback;
          continue;
        }

        if (ri.type === 'function_call' || ri.type === 'custom_tool_call') {
          if (!currentTurnId && currentTurnIndex >= 0) {
            return markFallback('missing_turn_context', record.lineNumber, line);
          }
          flushPendingUserResponseMessage();
          const callId = ri.call_id || `call-${record.lineNumber}`;
          const name = ri.name || 'unknown';
          const inputJson = ri.arguments
            ? ri.arguments
            : ri.input
              ? JSON.stringify(ri.input)
              : '{}';
          const tokenCount = ri.token_count ?? 0;
          const dedupKey = ri.type === 'custom_tool_call' ? `ctc:${callId}` : `fc:${callId}`;

          const existingVersion = messageVersions.get(dedupKey);
          if (existingVersion && existingVersion.tokenCount >= tokenCount) {
            delta.warnings.push(
              `Line ${record.lineNumber}: Duplicate ${ri.type} with same/lower token_count — keeping previous`
            );
            continue;
          }

          const toolCall: TraceToolCall = {
            type: 'tool_call',
            id: callId,
            name,
            category: inferToolCategory(name),
            inputJson,
            resultEvents: [],
            status: 'pending',
            messageOrdinal: ordinal,
            sourceLine: record.lineNumber,
          };
          localToolCallMap.set(callId, toolCall);
          toolCallOrdinalMap.set(callId, ordinal);
          delta.toolCalls.push(toolCall);

          messageVersions.set(dedupKey, {
            tokenCount,
            message: {
              id: callId,
              ordinal,
              role: 'assistant',
              content: '',
              timestamp,
              model: currentModel || sessionModel,
              ...currentTurnMetadata(),
              isRealUserInput: false,
              sourceMetadata: createSourceMetadata(context, record.lineNumber, sessionCwd, sessionGitBranch),
            },
          });
          ordinal++;
          continue;
        }

        if (ri.type === 'reasoning' || ri.type === 'web_search_call') {
          continue;
        }

        delta.warnings.push(`Line ${record.lineNumber}: Skipping unknown response_item type: ${ri.type}`);
        continue;
      }

      const eventMsg = getCodexEventMsg(parsed);
      if (parsed.type === 'event_msg' && eventMsg) {
        const ev = eventMsg;

        const tokenUsage = extractCodexTokenUsage(ev);
        if (tokenUsage) {
          if (tokenUsage.total && !tokenUsage.last) {
            return markFallback('token_count_total_without_last_usage', record.lineNumber, line);
          }

          const snapshotKey = codexTokenEventSnapshotKey(tokenUsage, parsed.timestamp);
          if (snapshotKey) {
            if (snapshotKey !== lastTokenSnapshotKey) {
              lastTokenSnapshotKey = snapshotKey;
              const deltaUsage = tokenUsage.last;
              addUsageToDelta(delta, deltaUsage);
              if (deltaUsage && getCodexUsageTotal(deltaUsage) > 0) {
                attachCodexTokenUsageToLatestMessage(
                  messageVersions,
                  deltaUsage,
                  currentTurnId,
                  currentTurnIndex
                );
                delta.tokenEvents?.push({
                  timestamp: parsed.timestamp,
                  usage: deltaUsage,
                  attribution: 'event',
                });
              }
            }
          }
        }

        if (ev.type === 'user_message') {
          const content = extractCodexUserEventContent(ev);
          if (content && !isCodexMetadataUserMessage(content)) {
            ensureTurn(ev.turn_id, parsed.timestamp);
            if (
              pendingUserResponseMessage &&
              normalizeCodexUserContent(pendingUserResponseMessage.message.content) === normalizeCodexUserContent(content)
            ) {
              pendingUserResponseMessage = undefined;
            }
            const message: TraceMessage = {
              id: `${sessionId}-${ordinal}`,
              ordinal,
              role: 'user',
              content,
              timestamp: parsed.timestamp,
              model: currentModel || sessionModel,
              ...currentTurnMetadata(),
              isRealUserInput: true,
              sourceMetadata: createSourceMetadata(context, record.lineNumber, sessionCwd, sessionGitBranch),
            };
            handleDedup(
              `event_user:${currentTurnId || ordinal}:${content}`,
              0,
              message,
              messageVersions,
              delta.warnings,
              record.lineNumber
            );
            ordinal++;
          }
        }

        if (ev.type === 'function_call_output' || ev.type === 'custom_tool_call_output') {
          flushPendingUserResponseMessage();
          const maybeFallback = addToolResultEvent(
            ev.call_id,
            {
              type: 'result_event',
              timestamp: parsed.timestamp,
              content: ev.output || extractCodexMessageContent(ev.content),
              isPartial: ev.status !== 'completed',
            },
            record.lineNumber,
            line
          );
          if (maybeFallback) return maybeFallback;
        }

        if (
          ev.type === 'collab_agent_spawn_end' &&
          typeof ev.new_thread_id === 'string' &&
          ev.new_thread_id.length > 0
        ) {
          const messageOrdinal = typeof ev.call_id === 'string'
            ? toolCallOrdinalMap.get(ev.call_id)
            : undefined;
          delta.subagentLinks.push({
            type: 'subagent_link',
            subagentSessionId: ev.new_thread_id,
            subagentSource: 'codex',
            relationship: 'spawned',
            ...(messageOrdinal !== undefined ? { messageOrdinal } : {}),
          });
        }
        continue;
      }

      if (parsed.type === 'spawn_agent' && parsed.spawn_agent) {
        delta.subagentLinks.push({
          type: 'subagent_link',
          subagentSessionId: parsed.spawn_agent.session_id,
          subagentSource: 'codex',
          relationship: parsed.spawn_agent.type === 'attached' ? 'attached' : 'spawned',
        });
        continue;
      }

      delta.warnings.push(`Line ${record.lineNumber}: Skipping unknown type: ${parsed.type}`);
    } catch (err) {
      delta.errors.push({
        line: record.lineNumber,
        raw: line.substring(0, 200),
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  flushPendingUserResponseMessage();
  Array.from(messageVersions.values())
    .map((entry) => entry.message)
    .sort((a, b) => a.ordinal - b.ordinal)
    .forEach((message) => {
      delta.messages.push(message);
    });

  finalizeCodexDelta(delta, range, ordinal, currentTurnIndex);
  return delta;
}

function createCodexIncrementalDelta(
  context: SessionContext,
  options: IncrementalParseOptions
): IncrementalParseDelta {
  return {
    sessionId: options.sessionId || context.uuid,
    sourceType: 'codex',
    messages: [],
    toolCalls: [],
    toolResultEvents: [],
    subagentLinks: [],
    tokenEvents: [],
    sessionPatch: {
      id: options.sessionId || context.uuid,
      source: 'codex',
      sourceSessionId: options.sessionId || context.uuid,
      sourceVersion: '1.0',
    },
    metricsDelta: {
      messageCount: 0,
      userMessageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalReasoningTokens: 0,
      totalTokens: 0,
      hasToolCalls: false,
      parserMalformedLines: 0,
    },
    cursorUpdate: {
      lastIndexedOffset: options.startOffset,
      lastIndexedLine: options.startLine,
      lastMessageOrdinal: options.startOrdinal - 1,
      lastTurnIndex: options.startTurnIndex,
    },
    errors: [],
    warnings: [],
  };
}

function finalizeCodexDelta(
  delta: IncrementalParseDelta,
  range: JsonlRangeRead,
  nextOrdinal: number,
  currentTurnIndex: number
): void {
  delta.metricsDelta.messageCount = delta.messages.length;
  delta.metricsDelta.userMessageCount = delta.messages.filter((message) => message.role === 'user').length;
  delta.metricsDelta.hasToolCalls = delta.toolCalls.length > 0;
  delta.metricsDelta.parserMalformedLines = delta.errors.length;
  delta.cursorUpdate = {
    lastIndexedOffset: range.cursorOffset,
    lastIndexedLine: range.cursorLine,
    lastMessageOrdinal: nextOrdinal - 1,
    lastTurnIndex: currentTurnIndex,
  };
}

function readCompleteJsonlRange(
  filePath: string,
  startOffset: number,
  endOffset: number,
  startLine: number
): JsonlRangeRead {
  if (startOffset < 0 || endOffset < startOffset) {
    throw new Error(`Invalid JSONL range: ${startOffset}..${endOffset}`);
  }

  const length = endOffset - startOffset;
  if (length === 0) {
    return { lines: [], cursorOffset: startOffset, cursorLine: startLine };
  }

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const read = fs.readSync(fd, buffer, bytesRead, length - bytesRead, startOffset + bytesRead);
      if (read <= 0) break;
      bytesRead += read;
    }
  } finally {
    fs.closeSync(fd);
  }

  let completeLength = bytesRead;
  if (completeLength > 0 && buffer[completeLength - 1] !== 10) {
    completeLength = buffer.subarray(0, completeLength).lastIndexOf(10) + 1;
  }

  if (completeLength <= 0) {
    return { lines: [], cursorOffset: startOffset, cursorLine: startLine };
  }

  const text = buffer.subarray(0, completeLength).toString('utf8');
  const rawLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const lines = rawLines.map((rawLine, index) => ({
    line: rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine,
    lineNumber: startLine + index + 1,
  }));

  return {
    lines,
    cursorOffset: startOffset + completeLength,
    cursorLine: startLine + rawLines.length,
  };
}

// ============================================================================
// Session Context Extraction
// ============================================================================

/**
 * Extract session context from file path
 *
 * Path format: .../codex/sessions/{session_id}.jsonl
 *
 * @param filePath - Full path to session file
 * @param project - Project name
 * @returns SessionContext with extracted metadata
 */
function extractCodexSessionContext(
  filePath: string,
  project: string
): SessionContext {
  // Try to match Codex session path pattern: .../codex/sessions/{uuid}.jsonl
  const match = filePath.match(
    /\/codex\/sessions\/([^/]+)\.jsonl/
  );
  if (match) {
    return {
      sessionKey: `codex:${match[1]}`,
      uuid: match[1],
      project,
      filePath,
      fileMtime: fs.existsSync(filePath)
        ? fs.statSync(filePath).mtimeMs
        : Date.now(),
    };
  }

  // Fallback: extract UUID from filename
  const uuidMatch = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  const uuid = uuidMatch
    ? uuidMatch[1]
    : path.basename(filePath, '.jsonl');

  return {
    sessionKey: uuid,
    uuid,
    project,
    filePath,
    fileMtime: fs.existsSync(filePath)
      ? fs.statSync(filePath).mtimeMs
      : Date.now(),
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create an empty session for error cases
 */
function createEmptySession(context: SessionContext): TraceSession {
  return {
    id: context.uuid,
    source: 'codex',
    project: context.project,
    startedAt: null,
    endedAt: null,
    status: 'error',
    rootSessionId: undefined,
    parentSessionId: undefined,
    relationshipType: undefined,
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

/**
 * Create source metadata for trace messages
 */
function createSourceMetadata(
  context: SessionContext,
  lineNum: number,
  cwd?: string,
  gitBranch?: string
): SourceMetadata {
  return {
    sourceType: 'codex',
    sourceFile: context.filePath,
    sourceLine: lineNum,
    sourceVersion: '1.0',
    cwd,
    gitBranch,
  };
}

/**
 * Handle token_count-based deduplication (D-09)
 *
 * For streaming messages where the same logical message appears multiple
 * times with increasing token_count, keep only the version with the
 * highest token_count.
 *
 * @param key - Dedup key (call_id for function_calls, text:content for messages)
 * @param tokenCount - Token count of this version
 * @param message - The TraceMessage to potentially store
 * @param messageVersions - Accumulator map
 * @param warnings - Warnings array
 * @param lineNum - Current line number
 */
function handleDedup(
  key: string,
  tokenCount: number,
  message: TraceMessage,
  messageVersions: Map<string, { tokenCount: number; message: TraceMessage }>,
  warnings: string[],
  lineNum: number
): void {
  const existing = messageVersions.get(key);
  if (existing) {
    if (existing.tokenCount >= tokenCount) {
      warnings.push(
        `Line ${lineNum}: Duplicate response_item with same/lower token_count — keeping previous`
      );
      return;
    }
    // Higher token_count replaces previous
  }
  messageVersions.set(key, { tokenCount, message });
}

/**
 * Infer tool category from tool name
 *
 * @param name - Tool name from Codex function_call
 * @returns ToolCategory for UI grouping
 */
function inferToolCategory(name: string): ToolCategory {
  const lower = name.toLowerCase();
  if (lower.includes('bash') || lower.includes('shell')) return 'Bash';
  if (
    lower === 'apply_patch' ||
    lower === 'patch' ||
    lower.includes('apply_patch') ||
    lower.includes('file_edit') ||
    lower.includes('patch')
  ) {
    return 'Edit';
  }
  if (lower.includes('edit')) return 'Edit';
  if (lower.includes('read')) return 'Read';
  if (lower.includes('grep') || lower.includes('search')) return 'Grep';
  if (lower.includes('task')) return 'Task';
  if (lower.includes('agent')) return 'Agent';
  return 'Other';
}

// ============================================================================
// Single-Line Parser Helper — parseCodexMessage
// ============================================================================

/**
 * Parse a single Codex message line
 *
 * Helper function for testing. Only processes response_item lines
 * with input_text or text types; function_call, session_meta,
 * turn_context, event_msg, and spawn_agent lines return null.
 *
 * @param line - JSONL line string
 * @param context - Session context
 * @returns TraceMessage or null if not a suitable response_item or parsing fails
 */
export function parseCodexMessage(
  line: string,
  context: SessionContext
): TraceMessage | null {
  try {
    const parsed: CodexJsonlLine = JSON.parse(line);

    const responseItem = getCodexResponseItem(parsed);
    if (parsed.type !== 'response_item' || !responseItem) {
      return null;
    }

    const ri = responseItem;

    // Only process text-based response_items (not function_call)
    if (ri.type === 'function_call') return null;

    let role: MessageRole | null;
    let content: string;

    if (ri.type === 'input_text') {
      role = 'user';
      content = ri.input_text || '';
    } else if (ri.type === 'text' || ri.type === 'output_text') {
      role = 'assistant';
      content = ri.text || ri.output_text || '';
    } else if (ri.type === 'message') {
      role = mapCodexRole(ri.role);
      content = extractCodexMessageContent(ri.content);
    } else {
      return null;
    }

    if (!role || !content) return null;

    return {
      id: `${context.uuid}-0`,
      ordinal: 0,
      role,
      content,
      timestamp: parsed.timestamp,
      sourceMetadata: {
        sourceType: 'codex',
        sourceFile: context.filePath,
        sourceLine: 0,
        sourceVersion: '1.0',
      },
    };
  } catch {
    return null;
  }
}
