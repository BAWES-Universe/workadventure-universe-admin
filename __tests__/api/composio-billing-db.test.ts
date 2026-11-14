/**
 * The Composio bill report and its monthly check (shadow mode), against a real database and a FAKE adapter. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database. Composio itself is never called.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));

import { prisma } from '@/lib/db';
import { setAdapterForTests, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { recordMeterEvent } from '@/lib/meter';
import { GET, PUT } from '@/app/api/admin/composio-billing/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
// A month no other test writes into
const MONTH = '2031-05';
const at = (day: number) => new Date(Date.UTC(2031, 4, day, 12));
const get = (month: string | null = MONTH) => GET(new NextRequest(`http://localhost/api/admin/composio-billing${month === null ? '' : `?month=${month}`}`));
const put = (body: unknown) => PUT(new NextRequest('http://localhost/api/admin/composio-billing', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

let sara = '';
let boss = '';

const fakeAdapter = (usage?: ReadyMadeAdapter['usage']) => ({ usage }) as unknown as ReadyMadeAdapter;

async function step(day: number, id: string, detail: Record<string, unknown>, cost: number, quantity: number) {
  await recordMeterEvent({
    eventId: `app:${tag}:${id}`,
    kind: 'app_use',
    pool: 'chat',
    occurredAt: at(day),
    personKey: `person:${sara}`,
    personId: sara,
    botId: null,
    brick: true,
    payerKind: 'universe',
    payerPersonId: null,
    route: 'app',
    jobId: null,
    quantity,
    unit: 'use',
    costMicros: cost,
    basis: 'estimated',
    sourceRef: null,
    detail,
  });
}
const ownRun = (tool: string) => ({ toolkit: 'gmail', tool, kind: 'execution', tier: 'own', tierVerified: true, ownAuth: true, executions: 1, sandboxRuns: 0, zdrCalls: 0 });

run('the Composio bill report', () => {
  beforeAll(async () => {
    sara = (await prisma.user.create({ data: { uuid: `sara-${tag}`, email: `sara-${tag}@example.test`, name: 'sara' } })).id;
    boss = (await prisma.user.create({ data: { uuid: `boss-${tag}`, email: 'boss@example.test', name: 'boss' } })).id;
  });
  // Off unless a test hands in a fake: a real key in the environment must never reach Composio from a test
  beforeEach(() => setAdapterForTests(null));
  afterEach(async () => {
    setAdapterForTests(undefined);
    mockUser.current = null;
    await prisma.meterEvent.deleteMany({ where: { personId: sara } });
    await prisma.appSetting.deleteMany({ where: { key: { in: ['composio-billing', 'composio-invoices'] } } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [sara, boss] } } });
    await prisma.$disconnect();
  });
  const asBoss = () => (mockUser.current = { id: boss, email: 'boss@example.test' });

  it('is for super admins only, to read and to change', async () => {
    mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
    expect((await get()).status).toBe(403);
    expect((await put({ zdrOn: true })).status).toBe(403);
    mockUser.current = null;
    expect((await get()).status).toBe(403);
  });

  it('refuses a month that is not a month, and a body with anything else in it', async () => {
    asBoss();
    expect((await get('2031-13')).status).toBe(400);
    expect((await get('last month')).status).toBe(400);
    expect((await put({ invoice: { month: 'soon', micros: 5 } })).status).toBe(400);
    expect((await put({ plan: 'enterprise' })).status).toBe(400);
    expect((await put({ surprise: 1 })).status).toBe(400);
  });

  it('reports the month from the meter: searches are free, the plan fee is the bill while the free calls cover the rest', async () => {
    asBoss();
    await step(2, 'a', ownRun('GMAIL_FETCH_EMAILS'), 300, 1);
    await step(3, 'b', ownRun('GMAIL_SEND_EMAIL'), 300, 1);
    await step(4, 'c', { toolkit: 'gmail', tool: 'COMPOSIO_SEARCH_TOOLS', kind: 'free', tier: 'own', tierVerified: true, ownAuth: true, executions: 0, sandboxRuns: 0, zdrCalls: 0 }, 0, 0);
    const body = await (await get()).json();
    expect(body.billed).toMatchObject({ month: MONTH, plan: 'pro', events: 3, executions: 2, freeExecutions: 2, paidExecutions: 0, freeLookups: 1, recordedMicros: 600, planFeeMicros: 29_000_000, billedMicros: 29_000_000 });
    expect(body.rates).toMatchObject({ perCallMicros: { own: 300, managed_other: 500 }, zdrAddOnMicros: 100, freeManagedCallsPerMonth: 20_000 });
    expect(body.reconciliation).toMatchObject({ composio: null, oursTopLevel: 3, invoice: null });
  });

  it('keeps events of other months out of the month', async () => {
    asBoss();
    await step(2, 'a', ownRun('GMAIL_FETCH_EMAILS'), 300, 1);
    const other = await (await get('2031-06')).json();
    expect(other.billed.events).toBe(0);
    expect(other.billed.billedMicros).toBe(29_000_000);
  });

  it('on Hobby there is no fee and no credit', async () => {
    asBoss();
    const changed = await (await put({ plan: 'hobby' })).json();
    expect(changed.settings).toMatchObject({ plan: 'hobby' });
    const body = await (await get()).json();
    expect(body.billed).toMatchObject({ plan: 'hobby', planFeeMicros: 0, billedMicros: 0 });
  });

  it('checks the call count against Composio’s own, and says so when they part', async () => {
    asBoss();
    await step(2, 'a', ownRun('GMAIL_FETCH_EMAILS'), 300, 1);
    await step(3, 'b', ownRun('GMAIL_SEND_EMAIL'), 300, 1);
    const usage = jest.fn(async () => ({ toolCalls: 400, groups: [{ key: 'GMAIL_FETCH_EMAILS', count: 399 }, { key: 'GMAIL_SEND_EMAIL', count: 1 }] }));
    setAdapterForTests(fakeAdapter(usage));
    const body = await (await get()).json();
    expect(usage).toHaveBeenCalledWith({ fromMs: Date.UTC(2031, 4, 1), toMs: Date.UTC(2031, 5, 1) });
    expect(body.reconciliation).toMatchObject({ oursTopLevel: 2, callGap: 398, callsFlagged: true });
    expect(body.reconciliation.biggestDifferences[0]).toEqual({ tool: 'GMAIL_FETCH_EMAILS', ours: 1, composio: 399 });
    expect(body.reconciliation.flags.join(' ')).toContain('Composio counts 400');
  });

  it('does not flag a small gap, and reports a usage check that cannot run instead of failing', async () => {
    asBoss();
    await step(2, 'a', ownRun('GMAIL_FETCH_EMAILS'), 300, 1);
    setAdapterForTests(fakeAdapter(async () => ({ toolCalls: 3, groups: [] })));
    expect((await (await get()).json()).reconciliation).toMatchObject({ callGap: 2, callsFlagged: false });
    setAdapterForTests(fakeAdapter(async () => { throw new Error('down'); }));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await (await get()).json();
    err.mockRestore();
    expect(body.reconciliation.composio).toBeNull();
    expect(body.reconciliation.flags.join(' ')).toContain('could not be read');
  });

  it('checks the bill against an invoice a person enters, and flags a real gap', async () => {
    asBoss();
    await step(2, 'a', ownRun('GMAIL_FETCH_EMAILS'), 300, 1);
    const saved = await put({ invoice: { month: MONTH, micros: 40_000_000 } });
    expect(saved.status).toBe(200);
    let body = await (await get()).json();
    expect(body.reconciliation.invoice).toMatchObject({ micros: 40_000_000 });
    expect(body.reconciliation).toMatchObject({ invoiceGapMicros: 11_000_000, invoiceFlagged: true });
    await put({ invoice: { month: MONTH, micros: 29_100_000 } });
    body = await (await get()).json();
    expect(body.reconciliation).toMatchObject({ invoiceGapMicros: 100_000, invoiceFlagged: false });
  });

  it('remembers whether zero data retention is on, and who set it', async () => {
    asBoss();
    expect((await (await put({ zdrOn: true })).json()).settings).toMatchObject({ plan: 'pro', zdrOn: true });
    expect((await (await get()).json()).settings.zdrOn).toBe(true);
    const row = await prisma.appSetting.findUnique({ where: { key: 'composio-billing' } });
    expect(row?.updatedById).toBe(boss);
  });
});
