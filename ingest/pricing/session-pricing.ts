/** Request-aware estimates shared by session and overview APIs. */
import type Database from 'better-sqlite3';
import {
  estimateModelCost, requiresRequestUsage, rollUpCosts,
  type ModelCostEstimate, type TokenUsageForPricing,
} from './model-pricing.js';
import { getCanonicalModelKey } from './normalize-model.js';

type Usage = Required<TokenUsageForPricing>;
export interface PricedSessionUsage {
  model: string | null;
  day: string | null;
  usage: Usage;
  totalTokens?: number;
  estimate: ModelCostEstimate;
  aggregateFallback?: boolean;
}
interface SessionRow {
  total_input_tokens: number; total_output_tokens: number;
  total_cache_read_tokens: number; total_cache_write_tokens: number; total_reasoning_tokens: number;
  source_cost_usd: number | null;
  cost_pricing_status: string | null;
}
interface MessageRow {
  id: string; role: string; model: string | null; day: string | null; token_usage_json: string | null;
}
const channels = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;
const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
const unknown = (): ModelCostEstimate => ({ cost: null, pricingStatus: 'unknown' });

function parseUsage(json: string | null): { usage: Usage; totalTokens: number; requestId?: string } | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.inputTokens !== 'number' || typeof record.outputTokens !== 'number') return undefined;
    const usage = emptyUsage();
    for (const channel of channels) {
      const value = record[channel] ?? 0;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
      usage[channel] = value;
    }
    const totalTokens = typeof record.totalTokens === 'number' && Number.isFinite(record.totalTokens) && record.totalTokens >= 0
      ? record.totalTokens
      : record.usageSemantics === 'overlap' ? usage.inputTokens + usage.outputTokens
        : channels.reduce((sum, channel) => sum + usage[channel], 0);
    return { usage, totalTokens, requestId: typeof record.requestId === 'string' && record.requestId ? record.requestId : undefined };
  } catch { return undefined; }
}

export function getSessionUsageCosts(
  database: Database.Database,
  sessionId: string,
  // Usage-only mode retains request/model token rows, suppressing both the
  // reported session total and inferred prices so callers cannot double-count.
  options?: { usageOnly?: boolean },
): PricedSessionUsage[] {
  const session = database.prepare(`
    SELECT total_input_tokens, total_output_tokens, total_cache_read_tokens,
      total_cache_write_tokens, total_reasoning_tokens, source_cost_usd, cost_pricing_status
    FROM sessions WHERE id = ?
  `).get(sessionId) as SessionRow | undefined;
  if (!session) return [];
  const totals: Usage = {
    inputTokens: session.total_input_tokens || 0, outputTokens: session.total_output_tokens || 0,
    cacheReadTokens: session.total_cache_read_tokens || 0, cacheWriteTokens: session.total_cache_write_tokens || 0,
    reasoningTokens: session.total_reasoning_tokens || 0,
  };
  const messages = database.prepare(`
    SELECT id, role, model, date(timestamp, 'localtime') AS day, token_usage_json
    FROM messages WHERE session_id = ?
      AND COALESCE(model, '') <> '<synthetic>' ORDER BY ordinal
  `).all(sessionId) as MessageRow[];
  const models = new Set(messages.map((m) => getCanonicalModelKey(m.model)).filter((m) => m !== null));
  const model = models.size === 1 ? [...models][0] : null;
  if (session.source_cost_usd !== null && !options?.usageOnly) {
    return [{ model, day: null, usage: totals, aggregateFallback: true,
      estimate: { cost: session.source_cost_usd, pricingStatus: session.cost_pricing_status === 'partial' ? 'partial' : 'priced' } }];
  }

  const rawTotals = emptyUsage();
  const requests = new Map<string, PricedSessionUsage & { hasRequestId: boolean; conflictingModel: boolean }>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const parsed = parseUsage(message.token_usage_json);
    if (!parsed) continue;
    for (const channel of channels) rawTotals[channel] += parsed.usage[channel];
    const key = parsed.requestId ? `request:${parsed.requestId}` : `message:${message.id}`;
    const existing = requests.get(key);
    if (existing) {
      // Claude content-block records can repeat the same API request's
      // cumulative usage. Preserve its largest snapshot instead of adding it.
      const increased = channels.some((channel) => parsed.usage[channel] > existing.usage[channel]);
      for (const channel of channels) existing.usage[channel] = Math.max(existing.usage[channel], parsed.usage[channel]);
      existing.totalTokens = Math.max(existing.totalTokens ?? 0, parsed.totalTokens);
      if (increased || !existing.day) existing.day = message.day || existing.day;
      existing.conflictingModel ||= getCanonicalModelKey(existing.model) !== getCanonicalModelKey(message.model);
    } else {
      requests.set(key, { model: message.model, day: message.day, usage: parsed.usage, totalTokens: parsed.totalTokens,
        estimate: unknown(), hasRequestId: !!parsed.requestId, conflictingModel: false });
    }
  }
  if (requests.size === 0) {
    // Aggregate usage is safe only for one model with a fixed rate. A tiered
    // rate cannot be recovered from session/day totals or a final model name.
    return [{ model, day: null, usage: totals, aggregateFallback: true,
      estimate: !options?.usageOnly && model && !requiresRequestUsage(model) ? estimateModelCost(model, totals) : unknown() }];
  }
  const groupedTotals = emptyUsage();
  const entries: PricedSessionUsage[] = [];
  for (const request of requests.values()) {
    for (const channel of channels) groupedTotals[channel] += request.usage[channel];
    request.estimate = options?.usageOnly || request.conflictingModel || (requiresRequestUsage(request.model) && !request.hasRequestId)
      ? unknown() : estimateModelCost(request.model, request.usage, { round: false });
    entries.push(request);
  }
  const complete = [rawTotals, groupedTotals].some((usage) => channels.every((channel) => usage[channel] === totals[channel]));
  if (!complete) {
    const remainder = emptyUsage();
    for (const channel of channels) remainder[channel] = Math.max(0, totals[channel] - rawTotals[channel]);
    entries.push({ model: null, day: null, usage: remainder, estimate: unknown() });
  }
  return entries;
}

export function estimateSessionCost(database: Database.Database, sessionId: string): ModelCostEstimate {
  return rollUpCosts(getSessionUsageCosts(database, sessionId).map((entry) => entry.estimate));
}
