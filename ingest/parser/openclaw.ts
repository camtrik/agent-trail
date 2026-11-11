/**
 * OpenClaw JSONL Parser
 *
 * Parses OpenClaw session files from JSONL format into canonical trace model.
 * Handles streaming line-by-line parsing, session context extraction, and tool call discovery.
 *
 * @module ingest/parser/openclaw
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import {
  TraceSession,
  TraceMessage,
  TraceToolCall,
  TraceActivity,
  ToolCategory,
  MessageRole,
  SourceMetadata,
  TokenUsage,
} from '@/types/trace';
import {
  OpenClawJsonlLine,
  OpenClawMessage,
  ContentBlock,
  ParseResult,
  ParseError,
  SessionContext,
} from './types';

const OPENCLAW_ROLE_ALIASES: Record<string, MessageRole> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  tool_result: 'tool_result',
  toolResult: 'tool_result',
};

interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/**
 * Parse an OpenClaw session file and return structured trace data
 *
 * @param filePath - Full path to the JSONL session file
 * @param project - Project name for session metadata
 * @returns ParseResult with session, messages, activities, errors, and warnings
 */
export async function parseOpenClawSession(
  filePath: string,
  project: string
): Promise<ParseResult> {
  const context = extractSessionContext(filePath, project);
  const fileStream = fs.createReadStream(filePath);
  const lines = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  try {
    return await parseOpenClawRecords(lines, context);
  } finally {
    lines.close();
    fileStream.destroy();
  }
}

