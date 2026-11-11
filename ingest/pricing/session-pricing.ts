/** Request-aware estimates shared by session and overview APIs. */
import type Database from 'better-sqlite3';
import { decodeMessageUsage } from '../db/message-usage';
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
  reportedModel?: string | null;
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

function parseUsage(json: string | null): {
  usage?: Usage; totalTokens?: number; requestId?: string; sourceCostUsd?: number;
} {
  const stored = decodeMessageUsage(json);
  const tokenUsage = stored.tokenUsage;
  if (!tokenUsage) return stored;
  const usage = emptyUsage();
  for (const channel of channels) usage[channel] = tokenUsage[channel] ?? 0;
  return { ...stored, usage, totalTokens: tokenUsage.totalTokens
    ?? (tokenUsage.usageSemantics === 'overlap' ? usage.inputTokens + usage.outputTokens
      : channels.reduce((sum, channel) => sum + usage[channel], 0)) };
}

export function getSessionUsageCosts(
  database: Database.Database,
  sessionId: string,
  // Usage-only mode retains request/model token rows, suppressing both the
  // reported session total and inferred prices so callers cannot double-count.
  options?: { usageOnly?: boolean; reportedRequests?: boolean },
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
  if (session.source_cost_usd !== null && !options?.usageOnly && !options?.reportedRequests) {
    return [{ model, day: null, usage: totals, aggregateFallback: true,
      estimate: { cost: session.source_cost_usd, pricingStatus: session.cost_pricing_status === 'partial' ? 'partial' : 'priced' } }];
  }

  const rawTotals = emptyUsage();
  type Request = PricedSessionUsage & {
    hasUsage: boolean; hasRequestId: boolean; conflictingModel: boolean; sourceCostUsd?: number;
  };
  const requests = new Map<string, Request>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const parsed = parseUsage(message.token_usage_json);
    if (parsed.usage) for (const channel of channels) rawTotals[channel] += parsed.usage[channel];
    const key = parsed.requestId ? `request:${parsed.requestId}` : `message:${message.id}`;
    const existing = requests.get(key);
    if (existing) {
      const increased = (parsed.usage && channels.some((channel) => parsed.usage![channel] > existing.usage[channel]))
        || (parsed.sourceCostUsd !== undefined && parsed.sourceCostUsd > (existing.sourceCostUsd ?? -1));
      if (parsed.usage) {
        for (const channel of channels) existing.usage[channel] = Math.max(existing.usage[channel], parsed.usage[channel]);
        existing.hasUsage = true;
      }
      existing.totalTokens = Math.max(existing.totalTokens ?? 0, parsed.totalTokens ?? 0);
      if (parsed.sourceCostUsd !== undefined) existing.sourceCostUsd = Math.max(existing.sourceCostUsd ?? 0, parsed.sourceCostUsd);
      if (increased || !existing.day) existing.day = message.day || existing.day;
      const previousModel = getCanonicalModelKey(existing.model);
      const nextModel = getCanonicalModelKey(message.model);
      existing.conflictingModel ||= !!previousModel && !!nextModel && previousModel !== nextModel;
      existing.model ||= message.model;
    } else {
      requests.set(key, { model: message.model, day: message.day, usage: parsed.usage ?? emptyUsage(), totalTokens: parsed.totalTokens,
        sourceCostUsd: parsed.sourceCostUsd, estimate: unknown(), hasUsage: !!parsed.usage,
        hasRequestId: !!parsed.requestId, conflictingModel: false });
    }
  }
  const zeroSource = session.source_cost_usd === 0 && session.cost_pricing_status !== 'partial';
  if (![...requests.values()].some((request) => request.hasUsage) && !options?.reportedRequests) {
    // Legacy aggregate-only data can retain a fixed-rate estimate. Explicit
    // request identities without usage are evidence of missing request data.
    const legacyAggregate = [...requests.values()].every((request) => !request.hasRequestId);
    return [{ model, day: null, usage: totals, aggregateFallback: true,
      estimate: !options?.usageOnly && legacyAggregate && model && !requiresRequestUsage(model)
        ? estimateModelCost(model, totals, { round: false }) : unknown() }];
  }
  const groupedTotals = emptyUsage();
  const entries: PricedSessionUsage[] = [];
  for (const request of requests.values()) {
    for (const channel of channels) groupedTotals[channel] += request.usage[channel];
    if (options?.reportedRequests) {
      request.estimate = zeroSource ? { cost: 0, pricingStatus: 'priced' }
        : session.source_cost_usd === 0 && session.cost_pricing_status === 'partial' ? unknown()
          : request.sourceCostUsd === undefined ? unknown()
          : { cost: request.sourceCostUsd, pricingStatus: session.cost_pricing_status === 'partial' ? 'partial' : 'priced' };
    } else {
      request.estimate = options?.usageOnly || !request.hasUsage || request.conflictingModel
        || (requiresRequestUsage(request.model) && !request.hasRequestId)
        ? unknown() : estimateModelCost(request.model, request.usage, { round: false });
    }
    entries.push(request);
  }
  const complete = [rawTotals, groupedTotals].some((usage) => channels.every((channel) => usage[channel] === totals[channel]));
  const reportedSum = entries.reduce((sum, entry) => sum + (entry.estimate.cost ?? 0), 0);
  const reportedConsistent = session.source_cost_usd !== null
    && Math.abs(reportedSum - session.source_cost_usd) <= 1e-9;
  if ((!options?.reportedRequests && !complete) || (options?.reportedRequests && !zeroSource && !reportedConsistent)) {
    const remainder = emptyUsage();
    for (const channel of channels) remainder[channel] = Math.max(0, totals[channel] - rawTotals[channel]);
    entries.push({ model: null, day: null, usage: remainder, estimate: unknown() });
  }
  if (options?.reportedRequests && entries.length === 0) {
    entries.push({ model, day: null, usage: totals, aggregateFallback: true,
      estimate: zeroSource ? { cost: 0, pricingStatus: 'priced' } : unknown() });
  }

  if (options?.reportedRequests) {
    if (!zeroSource && session.source_cost_usd !== null && reportedSum > session.source_cost_usd + 1e-9) {
      for (const entry of entries) entry.estimate = unknown();
    }
    for (const entry of entries) entry.reportedModel = model;
  }
  return entries;
}

export function estimateSessionCost(database: Database.Database, sessionId: string): ModelCostEstimate {
  return rollUpCosts(getSessionUsageCosts(database, sessionId).map((entry) => entry.estimate));
}
