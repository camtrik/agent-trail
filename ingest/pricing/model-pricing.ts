/**
 * Model pricing registry for overview cost estimates.
 *
 * Source: docs/ai_provider_pricing_unified_2026-05-17.md
 * Units: USD per 1M tokens.
 */

import { normalizeModelName } from './normalize-model.js';

export type PricingStatus = 'priced' | 'partial' | 'unknown';

export interface TokenUsageForPricing {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ModelCostEstimate {
  cost: number | null;
  pricingStatus: PricingStatus;
  canonicalModel?: string;
  provider?: string;
}

export interface CostRollup {
  cost: number | null;
  pricingStatus: PricingStatus;
  pricedCount: number;
  unknownCount: number;
}

interface PricingTier {
  maxInputTokens?: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

interface PricingRule {
  provider: string;
  canonicalModel: string;
  match: RegExp[];
  tiers: PricingTier[];
  cacheReadIncludedInInput?: boolean;
  reasoningBilledAsOutput?: boolean;
  requestScoped?: boolean;
}

const PRICING_RULES: PricingRule[] = [
  openAi('gpt-5.5-pro', [/^gpt-5\.5-pro(?:$|[-_.])/], 30, 180),
  openAi('gpt-5.5', [/^gpt-5\.5(?:$|[-_.])/], 5, 30, 0.5),
  openAi('gpt-5.4-mini', [/^gpt-5\.4-mini(?:$|[-_.])/], 0.75, 4.5, 0.075),
  openAi('gpt-5.4-nano', [/^gpt-5\.4-nano(?:$|[-_.])/], 0.2, 1.25, 0.02),
  openAi('gpt-5.4', [/^gpt-5\.4(?:$|[-_.])/], 2.5, 15, 0.25),
  openAi('gpt-5.3-codex', [/^gpt-5\.3-codex(?:$|[-_.])/], 1.75, 14, 0.175),
  openAi('chat-latest', [/^chat-latest$/], 5, 30, 0.5),

  // https://platform.claude.com/docs/en/about-claude/pricing (2026-11-11)
  // Cache writes use the standard five-minute rate.
  anthropic('claude-opus-5.5', [/^claude-opus-5[-_.]?5(?:$|[-_.])/], 4, 20, 0.2, 5),
  anthropic('claude-sonnet-5.5', [/^claude-sonnet-5[-_.]?5(?:$|[-_.])/], 2, 10, 0.1, 2.5),
  {
    ...anthropic('claude-haiku-5.5', [/^claude-haiku-5[-_.]?5(?:$|[-_.])/], 0.1, 0.5, 0.01, 0.125),
    requestScoped: true,
    tiers: [
      { maxInputTokens: 100_000, inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125 },
      { inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0.625 },
    ],
  },

  anthropic('claude-opus-4.7', [/^claude-opus-4[-_.]?7(?:$|[-_.])/], 5, 25, 0.5, 6.25),
  anthropic('claude-opus-4.6', [/^claude-opus-4[-_.]?6(?:$|[-_.])/], 5, 25, 0.5, 6.25),
  anthropic('claude-opus-4.5', [/^claude-opus-4[-_.]?5(?:$|[-_.])/], 5, 25, 0.5, 6.25),
  anthropic('claude-opus-4.1', [/^claude-opus-4[-_.]?1(?:$|[-_.])/], 15, 75, 1.5, 18.75),
  anthropic('claude-opus-4', [/^claude-opus-4(?:$|-[0-9]{8}|[-_.]20)/], 15, 75, 1.5, 18.75),
  anthropic('claude-sonnet-4.6', [/^claude-sonnet-4[-_.]?6(?:$|[-_.])/], 3, 15, 0.3, 3.75),
  anthropic('claude-sonnet-4.5', [/^claude-sonnet-4[-_.]?5(?:$|[-_.])/], 3, 15, 0.3, 3.75),
  anthropic('claude-sonnet-4', [/^claude-sonnet-4(?:$|-[0-9]{8}|[-_.]20)/], 3, 15, 0.3, 3.75),
  anthropic('claude-haiku-4.5', [/^claude-haiku-4[-_.]?5(?:$|[-_.])/], 1, 5, 0.1, 1.25),
  anthropic('claude-haiku-3.5', [/^claude-haiku-3[-_.]?5(?:$|[-_.])/], 0.8, 4, 0.08, 1),

  gemini('gemini-3.1-pro-preview', [/^gemini-3\.1-pro-preview$/], [tier(2, 12, 0.2, 200_000), tier(4, 18, 0.4)]),
  gemini('gemini-3.1-flash-preview', [/^gemini-3\.1-flash-preview$/], [tier(1, 6, 0.2, 200_000), tier(2, 9, 0.4)]),
  gemini('gemini-3.1-flash-lite-preview', [/^gemini-3\.1-flash-lite-preview$/], [tier(0.25, 1.5, 0.025)]),
  gemini('gemini-3-flash-lite', [/^gemini-3-flash-lite$/], [tier(0.125, 0.75, 0.0125)]),
  gemini('gemini-2.5-pro', [/^gemini-2\.5-pro(?:$|[-_.])/], [tier(1.25, 10, 0.125, 200_000), tier(2.5, 15, 0.25)]),
  gemini('gemini-2.5-flash-lite', [/^gemini-2\.5-flash-lite(?:$|[-_.])/], [tier(0.3, 2.5, 0.03)]),
  gemini('gemini-2.5-flash', [/^gemini-2\.5-flash(?:$|[-_.])/], [tier(0.625, 5, 0.125, 200_000), tier(1.25, 7.5, 0.25)]),

  cachedInput('DeepSeek', 'deepseek-v4-flash', [/^deepseek-v4-flash$/], 0.14, 0.28, 0.0028),
  cachedInput('DeepSeek', 'deepseek-v4-pro', [/^deepseek-v4-pro$/], 0.435, 0.87, 0.003625),

  qwen('qwen3.5-plus', [/^qwen3\.5-plus$/], [tier(0.115, 0.688, 0.0115, 128_000), tier(0.287, 1.72, 0.0287, 256_000), tier(0.573, 3.44, 0.0573)]),
  qwen('qwen-plus', [/^qwen-plus$/], [tier(0.115, 1.147, 0.0115, 128_000), tier(0.345, 3.441, 0.0345, 256_000), tier(0.689, 9.175, 0.0689)]),
  qwen('qwen-plus-2025-12-01', [/^qwen-plus-2025-12-01$/], [tier(0.4, 4, 0.04, 256_000), tier(1.2, 12, 0.12)]),
  qwen('qwen3-coder-plus', [/^qwen3-coder-plus$/], [tier(1, 5, 0.1, 32_000)]),
  cachedInput('Alibaba Cloud Qwen', 'qwen-long-latest', [/^qwen-long-latest$/], 0.072, 0.287),
  cachedInput('Alibaba Cloud Qwen', 'qwq-plus', [/^qwq-plus$/], 0.8, 2.4),

  cachedInput('Z.AI / GLM', 'glm-5.1', [/^glm-5\.1(?:$|[-_.])/], 1.4, 4.4, 0.26),
  cachedInput('Z.AI / GLM', 'glm-5-turbo', [/^glm-5-turbo(?:$|[-_.])/], 1.2, 4, 0.24),
  cachedInput('Z.AI / GLM', 'glm-5', [/^glm-5(?:$|[-_.])/], 1, 3.2, 0.2),
  cachedInput('Z.AI / GLM', 'glm-4.7-flashx', [/^glm-4\.7-flashx(?:$|[-_.])/], 0.07, 0.4, 0.01),
  cachedInput('Z.AI / GLM', 'glm-4.7-flash', [/^glm-4\.7-flash(?:$|[-_.])/], 0, 0, 0),
  cachedInput('Z.AI / GLM', 'glm-4.7', [/^glm-4\.7(?:$|[-_.])/], 0.6, 2.2, 0.11),
  cachedInput('Z.AI / GLM', 'glm-4.6', [/^glm-4\.6(?:$|[-_.])/], 0.6, 2.2, 0.11),
  cachedInput('Z.AI / GLM', 'glm-4.5-flash', [/^glm-4\.5-flash(?:$|[-_.])/], 0, 0, 0),
  cachedInput('Z.AI / GLM', 'glm-4.5-airx', [/^glm-4\.5-airx(?:$|[-_.])/], 1.1, 4.5, 0.22),
  cachedInput('Z.AI / GLM', 'glm-4.5-air', [/^glm-4\.5-air(?:$|[-_.])/], 0.2, 1.1, 0.03),
  cachedInput('Z.AI / GLM', 'glm-4.5-x', [/^glm-4\.5-x(?:$|[-_.])/], 2.2, 8.9, 0.45),
  cachedInput('Z.AI / GLM', 'glm-4.5', [/^glm-4\.5(?:$|[-_.])/], 0.6, 2.2, 0.11),
  cachedInput('Z.AI / GLM', 'glm-4-32b-0414-128k', [/^glm-4-32b-0414-128k$/], 0.1, 0.1),

  cachedInput('Alibaba Cloud MiniMax', 'minimax-m2.5', [/^minimax-m2\.5(?:$|[-_.])/], 0.304, 1.213),
];

function openAi(
  canonicalModel: string,
  match: RegExp[],
  inputPerMillion: number,
  outputPerMillion: number,
  cacheReadPerMillion?: number,
): PricingRule {
  return cachedInput('OpenAI', canonicalModel, match, inputPerMillion, outputPerMillion, cacheReadPerMillion);
}

function anthropic(
  canonicalModel: string,
  match: RegExp[],
  inputPerMillion: number,
  outputPerMillion: number,
  cacheReadPerMillion: number,
  cacheWritePerMillion: number,
): PricingRule {
  return {
    provider: 'Anthropic',
    canonicalModel,
    match,
    cacheReadIncludedInInput: false,
    reasoningBilledAsOutput: true,
    tiers: [{ inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion }],
  };
}

function gemini(canonicalModel: string, match: RegExp[], tiers: PricingTier[]): PricingRule {
  return {
    provider: 'Google Gemini',
    canonicalModel,
    match,
    cacheReadIncludedInInput: true,
    reasoningBilledAsOutput: true,
    tiers,
  };
}

function qwen(canonicalModel: string, match: RegExp[], tiers: PricingTier[]): PricingRule {
  return {
    provider: 'Alibaba Cloud Qwen',
    canonicalModel,
    match,
    cacheReadIncludedInInput: true,
    reasoningBilledAsOutput: true,
    tiers: tiers.map((pricingTier) => ({
      ...pricingTier,
      cacheWritePerMillion: pricingTier.inputPerMillion * 1.25,
    })),
  };
}

function cachedInput(
  provider: string,
  canonicalModel: string,
  match: RegExp[],
  inputPerMillion: number,
  outputPerMillion: number,
  cacheReadPerMillion?: number,
): PricingRule {
  return {
    provider,
    canonicalModel,
    match,
    cacheReadIncludedInInput: true,
    reasoningBilledAsOutput: true,
    tiers: [{ inputPerMillion, outputPerMillion, cacheReadPerMillion }],
  };
}

function tier(
  inputPerMillion: number,
  outputPerMillion: number,
  cacheReadPerMillion?: number,
  maxInputTokens?: number,
): PricingTier {
  return { inputPerMillion, outputPerMillion, cacheReadPerMillion, maxInputTokens };
}

export function estimateModelCost(
  model: string | null | undefined,
  usage: TokenUsageForPricing,
  options?: { round?: boolean },
): ModelCostEstimate {
  // Provider-grouping guard: product-tier model keys from Qoder (and any source
  // using opaque product-tier identifiers) must never be attributed to a specific
  // provider like Anthropic / OpenAI / Gemini. These keys represent billing tiers,
  // not underlying model names.
  const normalized = normalizeModelName(model);
  if (normalized === 'ultimate' || normalized === 'experts-ultimate') {
    return { cost: null, pricingStatus: 'unknown', provider: 'qoder' };
  }

  const rule = findPricingRule(model);
  if (!rule) {
    return { cost: null, pricingStatus: 'unknown' };
  }

  const promptTokens = usage.inputTokens + (rule.cacheReadIncludedInInput === false
    ? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0);
  const selectedTier = selectTier(rule, promptTokens);
  const inputTokens = Math.max(
    usage.inputTokens - (rule.cacheReadIncludedInInput ? usage.cacheReadTokens ?? 0 : 0),
    0,
  );
  const outputTokens = usage.outputTokens + (rule.reasoningBilledAsOutput === false ? 0 : usage.reasoningTokens ?? 0);
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

  if (cacheReadTokens > 0 && selectedTier.cacheReadPerMillion === undefined) {
    return unknownForRule(rule);
  }

  if (cacheWriteTokens > 0 && selectedTier.cacheWritePerMillion === undefined) {
    return unknownForRule(rule);
  }

  const cost =
    (inputTokens / 1_000_000) * selectedTier.inputPerMillion
    + (outputTokens / 1_000_000) * selectedTier.outputPerMillion
    + (cacheReadTokens / 1_000_000) * (selectedTier.cacheReadPerMillion ?? 0)
    + (cacheWriteTokens / 1_000_000) * (selectedTier.cacheWritePerMillion ?? 0);

  return {
    cost: options?.round === false ? cost : roundCost(cost),
    pricingStatus: 'priced',
    canonicalModel: rule.canonicalModel,
    provider: rule.provider,
  };
}

export function rollUpCosts(estimates: ModelCostEstimate[]): CostRollup {
  let cost = 0;
  let pricedCount = 0;
  let unknownCount = 0;

  for (const estimate of estimates) {
    if (estimate.cost === null) {
      unknownCount += 1;
      continue;
    }

    pricedCount += 1;
    if (estimate.pricingStatus === 'partial') unknownCount += 1;
    cost += estimate.cost;
  }

  if (pricedCount === 0) {
    return { cost: null, pricingStatus: 'unknown', pricedCount, unknownCount };
  }

  return {
    cost: roundCost(cost),
    pricingStatus: unknownCount > 0 ? 'partial' : 'priced',
    pricedCount,
    unknownCount,
  };
}

export function requiresRequestUsage(model: string | null | undefined): boolean {
  return findPricingRule(model)?.requestScoped === true;
}

function findPricingRule(model: string | null | undefined): PricingRule | null {
  const normalized = normalizeModelName(model);
  if (!normalized) return null;
  return PRICING_RULES.find((rule) => rule.match.some((pattern) => pattern.test(normalized))) ?? null;
}

function selectTier(rule: PricingRule, inputTokens: number): PricingTier {
  return rule.tiers.find((pricingTier) => (
    pricingTier.maxInputTokens === undefined || inputTokens <= pricingTier.maxInputTokens
  )) ?? rule.tiers[rule.tiers.length - 1];
}

function unknownForRule(rule: PricingRule): ModelCostEstimate {
  return {
    cost: null,
    pricingStatus: 'unknown',
    canonicalModel: rule.canonicalModel,
    provider: rule.provider,
  };
}

function roundCost(cost: number): number {
  return Math.round(cost * 1_000_000) / 1_000_000;
}
