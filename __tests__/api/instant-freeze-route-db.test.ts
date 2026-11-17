/** The admin view of frozen Instant tools and their proven ceilings (S4), against a real database. Runs only with ROLES_DB_TEST=yes. */
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn((email: string | null) => email === 'admin@example.test') }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { freezeTool } from '@/lib/instant/freeze';
import { GET, PATCH } from '@/app/api/admin/instant/freeze/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const session = getSessionUser as jest.Mock;
const patch = (json: unknown) => PATCH(new NextRequest('http://localhost:3333/api/admin/instant/freeze', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }));
const get = () => GET(new NextRequest('http://localhost:3333/api/admin/instant/freeze'));
const KEYS = ['instant-frozen', 'instant-ceilings'];
const saved: Record<string, { value: unknown } | null> = {};

run('frozen Instant tools, for a super admin', () => {
  beforeAll(async () => {
    for (const key of KEYS) saved[key] = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  });
  beforeEach(async () => {
    session.mockResolvedValue({ id: 'admin-1', email: 'admin@example.test' });
    await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } });
  });
  afterAll(async () => {
    for (const key of KEYS) {
      const before = saved[key];
      if (before) await prisma.appSetting.upsert({ where: { key }, create: { key, value: before.value as never }, update: { value: before.value as never } });
      else await prisma.appSetting.deleteMany({ where: { key } });
    }
    await prisma.$disconnect();
  });

  it('is for super admins only', async () => {
    session.mockResolvedValue({ id: 'u', email: 'someone@example.test' });
    expect((await get()).status).toBe(403);
    expect((await patch({ tool: 'EXA_SEARCH', unfreeze: true })).status).toBe(403);
  });

  it('lists what is frozen and what covers it, saves a ceiling with its proof, and clears a freeze', async () => {
    await freezeTool('EXA_SEARCH', { reason: 'unit_or_tier', listed: '$0.007 per search', live: '$0.002 per 1,000 searches' });
    expect(await (await get()).json()).toMatchObject({ frozen: [{ tool: 'EXA_SEARCH', reason: 'unit_or_tier', tableUnitMicros: 7_000, covered: false }], ceilings: [] });
    const covered = await (await patch({ tool: 'EXA_SEARCH', ceiling: { unitMicros: 7_000, proof: 'Provider cap on the account' } })).json();
    expect(covered.frozen[0].covered).toBe(true);
    expect(covered.ceilings[0]).toMatchObject({ tool: 'EXA_SEARCH', unitMicros: 7_000, proof: 'Provider cap on the account' });
    expect((await (await patch({ tool: 'EXA_SEARCH', ceiling: null })).json()).ceilings).toEqual([]);
    expect((await (await patch({ tool: 'EXA_SEARCH', unfreeze: true })).json()).frozen).toEqual([]);
  });

  it('refuses a tool Instant does not offer, a ceiling with no proof, and a call that asks for nothing', async () => {
    expect((await patch({ tool: 'NOT_A_TOOL', unfreeze: true })).status).toBe(400);
    expect((await patch({ tool: 'EXA_SEARCH', ceiling: { unitMicros: 7_000, proof: ' ' } })).status).toBe(400);
    expect((await patch({ tool: 'EXA_SEARCH', ceiling: { unitMicros: 0, proof: 'x' } })).status).toBe(400);
    expect((await patch({ tool: 'EXA_SEARCH' })).status).toBe(400);
  });
});
