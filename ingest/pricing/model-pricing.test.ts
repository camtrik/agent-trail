import { describe, expect, it } from 'vitest';
import { estimateModelCost, rollUpCosts } from './model-pricing.js';

describe('model pricing', () => {
  it('estimates OpenAI cached input without double-counting cached tokens', () => {
    const estimate = estimateModelCost('gpt-5.4', {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 250_000,
      reasoningTokens: 50_000,
    });

    expect(estimate).toMatchObject({
      cost: 4.1875,
      pricingStatus: 'priced',
      canonicalModel: 'gpt-5.4',
      provider: 'OpenAI',
    });
  });

  it('estimates Claude cache write/read as additive channels', () => {
    const estimate = estimateModelCost('claude-sonnet-4-20250514', {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 250_000,
      cacheWriteTokens: 50_000,
    });

    expect(estimate.cost).toBe(4.7625);
    expect(estimate.pricingStatus).toBe('priced');
    expect(estimate.canonicalModel).toBe('claude-sonnet-4');
  });

  it('matches dashboard model aliases from the pricing table', () => {
    expect(estimateModelCost('glm-5.1', { inputTokens: 1_000_000, outputTokens: 0 }).cost).toBe(1.4);
    expect(estimateModelCost('zhipuai-coding-plan/glm-5.1', { inputTokens: 1_000_000, outputTokens: 0 }).cost).toBe(1.4);
    expect(estimateModelCost('MiniMax-M2.5-highspeed', { inputTokens: 0, outputTokens: 1_000_000 }).cost).toBe(1.213);
    expect(estimateModelCost('claude-opus-4-7', { inputTokens: 0, outputTokens: 1_000_000 }).cost).toBe(25);
  });

  it('returns unknown for unpriced models', () => {
    expect(estimateModelCost('gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 })).toMatchObject({
      cost: null,
      pricingStatus: 'unknown',
    });
  });

  it('rolls up partial costs when some models are unknown', () => {
    const rollup = rollUpCosts([
      estimateModelCost('gpt-5.4-mini', { inputTokens: 1_000_000, outputTokens: 0 }),
      estimateModelCost('unknown-model', { inputTokens: 1_000_000, outputTokens: 0 }),
    ]);

    expect(rollup).toEqual({
      cost: 0.75,
      pricingStatus: 'partial',
      pricedCount: 1,
      unknownCount: 1,
    });
  });
});


describe('Claude 5.5 official pricing', () => {
  it.each([
    ['claude-opus-5.5', 4, 20, 0.2, 5],
    ['anthropic/claude-opus-5-5-20261101', 4, 20, 0.2, 5],
    ['claude-sonnet-5.5', 2, 10, 0.1, 2.5],
    ['claude_sonnet_5_5', 2, 10, 0.1, 2.5],
  ])('uses official token and five-minute cache rates for %s', (model, input, output, read, write) => {
    expect(estimateModelCost(String(model), {
      inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    }).cost).toBe(Number(input) + Number(output) + Number(read) + Number(write));
  });

  it.each([
    [99_999, 0, 0, 0.0105],
    [100_000, 0, 0, 0.0105],
    [100_001, 0, 0, 0.052501],
    [10_000, 90_000, 0, 0.0024],
    [10_000, 100_000, 0, 0.0125],
    [10_000, 0, 90_001, 0.063751],
  ])('selects Haiku tier from uncached=%s cacheRead=%s cacheWrite=%s', (inputTokens, cacheReadTokens, cacheWriteTokens, expected) => {
    expect(estimateModelCost('claude-haiku-5-5', {
      inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens: 1_000,
    }).cost).toBe(expected);
  });

  it('propagates a known partial cost instead of making the rollup precise', () => {
    expect(rollUpCosts([{ cost: 1, pricingStatus: 'partial' }])).toMatchObject({ cost: 1, pricingStatus: 'partial' });
  });
});
