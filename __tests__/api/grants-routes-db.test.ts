/**
 * The grants routes against the real funding books (paying spec v3 O3, acceptance test 8 at the screens): defaults, exceptions and
 * gifts saved and read back, the three-part preview, a clash refused with the people named until one rule is chosen, a gift that is
 * for a fixed group, billed marks only for credit to be billed, and nothing but a super admin gets in. Runs only with ROLES_DB_TEST=yes and
 * a DATABASE_URL to a migrated THROWAWAY database (it empties the grant tables first):
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/grants-routes-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const session = { user: null as { id: string; email: string | null } | null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => session.user) }));

import { prisma } from '@/lib/db';
import { saveMeterSettings } from '@/lib/meter';
import { GET as getOverview } from '@/app/api/admin/grants/route';
import { POST as postPreview } from '@/app/api/admin/grants/preview/route';
import { PUT as putDefault } from '@/app/api/admin/grants/defaults/[category]/route';
import { POST as postException } from '@/app/api/admin/grants/exceptions/route';
import { DELETE as deleteException } from '@/app/api/admin/grants/exceptions/[id]/route';
import { ensureIssued } from '@/lib/credit-issue';
import { POST as postGift } from '@/app/api/admin/grants/gifts/route';
import { PATCH as patchGift } from '@/app/api/admin/grants/gifts/[id]/route';
import { GET as getFind } from '@/app/api/admin/grants/find/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const ADMIN_EMAIL = `grants-admin-${tag}@example.test`;
const MILLION = 1_000_000;

const call = <T>(handler: (...args: never[]) => Promise<Response>, url: string, init: { method: string; body?: unknown }, ...rest: unknown[]) =>
  (handler as unknown as (r: NextRequest, ...a: unknown[]) => Promise<Response>)(new NextRequest(`http://localhost:3333${url}`, { method: init.method, headers: { 'Content-Type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), ...rest) as Promise<Response & { json(): Promise<T> }>;
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

let admin: { id: string; email: string };
const people: string[] = [];
let universeId = '';
let made = 0;
async function person(name: string, createdAt?: Date): Promise<string> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name, ...(createdAt ? { createdAt } : {}) } });
  people.push(user.id);
  return user.id;
}

const envBefore = process.env.SUPER_ADMINS;

async function wipeBooks() {
  await prisma.$executeRawUnsafe('DELETE FROM credit_refunds');
  await prisma.$executeRawUnsafe('DELETE FROM credit_allocations');
  await prisma.$executeRawUnsafe('DELETE FROM credit_holds');
  await prisma.$executeRawUnsafe('DELETE FROM credit_lots');
  await prisma.$executeRawUnsafe('DELETE FROM grant_recipients');
  await prisma.$executeRawUnsafe('DELETE FROM grant_rules');
  await prisma.$executeRawUnsafe('DELETE FROM grant_programs');
}

run('the grants routes, on the real books', () => {
  beforeAll(async () => {
    process.env.SUPER_ADMINS = ADMIN_EMAIL;
    const user = await prisma.user.create({ data: { uuid: `admin-${tag}`, email: ADMIN_EMAIL, name: 'Khalid' } });
    people.push(user.id);
    admin = { id: user.id, email: ADMIN_EMAIL };
    const universe = await prisma.universe.create({ data: { slug: `grants-${tag}`, name: `Kuwait Makers ${tag}`, ownerId: user.id } });
    universeId = universe.id;
  });

  beforeEach(async () => {
    await wipeBooks();
    session.user = admin;
    // Nothing issues without a rollout budget, and the budget is the admin's to set: here it is a test value
    await saveMeterSettings({ rolloutBudgetMicros: 1_000_000 * MILLION, memberAllowanceMicros: null }, admin.id);
  });

  afterAll(async () => {
    await wipeBooks();
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    if (envBefore === undefined) delete process.env.SUPER_ADMINS;
    else process.env.SUPER_ADMINS = envBefore;
    await prisma.$disconnect();
  });

  const overview = async () => (await call<any>(getOverview, '/api/admin/grants', { method: 'GET' })).json();

  it('keeps every route for a super admin only', async () => {
    session.user = { id: 'someone', email: 'someone@example.test' };
    expect((await call(getOverview, '/api/admin/grants', { method: 'GET' })).status).toBe(403);
    expect((await call(postPreview, '/api/admin/grants/preview', { method: 'POST', body: {} })).status).toBe(403);
    expect((await call(putDefault, '/api/admin/grants/defaults/computers', { method: 'PUT', body: {} }, ctx({ category: 'computers' }))).status).toBe(403);
    expect((await call(postGift, '/api/admin/grants/gifts', { method: 'POST', body: {} })).status).toBe(403);
    expect((await call(getFind, '/api/admin/grants/find?kind=people', { method: 'GET' })).status).toBe(403);
    session.user = null;
    expect((await call(getOverview, '/api/admin/grants', { method: 'GET' })).status).toBe(403);
  });

  it('starts with nothing set, and no amount of ours anywhere', async () => {
    const o = await overview();
    expect(o.money.instant_apps).toMatchObject({ set: false, amountMicros: null });
    expect(o.money.computers).toMatchObject({ set: false, amountMicros: null });
    expect(o.exceptions).toEqual([]);
    expect(o.gifts).toEqual([]);
    expect(o.totals.budgetMicros).toBe(1_000_000 * MILLION);
  });

  it('saves a default as typed, reads it back, and a monthly change is a new version of the same default', async () => {
    const saved = await call<any>(putDefault, '/x', { method: 'PUT', body: { amountMicros: 2 * MILLION, interval: 'once', recipients: { kind: 'all' } } }, ctx({ category: 'instant_apps' }));
    expect(saved.status).toBe(200);
    expect((await overview()).money.instant_apps).toMatchObject({ set: true, amountMicros: 2 * MILLION, interval: 'once', recipients: { kind: 'all' } });
    await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 3 * MILLION, interval: 'monthly', recipients: { kind: 'all' }, startsOn: 'next' } }, ctx({ category: 'instant_apps' }));
    expect((await overview()).money.instant_apps).toMatchObject({ amountMicros: 3 * MILLION, interval: 'monthly' });
    expect(await prisma.grantProgram.count({ where: { categoryId: 'instant_apps', kind: 'default', status: 'active' } })).toBe(1);
  });

  it('saves "None" by ending the default, and then says so rather than "Not set"', async () => {
    await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 2 * MILLION, interval: 'once', recipients: { kind: 'all' } } }, ctx({ category: 'instant_apps' }));
    const none = await call(putDefault, '/x', { method: 'PUT', body: { interval: 'none' } }, ctx({ category: 'instant_apps' }));
    expect(none.status).toBe(200);
    expect((await overview()).money.instant_apps).toMatchObject({ set: true, amountMicros: null, interval: 'none' });
  });

  it('keeps computers following its monthly allowance, and mirrors the default into it', async () => {
    await saveMeterSettings({ memberAllowanceMicros: 5 * MILLION }, admin.id);
    expect((await overview()).money.computers).toMatchObject({ set: true, amountMicros: 5 * MILLION, interval: 'monthly' });
    await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 10 * MILLION, interval: 'monthly', recipients: { kind: 'all' } } }, ctx({ category: 'computers' }));
    expect((await prisma.appSetting.findFirst({ where: { key: { contains: 'meter' } } }))?.value).toBeDefined();
    const { getMeterSettings } = await import('@/lib/meter');
    expect((await getMeterSettings()).memberAllowanceMicros).toBe(10 * MILLION);
  });

  it('refuses things the books refuse, with the books’ own line and the right status', async () => {
    const roles = await call<any>(postException, '/x', { method: 'POST', body: { audience: { kind: 'role', roleId: 'r' }, instant_apps: { mode: 'none' }, computers: { mode: 'same' } } });
    expect(roles.status).toBe(400);
    expect((await roles.json()).error).toMatch(/Recipients are all signed-in members/);
    const noAmount = await call(putDefault, '/x', { method: 'PUT', body: { interval: 'monthly', recipients: { kind: 'all' } } }, ctx({ category: 'computers' }));
    expect(noAmount.status).toBe(400);
    const wrongCategory = await call(putDefault, '/x', { method: 'PUT', body: {} }, ctx({ category: 'universe_ai' }));
    expect(wrongCategory.status).toBe(404);
  });

  it('refuses a gift bigger than the room left in the rollout budget, in dollars', async () => {
    await saveMeterSettings({ rolloutBudgetMicros: 5 * MILLION }, admin.id);
    const [sara, omar] = [await person('Sara'), await person('Omar')];
    const refused = await call<any>(postGift, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [sara, omar] }, amountMicros: 3 * MILLION, scope: 'both', shared: false, endsAt: new Date(Date.now() + 30 * 86400_000).toISOString(), settlement: 'gift', grantKey: randomUUID() } });
    // Two people at $3 each is more than the $5 left: refused now, not half-issued later
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe('over_budget');
  });

  it('gives a gift to people you pick, "each", and reads it back with who paid and what was used', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const response = await call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar, noor] }, scope: 'both', amountMicros: 5 * MILLION, shared: false, endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), settlement: 'gift' } });
    expect(response.status).toBe(201);
    const [gift] = (await overview()).gifts;
    expect(gift).toMatchObject({ amountMicros: 5 * MILLION, shared: false, totalMicros: 10 * MILLION, scope: 'both', settlement: 'gift', usedMicros: 0, ended: false, payer: 'Paid by BAWES Universe' });
    expect(gift.audience.people.map((p: any) => p.name).sort()).toEqual(['Noor', 'Omar']);
    expect(gift.givenByName).toBe('Khalid');
  });

  it('gives a shared gift as one amount for the whole group, never a copy for each', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    await call(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar, noor] }, scope: 'computers', amountMicros: 20 * MILLION, shared: true, endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), settlement: 'gift' } });
    const [gift] = (await overview()).gifts;
    expect(gift).toMatchObject({ shared: true, amountMicros: 20 * MILLION, totalMicros: 20 * MILLION, scope: 'computers' });
  });

  it('refuses a gift that ends in the past, a gift to be billed with no agreement, and a shared gift to everyone', async () => {
    const omar = await person('Omar');
    const base = { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar] }, scope: 'both', amountMicros: 5 * MILLION, shared: false, endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), settlement: 'gift' };
    expect((await call(postGift, '/x', { method: 'POST', body: { ...base, endsAt: new Date(Date.now() - 1000).toISOString() } })).status).toBe(400);
    const noNote = await call<any>(postGift, '/x', { method: 'POST', body: { ...base, settlement: 'to_bill' } });
    expect(noNote.status).toBe(400);
    expect((await noNote.json()).error).toMatch(/say what was agreed/);
    expect((await call(postGift, '/x', { method: 'POST', body: { ...base, audience: { kind: 'all' }, shared: true } })).status).toBe(400);
    expect((await overview()).gifts).toEqual([]);
  });

  it('marks credit to be billed as billed once, and never a gift', async () => {
    const omar = await person('Omar');
    const ends = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const mine = await call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar] }, scope: 'apps', amountMicros: 5 * MILLION, shared: false, endsAt: ends, settlement: 'to_bill', note: 'Agreed on 15 Nov, invoice 12' } });
    const free = await call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar] }, scope: 'apps', amountMicros: 1 * MILLION, shared: false, endsAt: ends, settlement: 'gift' } });
    const [mineId, freeId] = [(await mine.json()).id, (await free.json()).id];
    expect((await call(patchGift, '/x', { method: 'PATCH', body: { action: 'billed' } }, ctx({ id: freeId }))).status).toBe(400);
    // Credit reaches a person when it is first needed, so before that there is nothing to mark
    expect((await call(patchGift, '/x', { method: 'PATCH', body: { action: 'billed' } }, ctx({ id: mineId }))).status).toBe(400);
    await ensureIssued(omar);
    const first = await call<any>(patchGift, '/x', { method: 'PATCH', body: { action: 'billed' } }, ctx({ id: mineId }));
    expect(first.status).toBe(200);
    const again = await call<any>(patchGift, '/x', { method: 'PATCH', body: { action: 'billed' } }, ctx({ id: mineId }));
    expect((await again.json()).alreadyBilled).toBe(true);
    expect((await call(patchGift, '/x', { method: 'PATCH', body: { action: 'billed' } }, ctx({ id: randomUUID() }))).status).toBe(404);
  });

  it('lists every running gift however many have ended before it', async () => {
    await saveMeterSettings({ rolloutBudgetMicros: 1_000_000 * MILLION }, admin.id);
    const omar = await person('Omar');
    const ends = () => new Date(Date.now() + 20 * 86_400_000).toISOString();
    const give = (amount: number) => call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar] }, scope: 'both', amountMicros: amount, shared: false, endsAt: ends(), settlement: 'gift' } });
    const first = await (await give(1 * MILLION)).json();
    for (let i = 0; i < 35; i++) {
      const gift = await (await give((i + 2) * MILLION)).json();
      await call(patchGift, '/x', { method: 'PATCH', body: { action: 'end' } }, ctx({ id: gift.id }));
    }
    const { gifts } = await overview();
    expect(gifts.some((gift: any) => gift.id === first.id && !gift.ended)).toBe(true);
    expect(gifts.filter((gift: any) => gift.ended)).toHaveLength(30);
  });

  it('ends a gift now: it stays listed as ended', async () => {
    const omar = await person('Omar');
    const made_ = await call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar] }, scope: 'both', amountMicros: 5 * MILLION, shared: false, endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), settlement: 'gift' } });
    const id = (await made_.json()).id;
    expect((await call(patchGift, '/x', { method: 'PATCH', body: { action: 'end' } }, ctx({ id }))).status).toBe(200);
    expect((await overview()).gifts[0]).toMatchObject({ ended: true });
  });

  it('saves an exception for people you pick, one rule for each category, and ends it', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const saved = await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: 10 * MILLION, interval: 'monthly' }, computers: { mode: 'none' } } });
    expect(saved.status).toBe(201);
    const o = await overview();
    expect(o.exceptions).toHaveLength(1);
    expect(o.exceptions[0]).toMatchObject({ instant_apps: { mode: 'own', amountMicros: 10 * MILLION, interval: 'monthly' }, computers: { mode: 'none' } });
    expect(o.exceptions[0].audience.people.map((p: any) => p.name).sort()).toEqual(['Noor', 'Omar']);
    const gone = await call(deleteException, '/x', { method: 'DELETE' }, ctx({ id: o.exceptions[0].id }));
    expect(gone.status).toBe(200);
    expect((await overview()).exceptions).toEqual([]);
    expect((await call(deleteException, '/x', { method: 'DELETE' }, ctx({ id: 'nope' }))).status).toBe(404);
  });

  it('never half-saves an exception: if the second category is refused, the first is put back', async () => {
    await saveMeterSettings({ rolloutBudgetMicros: 5 * MILLION }, admin.id);
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const refused = await call<any>(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: 1 * MILLION, interval: 'once' }, computers: { mode: 'own', amountMicros: 3 * MILLION, interval: 'once' } } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe('over_budget');
    expect((await overview()).exceptions).toHaveLength(0);
  });

  it('saves a changed exception for the same people as a change, never a second rule', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const body = (amount: number) => ({ audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: amount * MILLION, interval: 'monthly' }, computers: { mode: 'same' } });
    await call(postException, '/x', { method: 'POST', body: body(10) });
    await call(postException, '/x', { method: 'POST', body: body(12) });
    const o = await overview();
    expect(o.exceptions).toHaveLength(1);
    expect(o.exceptions[0].instant_apps.amountMicros).toBe(12 * MILLION);
    expect(await prisma.grantProgram.count({ where: { kind: 'exception', status: 'active', categoryId: 'instant_apps' } })).toBe(1);
  });

  describe('two rules that disagree for the same people', () => {
    async function twoRules() {
      const [omar, noor, faisal] = [await person('Omar'), await person('Noor'), await person('Faisal')];
      // Two groups of the same narrowness (more than one person each) that share Omar and Noor, and say different things
      const first = await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'none' }, computers: { mode: 'own', amountMicros: 5 * MILLION, interval: 'monthly' } } });
      expect(first.status).toBe(201);
      return { omar, noor, faisal };
    }
    const second = (ids: string[]) => ({ audience: { kind: 'people', userIds: ids }, instant_apps: { mode: 'same' }, computers: { mode: 'own', amountMicros: 25 * MILLION, interval: 'monthly' } });

    it('says the clash in the preview with the people named, and refuses to save it unchosen', async () => {
      const { omar, noor, faisal } = await twoRules();
      const preview = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', ...second([omar, noor, faisal]) } });
      const view = await preview.json();
      expect(view.clash.people.sort()).toEqual(['Noor', 'Omar']);
      expect(view.clash.thisText).toBe('$25 a month');
      expect(view.clash.other.text).toBe('Computers $5 a month');
      const refused = await call<any>(postException, '/x', { method: 'POST', body: second([omar, noor, faisal]) });
      expect(refused.status).toBe(409);
      expect((await refused.json()).code).toBe('clash');
      expect((await overview()).exceptions).toHaveLength(1);
    });

    it('"this one" takes those people out of the other rule', async () => {
      const { omar, noor, faisal } = await twoRules();
      const saved = await call(postException, '/x', { method: 'POST', body: { ...second([omar, noor, faisal]), clashChoice: 'this' } });
      expect(saved.status).toBe(201);
      const { exceptions } = await overview();
      const mine = exceptions.find((e: any) => e.computers.amountMicros === 25 * MILLION);
      expect(mine.audience.people.map((p: any) => p.name).sort()).toEqual(['Faisal', 'Noor', 'Omar']);
      // The other rule had only Omar and Noor, so nobody is left in it: it ended
      expect(exceptions.find((e: any) => e.computers.amountMicros === 5 * MILLION)).toBeUndefined();
    });

    it('"the other one" takes those people out of this rule', async () => {
      const { omar, noor, faisal } = await twoRules();
      const extra = await person('Lina');
      const saved = await call(postException, '/x', { method: 'POST', body: { ...second([omar, noor, faisal, extra]), clashChoice: 'other' } });
      expect(saved.status).toBe(201);
      const { exceptions } = await overview();
      const mine = exceptions.find((e: any) => e.computers.amountMicros === 25 * MILLION);
      expect(mine.audience.people.map((p: any) => p.name).sort()).toEqual(['Faisal', 'Lina']);
      expect(exceptions.find((e: any) => e.computers.amountMicros === 5 * MILLION)).toBeDefined();
    });

    it('never saves a rule that would be left with nobody', async () => {
      const { omar, noor, faisal } = await twoRules();
      // A wider rule that already holds Omar and Noor with a different figure, then a narrower one made only of them
      const wider = await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor, faisal] }, instant_apps: { mode: 'same' }, computers: { mode: 'own', amountMicros: 7 * MILLION, interval: 'monthly' }, clashChoice: 'this' } });
      expect(wider.status).toBe(201);
      const refused = await call<any>(postException, '/x', { method: 'POST', body: { ...second([omar, noor]), clashChoice: 'other' } });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toMatch(/Nobody would be left/);
    });

    it('names the clash for a universe’s members too, not only for people you picked', async () => {
      const { omar, noor } = await twoRules();
      await prisma.universeMember.createMany({ data: [omar, noor].map((userId) => ({ universeId, userId })) });
      try {
        const preview = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', audience: { kind: 'universe', universeId, mode: 'snapshot' }, instant_apps: { mode: 'same' }, computers: { mode: 'own', amountMicros: 25 * MILLION, interval: 'monthly' } } });
        const view = await preview.json();
        expect(view.clash?.people.sort()).toEqual(['Noor', 'Omar']);
      } finally {
        await prisma.universeMember.deleteMany({ where: { universeId, userId: { in: [omar, noor] } } });
      }
    });

    it('says a person’s own rule needs no choice: it comes first', async () => {
      const { omar } = await twoRules();
      const own = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', ...second([omar]) } });
      expect((await own.json()).clash).toBeNull();
    });
  });

  it('says a gift for a fixed group in the preview with each person’s amount and the most issued', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const ends = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const view = await (await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'gift', audience: { kind: 'people', userIds: [omar, noor] }, scope: 'both', amountMicros: 5 * MILLION, shared: false, endsAt: ends } })).json();
    expect(view.numbers).toMatchObject({ people: 2, amountMicros: 5 * MILLION, shared: false, mostNowMicros: 10 * MILLION, laterToo: false, noLifetimeMax: false });
    const shared = await (await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'gift', audience: { kind: 'people', userIds: [omar, noor] }, scope: 'both', amountMicros: 20 * MILLION, shared: true, endsAt: ends } })).json();
    expect(shared.numbers).toMatchObject({ people: 2, shared: true, mostNowMicros: 20 * MILLION });
  });

  it('says a changing universe gift needs a cap on joiners, and is capped by it', async () => {
    const omar = await person('Omar');
    await prisma.universeMember.create({ data: { universeId, userId: omar } });
    const ends = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const base = { audience: { kind: 'universe', universeId, mode: 'changing' }, scope: 'both', amountMicros: 5 * MILLION, shared: false, endsAt: ends };
    const open = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'gift', ...base } });
    expect((await open.json()).problem).toMatch(/Say the most people who can join/);
    const capped = await (await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'gift', ...base, joinerCap: 3 } })).json();
    expect(capped.numbers).toMatchObject({ people: 1, laterToo: true, noLifetimeMax: false });
  });

  it('says a default for everyone has no lifetime maximum, and counts the people who have their own rules', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: 10 * MILLION, interval: 'once' }, computers: { mode: 'same' } } });
    const view = await (await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'default', category: 'instant_apps', amountMicros: 2 * MILLION, interval: 'once', recipients: { kind: 'all' } } })).json();
    expect(view.numbers.noLifetimeMax).toBe(true);
    expect(view.numbers.laterToo).toBe(true);
    expect(view.numbers.ownRules).toBe(2);
    expect(view.numbers.budget.budgetMicros).toBe(1_000_000 * MILLION);
  });

  it('says plainly that nothing issues until the rollout budget is set', async () => {
    await saveMeterSettings({ rolloutBudgetMicros: null }, admin.id);
    const view = await (await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'default', category: 'computers', amountMicros: 5 * MILLION, interval: 'monthly', recipients: { kind: 'all' } } })).json();
    expect(view.numbers.budget).toEqual({ budgetMicros: null, roomMicros: 0 });
  });

  it('finds people and universes by name for the picker: never guests, never email', async () => {
    const sara = await person('Sara-Findable');
    await prisma.user.create({ data: { uuid: `guest-${tag}`, name: 'Sara-Findable Guest', isGuest: true } }).then((guest) => people.push(guest.id));
    const found = await (await call<any>(getFind, '/x?kind=people&q=Sara-Findable', { method: 'GET' })).json();
    expect(found.results.map((r: any) => r.id)).toEqual([sara]);
    expect(JSON.stringify(found)).not.toContain('@example.test');
    const universes = await (await call<any>(getFind, `/x?kind=universes&q=Kuwait Makers ${tag}`, { method: 'GET' })).json();
    expect(universes.results).toEqual([{ id: universeId, name: `Kuwait Makers ${tag}`, detail: expect.stringMatching(/member/) }]);
    expect((await call(getFind, '/x?kind=roles', { method: 'GET' })).status).toBe(400);
  });
});
