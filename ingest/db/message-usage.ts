import type { TokenUsage, TraceMessage } from '@/types/trace';

/** Identity-only records preserve missing usage without inventing zero tokens. */
export function encodeMessageUsage(message: TraceMessage): string {
  const requestId = message.requestId || message.tokenUsage?.requestId;
  if (!message.tokenUsage && !requestId) return '';
  return JSON.stringify({ ...message.tokenUsage, ...(requestId ? { requestId } : {}) });
}

export function decodeMessageUsage(json: string | null): {
  requestId?: string;
  sourceCostUsd?: number;
  tokenUsage?: TokenUsage;
} {
  try {
    const value: unknown = json ? JSON.parse(json) : undefined;
    if (!value || typeof value !== 'object') return {};
    const row = value as Record<string, unknown>;
    const requestId = typeof row.requestId === 'string' && row.requestId ? row.requestId : undefined;
    const sourceCostUsd = typeof row.sourceCostUsd === 'number' && Number.isFinite(row.sourceCostUsd) && row.sourceCostUsd >= 0
      ? row.sourceCostUsd : undefined;
    const valid = ['inputTokens', 'outputTokens'].every((key) => typeof row[key] === 'number')
      && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
        .every((key) => row[key] === undefined || (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0));
    return { requestId, sourceCostUsd, tokenUsage: valid ? row as unknown as TokenUsage : undefined };
  } catch { return {}; }
}