/** Map exported JSONL or selected SQLite transcript payloads without writing private temp files. */
export async function parseOpenClawRecords(
  lines: AsyncIterable<string> | Iterable<string>,
  context: SessionContext,
): Promise<ParseResult> {
  const errors: ParseError[] = [];
  const warnings: string[] = [];
  const messages: TraceMessage[] = [];
  const activities: TraceActivity[] = [];

  let ordinal = 0;
  let lineNum = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  const tokenTotals = createTokenAccumulator();
  let sourceCostUsd: number | null = null;
  let hasToolCalls = false;

  for await (const line of lines) {
    lineNum++;
    if (!line.trim()) continue;

    try {
      const parsed: OpenClawJsonlLine = JSON.parse(line);

      if (parsed.type !== 'message') {
        warnings.push(`Line ${lineNum}: Skipping non-message type: ${parsed.type}`);
        continue;
      }

      if (!parsed.message) {
        errors.push({ line: lineNum, raw: line.substring(0, 200), error: 'Missing message field' });
        continue;
      }

      // Extract timestamp
      if (parsed.timestamp && !startedAt) {
        startedAt = parsed.timestamp;
      }
      if (parsed.timestamp) {
        endedAt = parsed.timestamp;
      }

      const role = normalizeOpenClawRole(parsed.message.role);
      if (!role) {
        errors.push({
          line: lineNum,
          raw: line.substring(0, 200),
          error: `Unsupported message role: ${String(parsed.message.role)}`,
        });
        continue;
      }

      // Parse message
      const message = parseMessage(parsed.message, ordinal, context, lineNum, role, parsed.timestamp);
      messages.push(message);

      // Extract tool calls from assistant messages
      if (message.role === 'assistant') {
        const toolCalls = extractToolCalls(parsed.message, context, lineNum);
        activities.push(...toolCalls);
        if (toolCalls.length > 0) hasToolCalls = true;
      }

      addTokenUsage(tokenTotals, message.tokenUsage);
      sourceCostUsd = addSourceCost(sourceCostUsd, parsed.message.usage);

      ordinal++;
    } catch (err) {
      errors.push({
        line: lineNum,
        raw: line.substring(0, 200),
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Build session
  const session: TraceSession = {
    id: context.uuid,
    source: 'openclaw',
    project: context.project,
    startedAt,
    endedAt,
    status: endedAt ? 'idle' : 'active',
    rootSessionId: undefined,
    parentSessionId: undefined,
    relationshipType: undefined,
    metrics: {
      messageCount: messages.length,
      userMessageCount: messages.filter((m) => m.role === 'user').length,
      inputTokens: tokenTotals.inputTokens,
      outputTokens: tokenTotals.outputTokens,
      cacheReadTokens: tokenTotals.cacheReadTokens,
      cacheWriteTokens: tokenTotals.cacheWriteTokens,
      reasoningTokens: tokenTotals.reasoningTokens,
      totalTokens: tokenTotals.totalTokens,
      hasToolCalls,
      terminationStatus: undefined,
      parserMalformedLines: errors.length,
      isTruncated: false,
    },
    sourceCostUsd,
    costSource: sourceCostUsd == null ? null : 'source-reported',
    costPricingStatus: sourceCostUsd == null ? null : 'priced',
    turns: [], // Will be populated by turn assembler in Plan 02-03
  };

  return {
    session,
    messages,
    activities,
    errors,
    warnings,
  };
}

/**
 * Extract session context from file path
 *
 * Path format: .../agents/{agentName}/sessions/{uuid}.jsonl
 *
 * @param filePath - Full path to session file
 * @param project - Project name
 * @returns SessionContext with extracted metadata
 */
function extractSessionContext(filePath: string, project: string): SessionContext {
  // Try to match agent session path pattern
  const match = filePath.match(/\/agents\/([^/]+)\/sessions\/([^/]+)\.jsonl/);
  if (match) {
    return {
      sessionKey: `agent:${match[1]}:${match[2]}`,
      agentName: match[1],
      uuid: match[2],
      project,
      filePath,
      fileMtime: fs.statSync(filePath).mtimeMs,
    };
  }

  // Fallback: extract UUID from filename
  const uuidMatch = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  const uuid = uuidMatch ? uuidMatch[1] : path.basename(filePath, '.jsonl');

  return {
    sessionKey: uuid,
    uuid,
    project,
    filePath,
    fileMtime: fs.statSync(filePath).mtimeMs,
  };
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

function addTokenUsage(accumulator: TokenAccumulator, usage?: TokenUsage): void {
  if (!usage) return;

  accumulator.inputTokens += usage.inputTokens;
  accumulator.outputTokens += usage.outputTokens;
  accumulator.cacheReadTokens += usage.cacheReadTokens ?? 0;
  accumulator.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  accumulator.reasoningTokens += usage.reasoningTokens ?? 0;
  accumulator.totalTokens += usage.totalTokens
    ?? usage.inputTokens
      + usage.outputTokens
      + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0)
      + (usage.reasoningTokens ?? 0);
}

function coerceNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function readNumberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = coerceNonNegativeNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeOpenClawTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;

  const record = usage as Record<string, unknown>;
  const inputTokens = readNumberField(record, 'input', 'input_tokens');
  const outputTokens = readNumberField(record, 'output', 'output_tokens');
  const cacheReadTokens = readNumberField(
    record,
    'cacheRead',
    'cache_read',
    'cache_read_tokens',
    'cache_read_input_tokens'
  );
  const cacheWriteTokens = readNumberField(
    record,
    'cacheWrite',
    'cache_write',
    'cache_write_tokens',
    'cache_creation_input_tokens'
  );
  const reasoningTokens = readNumberField(record, 'reasoning', 'reasoningTokens', 'reasoning_tokens');
  const totalTokens = readNumberField(record, 'totalTokens', 'total_tokens', 'total');

  const hasTokenFields = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  ].some((value) => value !== undefined);

  if (!hasTokenFields) return undefined;

  const normalizedInput = inputTokens ?? 0;
  const normalizedOutput = outputTokens ?? 0;
  const normalizedCacheRead = cacheReadTokens ?? 0;
  const normalizedCacheWrite = cacheWriteTokens ?? 0;
  const normalizedReasoning = reasoningTokens ?? 0;

  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    cacheReadTokens: normalizedCacheRead,
    cacheWriteTokens: normalizedCacheWrite,
    reasoningTokens: normalizedReasoning,
    totalTokens: totalTokens
      ?? normalizedInput + normalizedOutput + normalizedCacheRead + normalizedCacheWrite + normalizedReasoning,
    usageSemantics: 'additive',
  };
}

function readOpenClawCostUsd(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const cost = (usage as Record<string, unknown>).cost;
  if (typeof cost === 'number') {
    return coerceNonNegativeNumber(cost) ?? null;
  }
  if (!cost || typeof cost !== 'object' || Array.isArray(cost)) return null;
  return readNumberField(cost as Record<string, unknown>, 'total', 'usd', 'costUsd', 'cost_usd') ?? null;
}

function addSourceCost(current: number | null, usage: unknown): number | null {
  const costUsd = readOpenClawCostUsd(usage);
  if (costUsd == null) return current;
  return (current ?? 0) + costUsd;
}

function normalizeOpenClawTimestamp(timestamp: unknown, fallback?: string): string | undefined {
  if (typeof timestamp === 'string') {
    const trimmed = timestamp.trim();
    return trimmed || fallback;
  }

  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const epochMs = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
    const date = new Date(epochMs);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  return fallback;
}

/**
 * Parse a single OpenClaw message
 *
 * @param msg - Raw OpenClaw message object
 * @param ordinal - Message ordinal position
 * @param context - Session context
 * @param lineNum - Line number for source metadata
 * @returns TraceMessage in canonical format
 */
function parseMessage(
  msg: OpenClawMessage,
  ordinal: number,
  context: SessionContext,
  lineNum: number,
  role: MessageRole,
  fallbackTimestamp?: string
): TraceMessage {
  // Extract content from message
  let content = '';
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content.filter((block: ContentBlock) => block.type === 'text')
      .map((block) => block.text || '').join('\n');
  }

  const sourceMetadata: SourceMetadata = {
    sourceType: 'openclaw',
    sourceFile: context.filePath,
    sourceLine: lineNum,
    sourceVersion: '1.0', // OpenClaw log version
  };

  return {
    id: `${context.uuid}-${ordinal}`,
    ordinal,
    role,
    content,
    timestamp: normalizeOpenClawTimestamp(msg.timestamp, fallbackTimestamp),
    model: msg.model,
    tokenUsage: normalizeOpenClawTokenUsage(msg.usage),
    sourceMetadata,
  };
}

