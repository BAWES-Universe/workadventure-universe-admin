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
import { getMeterSettings, saveMeterSettings } from '@/lib/meter';
import { readMeterSettings } from '@/lib/meter-values';
import { GET as getOverview } from '@/app/api/admin/grants/route';
import { POST as postPreview } from '@/app/api/admin/grants/preview/route';
import { PUT as putDefault } from '@/app/api/admin/grants/defaults/[category]/route';
import { POST as postException } from '@/app/api/admin/grants/exceptions/route';
import { DELETE as deleteException } from '@/app/api/admin/grants/exceptions/[id]/route';
import { ensureIssued } from '@/lib/credit-issue';
import { askForMore, openRequestFor } from '@/lib/meter-requests';
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

  it('answers an ask for more Apps credit when Apps credit reaches the person, and leaves a computers ask alone', async () => {
    const asker = await person('Asker');
    await askForMore(asker, new Date(Date.now() - 60_000), 'apps');
    await askForMore(asker, new Date(Date.now() - 60_000), 'computer');
    expect(await openRequestFor(asker, 'apps')).not.toBeNull();
    await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 10 * MILLION, interval: 'once', recipients: { kind: 'all' } } }, ctx({ category: 'instant_apps' }));
    await ensureIssued(asker);
    expect(await openRequestFor(asker, 'apps')).toBeNull();
    expect(await openRequestFor(asker, 'computer')).not.toBeNull();
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
    await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 10 * MILLION, interval: 'monthly', recipients: { kind: 'all' }, startsOn: 'now' } }, ctx({ category: 'computers' }));
    expect((await prisma.appSetting.findFirst({ where: { key: { contains: 'meter' } } }))?.value).toBeDefined();
    const { getMeterSettings } = await import('@/lib/meter');
    expect((await getMeterSettings()).memberAllowanceMicros).toBe(10 * MILLION);
  });

  it('keeps the allowance as it is until the 1st when the computers default starts on the 1st, then follows it, and a save now replaces the wait', async () => {
    await saveMeterSettings({ memberAllowanceMicros: 5 * MILLION }, admin.id);
    const next = await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 8 * MILLION, interval: 'monthly', recipients: { kind: 'all' }, startsOn: 'next' } }, ctx({ category: 'computers' }));
    expect(next.status).toBe(200);
    expect((await getMeterSettings()).memberAllowanceMicros).toBe(5 * MILLION);
    // The default shows as saved, like every default that starts on the 1st; the allowance computers follow waits
    expect((await overview()).money.computers).toMatchObject({ amountMicros: 8 * MILLION, interval: 'monthly' });
    const row = await prisma.appSetting.findUnique({ where: { key: 'meter' } });
    const later = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
    expect((row?.value as any).memberAllowanceLater).toEqual({ micros: 8 * MILLION, from: later.toISOString() });
    expect(readMeterSettings(row?.value, later).memberAllowanceMicros).toBe(8 * MILLION);
    // Saving an allowance now (here or from the Limits page) replaces the one that was waiting
    await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 6 * MILLION, interval: 'monthly', recipients: { kind: 'all' }, startsOn: 'now' } }, ctx({ category: 'computers' }));
    expect((await getMeterSettings()).memberAllowanceMicros).toBe(6 * MILLION);
    expect(readMeterSettings((await prisma.appSetting.findUnique({ where: { key: 'meter' } }))?.value, later).memberAllowanceMicros).toBe(6 * MILLION);
  });

  it('never half-saves a computers default: when the allowance cannot be saved, the default is not saved either', async () => {
    await saveMeterSettings({ memberAllowanceMicros: 5 * MILLION }, admin.id);
    const before = await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 5 * MILLION, interval: 'monthly', recipients: { kind: 'all' }, startsOn: 'now' } }, ctx({ category: 'computers' }));
    expect(before.status).toBe(200);
    // The second write fails at the database: the allowance row cannot change
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION grants_test_refuse_meter() RETURNS trigger AS $$ BEGIN IF NEW.key = 'meter' THEN RAISE EXCEPTION 'meter settings refused for the test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER grants_test_refuse_meter BEFORE INSERT OR UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION grants_test_refuse_meter()');
    const silenced = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const refused = await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 9 * MILLION, interval: 'monthly', recipients: { kind: 'all' }, startsOn: 'now' } }, ctx({ category: 'computers' }));
      expect(refused.status).toBeGreaterThanOrEqual(500);
    } finally {
      silenced.mockRestore();
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS grants_test_refuse_meter ON app_settings');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS grants_test_refuse_meter()');
    }
    // Neither changed: the screen's "failed" is true
    expect((await overview()).money.computers).toMatchObject({ amountMicros: 5 * MILLION, interval: 'monthly' });
    expect((await getMeterSettings()).memberAllowanceMicros).toBe(5 * MILLION);
  });

  it('refuses a computers default that the monthly allowance could not follow, rather than saving one that does nothing', async () => {
    await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 4 * MILLION, interval: 'monthly', recipients: { kind: 'all' }, startsOn: 'now' } }, ctx({ category: 'computers' }));
    expect((await getMeterSettings()).memberAllowanceMicros).toBe(4 * MILLION);
    const once = await call<any>(putDefault, '/x', { method: 'PUT', body: { amountMicros: 5 * MILLION, interval: 'once', recipients: { kind: 'all' } } }, ctx({ category: 'computers' }));
    expect(once.status).toBe(400);
    expect((await once.json()).error).toMatch(/every month to everyone/);
    const fromDate = await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 5 * MILLION, interval: 'monthly', recipients: { kind: 'new_from', from: new Date().toISOString() } } }, ctx({ category: 'computers' }));
    expect(fromDate.status).toBe(400);
    // The refused saves changed nothing: the default and the allowance the meter follows still agree
    expect((await overview()).money.computers).toMatchObject({ amountMicros: 4 * MILLION, interval: 'monthly' });
    expect((await getMeterSettings()).memberAllowanceMicros).toBe(4 * MILLION);
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
    await call(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar, noor] }, scope: 'both', amountMicros: 20 * MILLION, shared: true, endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), settlement: 'gift' } });
    const [gift] = (await overview()).gifts;
    expect(gift).toMatchObject({ shared: true, amountMicros: 20 * MILLION, totalMicros: 20 * MILLION, scope: 'both' });
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

  it('keeps an ended gift that was to be billed and was not, however many ended after it', async () => {
    await saveMeterSettings({ rolloutBudgetMicros: 1_000_000 * MILLION }, admin.id);
    const omar = await person('Omar');
    const ends = () => new Date(Date.now() + 20 * 86_400_000).toISOString();
    const owed = await (await call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar] }, scope: 'apps', amountMicros: 3 * MILLION, shared: false, endsAt: ends(), settlement: 'to_bill', note: 'Agreed on 15 Nov' } })).json();
    await ensureIssued(omar);
    await call(patchGift, '/x', { method: 'PATCH', body: { action: 'end' } }, ctx({ id: owed.id }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 32; i++) {
      const gift = await (await call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar] }, scope: 'both', amountMicros: (i + 2) * MILLION, shared: false, endsAt: ends(), settlement: 'gift' } })).json();
      await call(patchGift, '/x', { method: 'PATCH', body: { action: 'end' } }, ctx({ id: gift.id }));
    }
    const { gifts } = await overview();
    expect(gifts.find((gift: any) => gift.id === owed.id)).toMatchObject({ ended: true, settlement: 'to_bill' });
    expect(gifts.filter((gift: any) => gift.ended).length).toBe(31);
  });

  it('never ends a default or an exception through the gift routes', async () => {
    await call(putDefault, '/x', { method: 'PUT', body: { amountMicros: 2 * MILLION, interval: 'once', recipients: { kind: 'all' } } }, ctx({ category: 'instant_apps' }));
    const omar = await person('Omar');
    await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar] }, instant_apps: { mode: 'own', amountMicros: 1 * MILLION, interval: 'once' }, computers: { mode: 'same' } } });
    const programs = await prisma.grantProgram.findMany({ where: { kind: { in: ['default', 'exception'] } }, select: { id: true } });
    for (const program of programs) expect((await call(patchGift, '/x', { method: 'PATCH', body: { action: 'end' } }, ctx({ id: program.id }))).status).toBe(404);
    const { exceptions, money } = await overview();
    expect(exceptions).toHaveLength(1);
    expect(money.instant_apps.interval).toBe('once');
    // A made-up exception id that names a default does not end it either
    const defaultId = (await prisma.grantProgram.findFirst({ where: { kind: 'default' }, select: { id: true } }))!.id;
    await call(deleteException, '/x', { method: 'DELETE' }, ctx({ id: `${defaultId}~none` }));
    expect((await overview()).money.instant_apps.interval).toBe('once');
  });

  it('ends a gift now: it stays listed as ended', async () => {
    const omar = await person('Omar');
    const made_ = await call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar] }, scope: 'both', amountMicros: 5 * MILLION, shared: false, endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), settlement: 'gift' } });
    const id = (await made_.json()).id;
    expect((await call(patchGift, '/x', { method: 'PATCH', body: { action: 'end' } }, ctx({ id }))).status).toBe(200);
    expect((await overview()).gifts[0]).toMatchObject({ ended: true });
  });

  it('refuses credit for computers alone, in a gift, an exception and its preview, with the plain words and nothing saved, and still allows a gift for both', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const endsAt = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const gift = (scope: string) => call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'people', userIds: [omar, noor] }, scope, amountMicros: 5 * MILLION, shared: false, endsAt, settlement: 'gift' } });
    const refusedGift = await gift('computers');
    expect(refusedGift.status).toBe(400);
    expect(await refusedGift.json()).toMatchObject({ code: 'computers_not_yet', error: expect.stringContaining('computers alone is not available yet') });
    expect((await overview()).gifts).toHaveLength(0);
    for (const computers of [{ mode: 'own', amountMicros: 5 * MILLION, interval: 'monthly' }, { mode: 'none' }]) {
      const body = { audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'same' }, computers };
      const refused = await call<any>(postException, '/x', { method: 'POST', body });
      expect(refused.status).toBe(400);
      expect((await refused.json()).code).toBe('computers_not_yet');
      const preview = await (await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', ...body } })).json();
      expect(preview.problem).toContain('computers alone is not available yet');
    }
    expect((await overview()).exceptions).toHaveLength(0);
    // Credit for both is spendable on Instant Apps, so it stays; so does a gift for Instant Apps
    expect((await gift('both')).status).toBe(201);
    expect((await gift('apps')).status).toBe(201);
  });

  it('saves an exception for people you pick, one rule for each category, and ends it', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const saved = await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: 10 * MILLION, interval: 'monthly' }, computers: { mode: 'same' } } });
    expect(saved.status).toBe(201);
    const o = await overview();
    expect(o.exceptions).toHaveLength(1);
    expect(o.exceptions[0]).toMatchObject({ instant_apps: { mode: 'own', amountMicros: 10 * MILLION, interval: 'monthly' } });
    expect(o.exceptions[0].audience.people.map((p: any) => p.name).sort()).toEqual(['Noor', 'Omar']);
    const gone = await call(deleteException, '/x', { method: 'DELETE' }, ctx({ id: o.exceptions[0].id }));
    expect(gone.status).toBe(200);
    expect((await overview()).exceptions).toEqual([]);
    expect((await call(deleteException, '/x', { method: 'DELETE' }, ctx({ id: 'nope' }))).status).toBe(404);
  });

  it('ends both categories of an exception together: when the second cannot end, the first stays as it was', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const saved = await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: 10 * MILLION, interval: 'monthly' }, computers: { mode: 'same' } } });
    expect(saved.status).toBe(201);
    // A computers rule for the same people from before computers-only credit was refused, made through the books
    const { saveException } = await import('@/lib/credit-rules');
    await saveException({ categoryId: 'computers', amount: 5 * MILLION, schedule: 'monthly', recipients: { kind: 'people', userIds: [omar, noor] }, claimStartsAt: new Date() }, { userId: admin.id, superAdmin: true });
    const o = await overview();
    expect(o.exceptions).toHaveLength(1);
    const computersRule = await prisma.grantProgram.findFirst({ where: { categoryId: 'computers', kind: 'exception', status: 'active' }, select: { id: true } });
    // The second category's program cannot be ended (the database refuses it)
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION grants_test_refuse_end() RETURNS trigger AS $$ BEGIN IF NEW.id = '${computersRule!.id}' AND NEW.status = 'ended' THEN RAISE EXCEPTION 'cannot end for the test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER grants_test_refuse_end BEFORE UPDATE ON grant_programs FOR EACH ROW EXECUTE FUNCTION grants_test_refuse_end()');
    const silenced = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const refused = await call(deleteException, '/x', { method: 'DELETE' }, ctx({ id: o.exceptions[0].id }));
      expect(refused.status).toBeGreaterThanOrEqual(500);
    } finally {
      silenced.mockRestore();
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS grants_test_refuse_end ON grant_programs');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS grants_test_refuse_end()');
    }
    // An error was said, so nothing ended: both programs are still active, and the exception reads as it did
    expect(await prisma.grantProgram.count({ where: { kind: 'exception', status: 'active' } })).toBe(2);
    expect((await overview()).exceptions).toHaveLength(1);
    // And ending it without the fault ends both
    expect((await call(deleteException, '/x', { method: 'DELETE' }, ctx({ id: o.exceptions[0].id }))).status).toBe(200);
    expect(await prisma.grantProgram.count({ where: { kind: 'exception', status: 'active' } })).toBe(0);
  });

  it('changes another category of an exception that already has a computers rule from before, sent back as it was, and leaves that rule alone', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const audience = { kind: 'people', userIds: [omar, noor] };
    await call(postException, '/x', { method: 'POST', body: { audience, instant_apps: { mode: 'own', amountMicros: 10 * MILLION, interval: 'monthly' }, computers: { mode: 'same' } } });
    const { saveException } = await import('@/lib/credit-rules');
    await saveException({ categoryId: 'computers', amount: 5 * MILLION, schedule: 'monthly', recipients: { kind: 'people', userIds: [omar, noor] }, claimStartsAt: new Date() }, { userId: admin.id, superAdmin: true });
    const opened = (await overview()).exceptions[0];
    expect(opened.computers).toMatchObject({ mode: 'own', amountMicros: 5 * MILLION, interval: 'monthly' });
    const computersBefore = await prisma.grantProgram.findFirstOrThrow({ where: { categoryId: 'computers', kind: 'exception', status: 'active' }, select: { id: true } });
    // The edit sheet sends every category back: the Apps amount changes, the computers rule is as it was
    const body = { audience, replaceId: opened.id, instant_apps: { mode: 'own', amountMicros: 12 * MILLION, interval: 'monthly' }, computers: opened.computers };
    const preview = await (await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', ...body } })).json();
    expect(preview.problem).toBeUndefined();
    expect((await call(postException, '/x', { method: 'POST', body })).status).toBe(201);
    const after = (await overview()).exceptions;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ instant_apps: { mode: 'own', amountMicros: 12 * MILLION }, computers: { mode: 'own', amountMicros: 5 * MILLION, interval: 'monthly' } });
    // The computers rule is the same rule, not ended and saved again
    expect(await prisma.grantProgram.findFirstOrThrow({ where: { categoryId: 'computers', kind: 'exception', status: 'active' }, select: { id: true } })).toEqual(computersBefore);
    // A different computers rule is still refused, and "As everyone" still ends it
    const changed = await call<any>(postException, '/x', { method: 'POST', body: { ...body, replaceId: after[0].id, computers: { mode: 'own', amountMicros: 6 * MILLION, interval: 'monthly' } } });
    expect(changed.status).toBe(400);
    expect((await changed.json()).code).toBe('computers_not_yet');
    expect((await call(postException, '/x', { method: 'POST', body: { ...body, replaceId: after[0].id, computers: { mode: 'same' } } })).status).toBe(201);
    expect((await overview()).exceptions[0].computers).toEqual({ mode: 'same' });
  });

  it('does not call a computers rule "as it was" when the people it is saved for changed: the save is refused and nothing changes', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const audience = { kind: 'people', userIds: [omar, noor] };
    await call(postException, '/x', { method: 'POST', body: { audience, instant_apps: { mode: 'own', amountMicros: 10 * MILLION, interval: 'monthly' }, computers: { mode: 'same' } } });
    const { saveException } = await import('@/lib/credit-rules');
    await saveException({ categoryId: 'computers', amount: 5 * MILLION, schedule: 'monthly', recipients: { kind: 'people', userIds: [omar, noor] }, claimStartsAt: new Date() }, { userId: admin.id, superAdmin: true });
    const opened = (await overview()).exceptions[0];
    // The same rule sent back for fewer people, with the Apps amount changed
    const narrowed = { audience: { kind: 'people', userIds: [omar] }, replaceId: opened.id, instant_apps: { mode: 'own', amountMicros: 12 * MILLION, interval: 'monthly' }, computers: opened.computers };
    const answer = await call<any>(postException, '/x', { method: 'POST', body: narrowed });
    expect(answer.status).toBe(400);
    expect((await answer.json()).code).toBe('computers_not_yet');
    // Nothing changed: the Apps rule is still 10 for both people
    expect((await overview()).exceptions[0]).toMatchObject({ instant_apps: { mode: 'own', amountMicros: 10 * MILLION }, computers: { mode: 'own', amountMicros: 5 * MILLION } });
  });

  it('never half-saves an exception: if the second category is refused, the first is put back', async () => {
    await saveMeterSettings({ rolloutBudgetMicros: 5 * MILLION }, admin.id);
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    // The first category saves, and the second is refused: the first is put back (here the second is refused because computers-only credit is not available yet)
    const refused = await call<any>(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: 1 * MILLION, interval: 'once' }, computers: { mode: 'own', amountMicros: 3 * MILLION, interval: 'once' } } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe('computers_not_yet');
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

  it('previews an exception that sets one category to No grant and the other to its own amount with the funding of the amount, once and monthly apart', async () => {
    await saveMeterSettings({ rolloutBudgetMicros: 100 * MILLION }, admin.id);
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const preview = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: 5 * MILLION, interval: 'once' }, computers: { mode: 'same' } } });
    const view = await preview.json();
    expect(view.numbers).toMatchObject({ interval: 'once', mostOnceMicros: 10 * MILLION, mostMonthlyMicros: null, issuedNowMicros: 10 * MILLION });
  });

  it('an exception the admin opened that was ended and replaced meanwhile is not saved onto its replacement', async () => {
    const [omar, noor] = [await person('Omar'), await person('Noor')];
    const body = (amount: number, extra: object = {}) => ({ audience: { kind: 'people', userIds: [omar, noor] }, instant_apps: { mode: 'own', amountMicros: amount * MILLION, interval: 'monthly' }, computers: { mode: 'same' }, ...extra });
    await call(postException, '/x', { method: 'POST', body: body(10) });
    const opened = (await overview()).exceptions[0].id;
    // Another admin ends it and makes a new one for the same people
    await call(deleteException, '/x', { method: 'DELETE' }, ctx({ id: opened }));
    await call(postException, '/x', { method: 'POST', body: body(20) });
    const stale = await call<any>(postException, '/x', { method: 'POST', body: body(99, { replaceId: opened }) });
    expect(stale.status).toBe(409);
    const o = await overview();
    expect(o.exceptions).toHaveLength(1);
    expect(o.exceptions[0].instant_apps.amountMicros).toBe(20 * MILLION);
  });

  describe('two rules that disagree for the same people', () => {
    async function twoRules() {
      const [omar, noor, faisal] = [await person('Omar'), await person('Noor'), await person('Faisal')];
      // Two groups of the same narrowness (more than one person each) that share Omar and Noor, and say different things
      const first = await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, computers: { mode: 'same' }, instant_apps: { mode: 'own', amountMicros: 5 * MILLION, interval: 'monthly' } } });
      expect(first.status).toBe(201);
      return { omar, noor, faisal };
    }
    const second = (ids: string[]) => ({ audience: { kind: 'people', userIds: ids }, computers: { mode: 'same' }, instant_apps: { mode: 'own', amountMicros: 25 * MILLION, interval: 'monthly' } });

    it('says the clash in the preview with the people named, and refuses to save it unchosen', async () => {
      const { omar, noor, faisal } = await twoRules();
      const preview = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', ...second([omar, noor, faisal]) } });
      const view = await preview.json();
      expect(view.clash.people.sort()).toEqual(['Noor', 'Omar']);
      expect(view.clash.thisText).toBe('$25 a month');
      expect(view.clash.other.text).toBe('Instant Apps $5 a month');
      const refused = await call<any>(postException, '/x', { method: 'POST', body: second([omar, noor, faisal]) });
      expect(refused.status).toBe(409);
      expect((await refused.json()).code).toBe('clash');
      expect((await overview()).exceptions).toHaveLength(1);
    });

    it('says the clash in the preview when the new rule is "No grant", so the choice can be made before saving', async () => {
      const { omar, noor, faisal } = await twoRules();
      const none = { audience: { kind: 'people', userIds: [omar, noor, faisal] }, computers: { mode: 'same' }, instant_apps: { mode: 'none' } };
      const preview = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', ...none } });
      const view = await preview.json();
      expect(view.clash.people.sort()).toEqual(['Noor', 'Omar']);
      expect(view.clash.thisText).toBe('no grant');
      expect(view.clash.other.text).toBe('Instant Apps $5 a month');
      expect((await call<any>(postException, '/x', { method: 'POST', body: none })).status).toBe(409);
      // The same "No grant" over people whose rule already says "No grant" is no clash
      const same = { audience: { kind: 'people', userIds: [omar, noor] }, computers: { mode: 'same' }, instant_apps: { mode: 'same' } };
      const again = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', ...same } });
      expect((await again.json()).clash).toBeNull();
    });

    it('"this one" takes those people out of the other rule', async () => {
      const { omar, noor, faisal } = await twoRules();
      const saved = await call(postException, '/x', { method: 'POST', body: { ...second([omar, noor, faisal]), clashChoice: 'this' } });
      expect(saved.status).toBe(201);
      const { exceptions } = await overview();
      const mine = exceptions.find((e: any) => e.instant_apps.amountMicros === 25 * MILLION);
      expect(mine.audience.people.map((p: any) => p.name).sort()).toEqual(['Faisal', 'Noor', 'Omar']);
      // The other rule had only Omar and Noor, so nobody is left in it: it ended
      expect(exceptions.find((e: any) => e.instant_apps.amountMicros === 5 * MILLION)).toBeUndefined();
    });

    it('gives the other rule its people back when the choice still can’t be saved', async () => {
      const [omar, noor, faisal] = [await person('Omar'), await person('Noor'), await person('Faisal')];
      const first = await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor] }, computers: { mode: 'same' }, instant_apps: { mode: 'own', amountMicros: 5 * MILLION, interval: 'monthly' } } });
      expect(first.status).toBe(201);
      // The choice is made ("this one": Omar and Noor leave the old rule, which ends), and then the new rule itself cannot be saved
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION grants_test_refuse_rule() RETURNS trigger AS $$ BEGIN IF NEW.amount = 25000000 THEN RAISE EXCEPTION 'cannot save for the test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe('CREATE TRIGGER grants_test_refuse_rule BEFORE INSERT ON grant_rules FOR EACH ROW EXECUTE FUNCTION grants_test_refuse_rule()');
      const silenced = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const refused = await call<any>(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor, faisal] }, computers: { mode: 'same' }, instant_apps: { mode: 'own', amountMicros: 25 * MILLION, interval: 'monthly' }, clashChoice: 'this' } });
        // An unexpected error is a 500, not one of the refusals (400, 409) the screen can say something about
        expect(refused.status).toBe(500);
      } finally {
        silenced.mockRestore();
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS grants_test_refuse_rule ON grant_rules');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS grants_test_refuse_rule()');
      }
      const { exceptions } = await overview();
      // Nothing was left half-done: the old rule holds both people as it did, and the new one is not there
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0].audience.people.map((p: any) => p.name).sort()).toEqual(['Noor', 'Omar']);
      expect(exceptions[0].instant_apps.amountMicros).toBe(5 * MILLION);
    });

    it('clears every person the two rules disagree about, however many there are', async () => {
      const crowd: string[] = [];
      for (let i = 0; i < 60; i++) crowd.push(await person(`Crowd${i}`));
      const extra = await person('Extra');
      const mk = (ids: string[], dollars: number) => ({ audience: { kind: 'people', userIds: ids }, computers: { mode: 'same' }, instant_apps: { mode: 'own', amountMicros: dollars * MILLION, interval: 'monthly' } });
      expect((await call(postException, '/x', { method: 'POST', body: mk(crowd, 1) })).status).toBe(201);
      const refused = await call<any>(postException, '/x', { method: 'POST', body: mk([...crowd, extra], 2) });
      expect(refused.status).toBe(409);
      // The screen is shown 50 names at most, never the ids
      const shown = (await refused.json()).clashes[0];
      expect(shown.people.length).toBe(50);
      expect(shown.userIds).toBeUndefined();
      const saved = await call(postException, '/x', { method: 'POST', body: { ...mk([...crowd, extra], 2), clashChoice: 'this' } });
      expect(saved.status).toBe(201);
      const { exceptions } = await overview();
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0].audience.people.length).toBe(61);
      expect(exceptions[0].instant_apps.amountMicros).toBe(2 * MILLION);
    });

    it('"the other one" takes those people out of this rule', async () => {
      const { omar, noor, faisal } = await twoRules();
      const extra = await person('Lina');
      const saved = await call(postException, '/x', { method: 'POST', body: { ...second([omar, noor, faisal, extra]), clashChoice: 'other' } });
      expect(saved.status).toBe(201);
      const { exceptions } = await overview();
      const mine = exceptions.find((e: any) => e.instant_apps.amountMicros === 25 * MILLION);
      expect(mine.audience.people.map((p: any) => p.name).sort()).toEqual(['Faisal', 'Lina']);
      expect(exceptions.find((e: any) => e.instant_apps.amountMicros === 5 * MILLION)).toBeDefined();
    });

    it('never saves a rule that would be left with nobody', async () => {
      const { omar, noor, faisal } = await twoRules();
      // A wider rule that already holds Omar and Noor with a different figure, then a narrower one made only of them
      const wider = await call(postException, '/x', { method: 'POST', body: { audience: { kind: 'people', userIds: [omar, noor, faisal] }, computers: { mode: 'same' }, instant_apps: { mode: 'own', amountMicros: 7 * MILLION, interval: 'monthly' }, clashChoice: 'this' } });
      expect(wider.status).toBe(201);
      const refused = await call<any>(postException, '/x', { method: 'POST', body: { ...second([omar, noor]), clashChoice: 'other' } });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toMatch(/Nobody would be left/);
    });

    it('names the clash for a universe’s members too, not only for people you picked', async () => {
      const { omar, noor } = await twoRules();
      await prisma.universeMember.createMany({ data: [omar, noor].map((userId) => ({ universeId, userId })) });
      try {
        const preview = await call<any>(postPreview, '/x', { method: 'POST', body: { what: 'exception', audience: { kind: 'universe', universeId, mode: 'snapshot' }, computers: { mode: 'same' }, instant_apps: { mode: 'own', amountMicros: 25 * MILLION, interval: 'monthly' } } });
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
    // The most it can issue counts the people there now and the three who may join: $5 each for four people
    expect(capped.numbers).toMatchObject({ people: 1, laterToo: true, noLifetimeMax: false, mostNowMicros: 20 * MILLION, issuedNowMicros: 5 * MILLION });
  });

  it('keeps a changing universe gift to its members now plus the joiners the admin allowed', async () => {
    const own = await prisma.universe.create({ data: { slug: `cap-${tag}`, name: `Cap Club ${tag}`, ownerId: admin.id } });
    const joined: string[] = [];
    try {
      const members = [await person('M1'), await person('M2'), await person('M3')];
      await prisma.universeMember.createMany({ data: members.map((userId) => ({ universeId: own.id, userId })) });
      const made = await call<any>(postGift, '/x', { method: 'POST', body: { grantKey: randomUUID(), audience: { kind: 'universe', universeId: own.id, mode: 'changing' }, scope: 'both', amountMicros: 1 * MILLION, shared: false, endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), settlement: 'gift', joinerCap: 2 } });
      expect(made.status).toBe(201);
      const giftId = (await made.json()).id;
      const got = async (userId: string) => {
        await ensureIssued(userId);
        return (await prisma.creditLot.count({ where: { personId: userId, programId: giftId } })) > 0;
      };
      // The members who were there come first and still leave room for the two joiners the admin allowed
      for (const member of members) expect(await got(member)).toBe(true);
      const joiners = [await person('J1'), await person('J2'), await person('J3')];
      for (const joiner of joiners) {
        await prisma.universeMember.create({ data: { universeId: own.id, userId: joiner } });
        joined.push(joiner);
      }
      expect([await got(joiners[0]), await got(joiners[1]), await got(joiners[2])]).toEqual([true, true, false]);
    } finally {
      await prisma.universeMember.deleteMany({ where: { universeId: own.id } });
      await prisma.universe.delete({ where: { id: own.id } });
    }
  });

  it('lets an already-issued fixed rule be saved again, or one person be added, when little of the budget is left', async () => {
    await saveMeterSettings({ rolloutBudgetMicros: 10 * MILLION }, admin.id);
    const [omar, noor, pam] = [await person('Omar'), await person('Noor'), await person('Pam')];
    const body = (ids: string[]) => ({ audience: { kind: 'people', userIds: ids }, instant_apps: { mode: 'own', amountMicros: 3 * MILLION, interval: 'once' }, computers: { mode: 'same' } });
    expect((await call(postException, '/x', { method: 'POST', body: body([omar, noor]) })).status).toBe(201);
    await ensureIssued(omar);
    await ensureIssued(noor);
    // $6 of the $10 is issued; saving the same rule again is no new spending
    expect((await call(postException, '/x', { method: 'POST', body: body([omar, noor]) })).status).toBe(201);
    const [existing] = (await overview()).exceptions;
    const added = await call<any>(postException, '/x', { method: 'POST', body: { ...body([omar, noor, pam]), replaceId: existing.id } });
    expect(added.status).toBe(201);
    expect((await overview()).exceptions).toHaveLength(1);
  });

  it('previews a monthly default that starts on the 1st as nothing issued now, with its first month said apart', async () => {
    await person('Omar');
    await person('Noor');
    const preview = (startsOn: string) => call<any>(postPreview, '/x', { method: 'POST', body: { what: 'default', category: 'instant_apps', amountMicros: 3 * MILLION, interval: 'monthly', recipients: { kind: 'all' }, startsOn } }).then((response) => response.json());
    const next = await preview('next');
    expect(next.numbers.issuedNowMicros).toBe(0);
    expect(next.numbers.firstMonthMicros).toBe(next.numbers.mostNowMicros);
    expect(next.numbers.firstMonthMicros).toBeGreaterThan(0);
    // Starting now, the same people are issued now
    const now = await preview('now');
    expect(now.numbers.issuedNowMicros).toBe(now.numbers.mostNowMicros);
    expect(now.numbers.firstMonthMicros).toBeNull();
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
