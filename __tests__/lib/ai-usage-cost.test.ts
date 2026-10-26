/**
 * What a bot reply cost (game #1173): reading the price facts the bot server sends, and adding rows up so old
 * estimates, real prices and calls with no price are never mixed.
 */
import { addCostRow, emptyCostTotals, formatUsd, readUsagePriceFacts } from '@/lib/ai-usage-cost';

describe('reading the price facts', () => {
  const priced = { costBasis: 'priced', costMicros: 20, inputTokens: 1000, cachedTokens: 4000, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 0, priceSource: 'models.dev', priceVersion: '2026-10-25' };

  it('keeps every fact of a priced reply', () => {
    expect(readUsagePriceFacts(priced)).toEqual({
      inputTokens: 1000, cachedTokens: 4000, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 0,
      costMicros: 20, costBasis: 'priced', priceSource: 'models.dev', priceVersion: '2026-10-25',
    });
  });

  it('keeps a reply that cost 2 millionths of a dollar as 2, not 0', () => {
    expect(readUsagePriceFacts({ ...priced, costMicros: 2 })?.costMicros).toBe(2);
  });

  it('keeps a real zero for an own computer', () => {
    expect(readUsagePriceFacts({ costBasis: 'own_computer', costMicros: 0 })).toMatchObject({ costBasis: 'own_computer', costMicros: 0 });
  });

  it('never gives an unknown price a number, whatever was sent with it', () => {
    expect(readUsagePriceFacts({ costBasis: 'unknown', costMicros: 500, inputTokens: 10 })).toMatchObject({ costBasis: 'unknown', costMicros: null, inputTokens: 10 });
  });

  it('is not a price fact when the body is from a bot server that only sent the old cost', () => {
    expect(readUsagePriceFacts({ cost: 0.0012, tokensUsed: 40 })).toBeNull();
  });

  it('refuses a basis it does not know, and a priced reply with no number', () => {
    expect(readUsagePriceFacts({ costBasis: 'free', costMicros: 5 })).toBeNull();
    expect(readUsagePriceFacts({ costBasis: 'priced' })).toBeNull();
    expect(readUsagePriceFacts({ costBasis: 'priced', costMicros: -3 })).toBeNull();
    expect(readUsagePriceFacts({ costBasis: 'priced', costMicros: '12' })).toBeNull();
  });

  it('rounds to whole numbers, drops nonsense token counts and caps what the column can hold', () => {
    const facts = readUsagePriceFacts({ costBasis: 'priced', costMicros: 1.6, inputTokens: -5, cachedTokens: 'many', outputTokens: 9e15, priceSource: ' x'.repeat(100) });
    expect(facts).toMatchObject({ costMicros: 2, inputTokens: null, cachedTokens: null, outputTokens: 2_000_000_000 });
    expect(facts?.priceSource?.length).toBe(60);
  });
});

describe('adding rows up', () => {
  it('adds real prices as whole millionths, so many tiny replies do not drift', () => {
    const totals = emptyCostTotals();
    for (let i = 0; i < 1000; i++) addCostRow(totals, { apiCalls: 1, cost: null, costMicros: 3, costBasis: 'priced' });
    expect(totals.cost).toBe(0.003);
  });

  it('keeps old estimates apart from real prices', () => {
    const totals = emptyCostTotals();
    addCostRow(totals, { apiCalls: 1, cost: '0.0300', costMicros: null, costBasis: null });
    addCostRow(totals, { apiCalls: 1, cost: null, costMicros: 40, costBasis: 'priced' });
    expect(totals).toEqual({ cost: 0.00004, oldEstimateCost: 0.03, unknownCalls: 0 });
  });

  it('counts calls with no price and adds nothing for them', () => {
    const totals = emptyCostTotals();
    addCostRow(totals, { apiCalls: 2, cost: null, costMicros: null, costBasis: 'unknown' });
    addCostRow(totals, { apiCalls: 1, cost: null, costMicros: 0, costBasis: 'own_computer' });
    expect(totals).toEqual({ cost: 0, oldEstimateCost: 0, unknownCalls: 2 });
  });
});

describe('showing dollars', () => {
  it('shows cents normally and more places when cents would hide the amount', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0.0046)).toBe('$0.0046');
    expect(formatUsd(0.00002)).toBe('$0.00002');
  });
});