function normalizeOpenClawRole(role: unknown): MessageRole | null {
  if (typeof role !== 'string') return null;
  return OPENCLAW_ROLE_ALIASES[role] ?? null;
}

/**
 * Extract tool calls from assistant message content blocks
 *
 * @param msg - OpenClaw message object
 * @param context - Session context
 * @param lineNum - Line number for ID generation
 * @returns Array of TraceToolCall activities
 */
function extractToolCalls(msg: OpenClawMessage, context: SessionContext, lineNum: number): TraceToolCall[] {
  const toolCalls: TraceToolCall[] = [];

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' || block.type === 'toolCall') {
        const name = block.name || block.toolName || 'unknown';
        const category = inferToolCategory(name);

        toolCalls.push({
          type: 'tool_call',
          id: block.id || `${context.uuid}-${lineNum}-${toolCalls.length}`,
          name,
          category,
          inputJson: JSON.stringify(block.input ?? block.arguments ?? {}),
          resultEvents: [], // Tool results come from tool_result messages
          status: 'pending', // Will be updated when tool_result is parsed
        });
      }
    }
  }

  return toolCalls;
}

/**
 * Infer tool category from tool name
 *
 * @param name - Tool name
 * @returns ToolCategory for UI grouping
 */
function inferToolCategory(name: string): ToolCategory {
  const lower = name.toLowerCase();
  if (lower.includes('bash') || lower.includes('shell')) return 'Bash';
  if (lower.includes('edit')) return 'Edit';
  if (lower.includes('read')) return 'Read';
  if (lower.includes('grep') || lower.includes('search')) return 'Grep';
  if (lower.includes('task')) return 'Task';
  if (lower.includes('agent')) return 'Agent';
  return 'Other';
}

/**
 * Parse a single OpenClaw message line
 *
 * Helper function for testing and single-line parsing scenarios
 *
 * @param line - JSONL line string
 * @param context - Session context
 * @returns TraceMessage or null if parsing fails
 */
export function parseOpenClawMessage(
  line: string,
  context: SessionContext
): TraceMessage | null {
  try {
    const parsed: OpenClawJsonlLine = JSON.parse(line);
    if (parsed.type !== 'message' || !parsed.message) return null;
    const role = normalizeOpenClawRole(parsed.message.role);
    if (!role) return null;
    return parseMessage(parsed.message, 0, context, 0, role, parsed.timestamp);
  } catch {
    return null;
  }
}
