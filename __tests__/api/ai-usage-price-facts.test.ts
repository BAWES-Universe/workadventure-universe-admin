/**
 * Bot usage rows with price facts (game #1173). The bot server sends what a reply cost and how that was worked out; a bot
 * server from before sends only the old cost, and its rows must be saved exactly as before.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';
import { GET as usageReport } from '@/app/api/admin/ai-providers/usage/route';

jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn() },
    botsAiUsage: { create: jest.fn(async () => ({})), findMany: jest.fn() },
    bot: { findMany: jest.fn(async () => []) },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => ({ id: 'admin-1', email: 'admin@bawes.net' })) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn(() => true) }));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));

const provider = prisma.botsAiProvider as unknown as Record<'findUnique' | 'findFirst', jest.Mock>;
const usage = prisma.botsAiUsage as unknown as Record<'create' | 'findMany', jest.Mock>;

const track = (body: object) =>
  trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'b1', providerId: 'deepseek-flash', tokensUsed: 5200, ...body }) }));

beforeEach(() => {
  usage.create.mockReset().mockResolvedValue({});
  usage.findMany.mockReset();
  provider.findUnique.mockResolvedValue({ providerId: 'deepseek-flash', ownerId: null });
});

describe('saving a reply with price facts', () => {
  it('keeps the tokens, the cost in millionths of a dollar and where the prices came from', async () => {
    await track({ costBasis: 'priced', costMicros: 20, inputTokens: 1200, cachedTokens: 4000, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0, priceSource: 'models.dev', priceVersion: '2026-10-25+deepseek-peak' });
    expect(usage.create.mock.calls[0][0].data).toMatchObject({
      costMicros: 20, costBasis: 'priced', inputTokens: 1200, cachedTokens: 4000, outputTokens: 100, priceSource: 'models.dev', priceVersion: '2026-10-25+deepseek-peak', cost: null,
    });
  });

  it('saves a call with no known price as unknown, with no number', async () => {
    await track({ costBasis: 'unknown', priceSource: 'models.dev' });
    expect(usage.create.mock.calls[0][0].data).toMatchObject({ costBasis: 'unknown', costMicros: null, cost: null });
  });

  it('saves a real zero for an own computer', async () => {
    await track({ costBasis: 'own_computer', costMicros: 0 });
    expect(usage.create.mock.calls[0][0].data).toMatchObject({ costBasis: 'own_computer', costMicros: 0 });
  });

  it('saves a reply from a bot server that sends only the old cost exactly as before', async () => {
    await track({ cost: 0.0123 });
    const data = usage.create.mock.calls[0][0].data;
    expect(data.cost).toBe(0.0123);
    expect(data).not.toHaveProperty('costMicros');
    expect(data).not.toHaveProperty('costBasis');
  });
});

describe('the usage report', () => {
  const row = (extra: object) => ({ botId: 'b1', providerId: 'deepseek-flash', tokensUsed: 10, apiCalls: 1, durationSeconds: null, cost: null, costMicros: null, costBasis: null, error: false, provider: { providerId: 'deepseek-flash', name: 'DeepSeek', type: 'openai' }, ...extra });

  it('shows real prices, old estimates and calls with no price apart', async () => {
    usage.findMany.mockResolvedValue([
      row({ costMicros: 20, costBasis: 'priced' }),
      row({ costMicros: 5, costBasis: 'priced' }),
      row({ cost: '0.0300' }),
      row({ costBasis: 'unknown', apiCalls: 2 }),
    ]);
    const response = await usageReport(new NextRequest('http://localhost:3333/api/admin/ai-providers/usage'));
    const { stats } = await response.json();
    expect(stats).toMatchObject({ totalCost: 0.000025, oldEstimateCost: 0.03, unknownCalls: 2, totalCalls: 5 });
    expect(stats.byProvider['deepseek-flash']).toMatchObject({ cost: 0.000025, oldEstimateCost: 0.03, unknownCalls: 2 });
    expect(stats.byBot.b1).toMatchObject({ cost: 0.000025, oldEstimateCost: 0.03, unknownCalls: 2 });
  });
});
