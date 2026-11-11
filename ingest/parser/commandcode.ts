/** Command Code v3 persisted transcripts. Runtime background-agent IDs are not session IDs. */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { TraceActivity, TraceMessage, TraceToolCall, TokenUsage, ToolCategory } from '@/types/trace';
import type { ParseResult } from './types';

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  const block = object(value);
  if (block.type === 'image') return '[image]';
  return typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : '';
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function usage(value: unknown): TokenUsage | undefined {
  const raw = object(value);
  if (!Object.keys(raw).some(k => k.endsWith('Tokens') && number(raw[k]) !== undefined)) return;
  const inputTokens = number(raw.inputTokens) ?? 0;
  const outputTokens = number(raw.outputTokens) ?? 0;
  const cacheReadTokens = number(raw.cacheReadTokens) ?? 0;
  const cacheWriteTokens = number(raw.cacheWriteTokens) ?? 0;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: inputTokens + outputTokens, usageSemantics: 'overlap', ...(number(raw.costUsd) !== undefined ? { sourceCostUsd: number(raw.costUsd) } : {}) };
}
function category(name: string): ToolCategory {
  if (name === 'agent' || name === 'agent_output') return 'Agent';
  if (/shell|bash/.test(name)) return 'Bash';
  if (/edit|write/.test(name)) return 'Edit';
  if (/read/.test(name)) return 'Read';
  if (/grep|glob/.test(name)) return 'Grep';
  return 'Other';
}

export async function parseCommandCodeSession(filePath: string, project: string): Promise<ParseResult> {
  const messages: TraceMessage[] = [];
  const activities: TraceActivity[] = [];
  const errors: ParseResult['errors'] = [];
  const warnings: string[] = [];
  const rows: Array<{ row: RecordValue; line: number }> = [];
  const info = await stat(filePath);
  for (const [index, line] of (await readFile(filePath, 'utf8')).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push({ row: object(JSON.parse(line)), line: index + 1 }); }
    catch { errors.push({ line: index + 1, raw: '[invalid JSON]', error: 'Malformed JSONL record' }); }
  }
  const header = rows.find(({ row }) => row.type === 'session')?.row ?? {};
  const sourceId = typeof header.id === 'string' ? header.id : basename(filePath, '.jsonl');
  const id = `commandcode:${sourceId}`;
  const calls = new Map<string, TraceToolCall>();
  const seen = new Set<string>();
  let turnIndex = -1;
  let name: string | undefined;
  let savedTitle: string | undefined;
  try {
    const metadata = object(JSON.parse(await readFile(filePath.replace(/\.jsonl$/, '.meta.json'), 'utf8')));
    if (typeof metadata.title === 'string' && metadata.title.trim()) savedTitle = metadata.title;
  } catch { /* Optional metadata sidecar may not exist or may be incomplete. */ }
  let model: string | undefined;
  let sourceCostUsd: number | null = null;
  let missingCost = false;
  let hasSubagent = false;
  let startedAt = typeof header.timestamp === 'string' ? header.timestamp : null;
  let endedAt = startedAt;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  for (const { row, line } of rows) {
    if (row.type === 'session_info' && typeof row.name === 'string') name = row.name;
    if (row.type === 'model_change' && typeof row.model === 'string') model = row.model;
    if (row.type !== 'message') continue;
    const raw = object(row.message);
    if (raw.role !== 'user' && raw.role !== 'assistant' && raw.role !== 'system') continue;
    const messageId = typeof row.id === 'string' ? row.id : `line-${line}`;
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    const blocks = Array.isArray(raw.content) ? raw.content.map(object) : [{ type: 'text', text: text(raw.content) }];
    const results = blocks.filter(b => b.type === 'tool_result');
    const visible = blocks.filter(b => b.type === 'text' || b.type === 'image');
    const isUser = raw.role === 'user' && visible.some(b => text(b).trim()) && object(raw.meta).source !== 'tool';
    if (isUser) turnIndex++;
    if (turnIndex < 0) turnIndex = 0;
    const timestamp = typeof row.timestamp === 'string' ? row.timestamp : undefined;
    startedAt ??= timestamp ?? null;
    endedAt = timestamp ?? endedAt;
    model = typeof row.model === 'string' ? row.model : model;
    const tokenUsage = raw.role === 'assistant' ? usage(row.usage) : undefined;
    if (tokenUsage) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += tokenUsage[key] ?? 0;
    if (raw.role === 'assistant') {
      const cost = number(object(row.usage).costUsd);
      if (cost === undefined) missingCost = true;
      else sourceCostUsd = (sourceCostUsd ?? 0) + cost;
    }
    const ordinal = messages.length;
    messages.push({ id: `${id}:${messageId}`, ordinal, role: results.length && !isUser ? 'tool_result' : raw.role, content: visible.map(text).filter(Boolean).join('\n') || results.map(b => text(b.content)).join('\n'), timestamp, model, tokenUsage, turnIndex, turnId: `${id}:turn-${turnIndex}`, isRealUserInput: isUser, sourceMetadata: { sourceType: 'commandcode', sourceFile: filePath, sourceLine: line } });
    for (const block of blocks) {
      if (block.type === 'thinking') activities.push({ type: 'thinking', content: text(block), isRedacted: false });
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const toolName = typeof block.name === 'string' ? block.name : 'unknown';
        const call: TraceToolCall = { type: 'tool_call', id: `${id}:${block.id}`, name: toolName, category: category(toolName), inputJson: JSON.stringify(block.input ?? {}), resultEvents: [], status: 'pending', messageOrdinal: ordinal, sourceLine: line };
        calls.set(block.id, call); activities.push(call);
        if (toolName === 'agent') hasSubagent = true;
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = calls.get(block.tool_use_id);
        if (call) {
          call.resultEvents.push({ type: 'result_event', content: text(block.content), timestamp, isPartial: false });
          call.status = block.is_error === true ? 'error' : 'success';
          if (block.is_error === true) call.error = text(block.content);
        } else warnings.push(`Line ${line}: tool result has no recorded invocation`);
      }
    }
  }
  if (hasSubagent) warnings.push('Command Code agent calls are replayed as tools; persisted subagent session IDs and child transcripts are unavailable.');
  if (missingCost && sourceCostUsd !== null) warnings.push('Some assistant records lack costUsd; source-reported session cost is incomplete.');
  if (!Object.keys(header).length) warnings.push('No Command Code session header found.');
  return { session: { id, source: 'commandcode', sourceSessionId: sourceId, project: typeof header.cwd === 'string' ? header.cwd : project, cwd: typeof header.cwd === 'string' ? header.cwd : undefined, sourceVersion: String(header.version ?? 'unknown'), name: savedTitle ?? name, model, startedAt, endedAt, updatedAt: info.mtime.toISOString(), status: 'idle', metrics: { messageCount: messages.length, userMessageCount: messages.filter(m => m.isRealUserInput).length, ...totals, hasToolCalls: calls.size > 0, parserMalformedLines: errors.length, isTruncated: false }, sourceCostUsd, costSource: sourceCostUsd === null ? null : 'source-reported', costPricingStatus: sourceCostUsd === null ? null : missingCost ? 'partial' : 'priced', turns: [] }, messages, activities, errors, warnings };
}
