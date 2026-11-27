/**
 * The staging journeys for page payments, run against the FAKE payment service (tools/fake-payment-gateway) instead of a real one. The service's own
 * code answers every request Orbit makes (make a payment, look it up, check a key) and sends its own notices back to Orbit's notice route, so the
 * checkout, the notice, the late payment and the long wait are exercised end to end with a real database. Runs only with ROLES_DB_TEST=yes:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/fake-gateway-journeys-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));

/* eslint-disable @typescript-eslint/no-require-imports */
const { createGateway } = require('../../tools/fake-payment-gateway/core') as { createGateway: (options: Record<string, unknown>) => FakeGateway };
const { definitionFor } = require('../../tools/fake-payment-gateway/definition') as { definitionFor: (origin: string) => Record<string, unknown> };
/* eslint-enable @typescript-eslint/no-require-imports */
type FakeAnswer = { status?: number; body?: unknown; raw?: string; type?: string; drop?: boolean; hang?: number; redirect?: string; html?: string };
interface FakeGateway {
  handle(request: { method: string; path: string; headers: Record<string, string>; json?: unknown }): FakeAnswer;
  tick(): Promise<number>;
}
type Sent = { host: string; path: string; method: string; headers: Record<string, string>; body?: string };

const FAKE = 'https://fake-pay.example.org';
const CONTROL = 'control-token-for-the-tests';
// The fake's clock: real time plus what a journey has moved it (a payment that completes "a day later")
const skew = { ms: 0 };
const mockFake: { current: FakeGateway | null; sent: Sent[] } = { current: null, sent: [] };

/** What Orbit's guarded request would receive from the fake: the fake's answer, or the failure the network would make. */
function viaFake(target: Sent) {
  const [path] = target.path.split('?');
  mockFake.sent.push(target);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(target.headers)) headers[name.toLowerCase()] = value;
  const answer = mockFake.current!.handle({ method: target.method, path, headers, json: target.body ? JSON.parse(target.body) : undefined });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GuardError } = require('@/lib/app-direct/guard');
  if (answer.drop) throw new GuardError('unreachable', 'dropped');
  if (answer.hang) throw new GuardError('timeout', 'no answer');
  return { status: answer.status ?? 200, redirected: false, body: answer.raw ?? JSON.stringify(answer.body ?? {}), truncated: false, contentType: answer.type ?? 'application/json' };
}
jest.mock('@/lib/app-direct/guard', () => {
  const actual = jest.requireActual('@/lib/app-direct/guard');
  return {
    ...actual,
    guardedRequest: jest.fn((request: Parameters<typeof actual.guardedRequest>[0], deps?: Parameters<typeof actual.guardedRequest>[1]) =>
      mockFake.current
        ? actual.guardedRequest(request, { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async (target: Sent) => viaFake(target) })
        : actual.guardedRequest(request, deps),
    ),
  };
});

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { openKeyForm, submitKey } from '@/lib/app-direct/connect';
import { saveServerLimits } from '@/lib/bot-limits';
import { orderForArtifact, pagePaymentLoad, sweepPageOrders, verifyOrder } from '@/lib/app-direct/pay';
import { POST as makeJob } from '@/app/api/bots/[id]/key-apps/[serverId]/page-jobs/route';
import { POST as publicStart } from '@/app/api/pay/[artifactId]/route';
import { POST as notice } from '@/app/api/app-pay/notice/[orderId]/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const TEST_KEY = `sk_test_${randomUUID().replace(/-/g, '')}`;
const LIVE_KEY = `sk_live_${randomUUID().replace(/-/g, '')}`;
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, key: process.env.ENCRYPTION_KEY, api: process.env.NEXT_PUBLIC_API_URL };
const HOUR = 3_600_000;

let sara = '';
let omar = '';
let brick = '';
let omarsBrick = '';
let limitsBefore: { value: unknown } | null = null;
const artifacts: string[] = [];

const request = (path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

/** A fresh fake service whose notices go to Orbit's own notice route, as the real one's would. */
function newFake() {
  skew.ms = 0;
  mockFake.sent = [];
  mockFake.current = createGateway({
    now: () => Date.now() + skew.ms,
    publicUrl: FAKE,
    controlToken: CONTROL,
    send: async (url: string, body: unknown) => {
      const orderId = new URL(url).pathname.split('/').pop()!;
      const response = await notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body }), params({ orderId }));
      return response.status;
    },
  });
  return mockFake.current;
}
const fake = () => mockFake.current!;
const control = (method: string, path: string, json?: unknown) => fake().handle({ method, path, headers: { 'x-control-token': CONTROL }, json });
const fakeId = (checkoutUrl: string) => new URL(checkoutUrl).pathname.split('/').pop()!;
/** What a buyer does on the hosted page. */
const press = async (checkoutUrl: string, what: 'pay' | 'cancel') => {
  const answer = fake().handle({ method: 'POST', path: `/pay/${fakeId(checkoutUrl)}/${what}`, headers: {} });
  await fake().tick();
  return answer;
};
/** Time passes: Orbit's order is older in the database, and the fake's clock has moved on by the same. */
async function pass(orderId: string, hours: number, closed?: boolean) {
  skew.ms += hours * HOUR;
  const order = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } });
  await prisma.appPageOrder.update({
    where: { id: orderId },
    data: { createdAt: new Date(order.createdAt.getTime() - hours * HOUR), checkedAt: order.checkedAt ? new Date(order.checkedAt.getTime() - hours * HOUR) : null, ...(order.closedAt ? { closedAt: new Date(order.closedAt.getTime() - hours * HOUR) } : closed ? { closedAt: new Date(Date.now() - hours * HOUR) } : {}), ...(order.nextLookAt ? { nextLookAt: new Date(order.nextLookAt.getTime() - hours * HOUR) } : {}) },
  });
}
const settle = async (orderId: string) => {
  await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * HOUR) } });
  return verifyOrder(orderId);
};
const orderRow = (orderId: string) => prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } });
const notices = (userId = sara) => prisma.userNotice.findMany({ where: { userId, kind: 'page_payment' } });
const history = async (orderId: string) => (await prisma.appPageOrderEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })).map((line) => `${line.fromStatus ?? ''}>${line.toStatus}:${line.reason}`);

const routeToFake = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async (target: Sent) => viaFake(target) };

const brickOf = (ownerId: string) => (ownerId === omar ? omarsBrick : brick);
async function connectFakeGateway(ownerId: string, key: string): Promise<{ id: string; serverId: string }> {
  // The setup is registered as a draft, the way an owner's Brick would, and the key is checked at the fake itself
  const form = await openKeyForm({ ownerId, draft: definitionFor(FAKE), source: `${FAKE}/docs` });
  const { id } = await submitKey({ requestId: form.id, ownerId, key }, routeToFake as never);
  const grant = await prisma.botMcpServer.findFirstOrThrow({ where: { botId: brickOf(ownerId), connectionId: id } });
  return { id, serverId: grant.id };
}
async function makeArtifact(ownerId: string): Promise<string> {
  const row = await prisma.artifact.create({ data: { ownerId, makerBotId: brickOf(ownerId), makerName: 'Brick', title: 'Shop', kind: 'app', openScope: 'link', chatKind: 'dm', chatRef: `chat-${tag}` } });
  artifacts.push(row.id);
  return row.id;
}
async function page(ownerId: string, key: string): Promise<{ artifactId: string; connectionId: string }> {
  const { id, serverId } = await connectFakeGateway(ownerId, key);
  const artifactId = await makeArtifact(ownerId);
  const made = await makeJob(request(`/api/bots/${brickOf(ownerId)}/key-apps/${serverId}/page-jobs`, { method: 'POST', token: SERVICE_TOKEN, body: { requesterKey: `${ownerId === omar ? 'omar' : 'sara'}-${tag}`, artifactId, amount: '4.500', currency: 'KWD', description: 'A mug' } }), params({ id: brickOf(ownerId), serverId }));
  expect(made.status === 200 ? 200 : `${made.status} ${JSON.stringify(await made.json())}`).toBe(200);
  return { artifactId, connectionId: id };
}
let address = 10;
const wishId = () => `i${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const guestCode = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8);
/** What the host does for a buyer: the page route, as the host calls it. `who` null is a guest with its own recovery code. */
async function ask(artifactId: string, body: Record<string, unknown>, who: string | null): Promise<Response> {
  mockUser.current = who ? { id: who } : null;
  address += 1;
  return publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body, headers: { 'x-forwarded-for': `203.0.113.${address}` } }), params({ artifactId }));
}
async function checkout(artifactId: string, who: string | null = omar, same?: { intentId: string; recoveryCode?: string }): Promise<{ orderId: string; checkoutUrl: string; intentId: string; recoveryCode?: string }> {
  const intentId = same?.intentId ?? wishId();
  const recoveryCode = same ? same.recoveryCode : who ? undefined : guestCode();
  const response = await ask(artifactId, { intentId, shownVersion: 1, ...(recoveryCode ? { recoveryCode } : {}) }, who);
  expect(response.status).toBe(200);
  return { ...(await response.json()), intentId, recoveryCode };
}

run('page payments against the fake payment service', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.example.org';
    limitsBefore = await prisma.appSetting.findUnique({ where: { key: 'bot-limits' } });
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    brick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
    omarsBrick = (await createBrick({ ownerId: omar, name: 'Brick' })).id;
  });
  beforeEach(() => {
    newFake();
  });
  afterEach(async () => {
    mockFake.current = null;
    mockUser.current = null;
    await prisma.appPageOrder.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appKeyCall.deleteMany({ where: { ownerId: { in: [sara, omar, 'page-payments'] } } });
    await prisma.appPageJob.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.artifact.deleteMany({ where: { id: { in: artifacts.splice(0) } } });
    await prisma.appKeyRequest.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.botMcpServer.deleteMany({ where: { botId: { in: [brick, omarsBrick] } } });
    await prisma.userNotice.deleteMany({ where: { userId: { in: [sara, omar] } } });
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    if (limitsBefore) await prisma.appSetting.create({ data: { key: 'bot-limits', value: limitsBefore.value as object } });
    for (const [key, value] of [['BOT_SERVICE_TOKEN', envBefore.service], ['ENCRYPTION_KEY', envBefore.key], ['NEXT_PUBLIC_API_URL', envBefore.api]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect();
  });

  it('takes the draft setup, checks the key at the fake itself, and refuses a key the fake does not know', async () => {
    const form = await openKeyForm({ ownerId: sara, draft: definitionFor(FAKE), source: `${FAKE}/docs` });
    await expect(submitKey({ requestId: form.id, ownerId: sara, key: 'sk_test_' }, routeToFake as never)).rejects.toBeTruthy();
    const ok = await connectFakeGateway(sara, TEST_KEY);
    expect(ok.id).toBeTruthy();
    const asked = mockFake.sent.filter((call) => call.path.includes('chg_universe_key_check'));
    expect(asked.length).toBeGreaterThan(0);
  });

  it('journey 1, signed in: pay on the hosted page, a notice from the service, paid once, and the reload says paid', async () => {
    const { artifactId } = await page(sara, TEST_KEY);
    const { orderId, checkoutUrl } = await checkout(artifactId);
    expect(checkoutUrl.startsWith(`${FAKE}/pay/chg_`)).toBe(true);
    expect((await orderRow(orderId)).status).toBe('pending');
    await press(checkoutUrl, 'pay');
    // The notice came from the fake to Orbit's own route and made Orbit look (nothing else asked): the order is paid and the owner told once
    expect((control('GET', '/control/notices').body as { notices: { status: number }[] }).notices).toMatchObject([{ status: 200 }]);
    expect(await orderRow(orderId)).toMatchObject({ status: 'paid', mode: 'test', buyerKey: `acct:${omar}` });
    expect(await orderForArtifact(orderId, artifactId, undefined, { accountId: omar })).toMatchObject({ status: 'paid', testPayment: true });
    expect(await notices()).toHaveLength(1);
    expect(await history(orderId)).toEqual(expect.arrayContaining(['pending>paid:paid']));
    // Restore purchase, twice: the same order, no new order, no second notice
    const again = await (await ask(artifactId, { restore: true }, omar)).json();
    const twice = await (await ask(artifactId, { restore: true }, omar)).json();
    expect(again).toMatchObject({ status: 'paid', orderId, testPayment: true });
    expect(twice).toMatchObject({ status: 'paid', orderId });
    expect(await prisma.appPageOrder.count({ where: { artifactId } })).toBe(1);
    expect(await notices()).toHaveLength(1);
  });

  it('journey 2, a guest: pays, and the order stays the guest\'s', async () => {
    const { artifactId } = await page(sara, TEST_KEY);
    const { orderId, checkoutUrl, recoveryCode } = await checkout(artifactId, null);
    await press(checkoutUrl, 'pay');
    await settle(orderId);
    const row = await orderRow(orderId);
    expect(row.status).toBe('paid');
    expect(row.buyerKey).toMatch(/^guest:/);
    // The guest's private receipt brings it back; another guest's code does not
    expect(await (await ask(artifactId, { restore: true, recoveryCode }, null)).json()).toMatchObject({ status: 'paid', orderId });
    expect(await (await ask(artifactId, { restore: true, recoveryCode: guestCode() }, null)).json()).toMatchObject({ status: 'none' });
  });

  it('journey 3, cancel on the hosted page: not paid, no link kept, and nobody is told of a payment', async () => {
    const { artifactId } = await page(sara, TEST_KEY);
    const { orderId, checkoutUrl } = await checkout(artifactId);
    await press(checkoutUrl, 'cancel');
    expect(await settle(orderId)).toMatchObject({ status: 'not_paid', checkoutUrl: null });
    expect(await notices()).toHaveLength(0);
  });

  it('journey 4, the twenty-minute walk-away and then a late payment: found on the ORIGINAL order, once, never a second purchase', async () => {
    await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 72 } }, sara);
    const { artifactId } = await page(sara, TEST_KEY);
    control('POST', '/control/next', { lateMinutes: 3 * 60 });
    const { orderId, checkoutUrl, intentId } = await checkout(artifactId);
    await press(checkoutUrl, 'pay');
    expect((await fake().handle({ method: 'GET', path: `/control/payments`, headers: { 'x-control-token': CONTROL } }).body as { payments: { status: string }[] }).payments[0].status).toBe('INITIATED');
    // The open hour passes with the service still saying "started": the order closes as not paid
    await pass(orderId, 2);
    expect(await settle(orderId)).toMatchObject({ status: 'not_paid' });
    // Three hours after the order was made, the service completes it; the buyer is never asked to buy again
    await pass(orderId, 2);
    const ordersBefore = await prisma.appPageOrder.count({ where: { artifactId } });
    // "Check payment" on the original wish: the late payment is found on the original order, and nothing new is started at the service
    const paymentsBefore = (control('GET', '/control/payments').body as { payments: unknown[] }).payments.length;
    await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * HOUR) } });
    const checked = await (await ask(artifactId, { check: true, intentId }, omar)).json();
    expect(checked).toMatchObject({ status: 'paid', orderId, testPayment: true });
    expect((control('GET', '/control/payments').body as { payments: unknown[] }).payments).toHaveLength(paymentsBefore);
    expect(await orderRow(orderId)).toMatchObject({ status: 'paid' });
    expect(await prisma.appPageOrder.count({ where: { artifactId } })).toBe(ordersBefore);
    expect((await history(orderId)).filter((line) => line.includes('>paid:'))).toEqual(['not_paid>paid:paid_late']);
    expect(await notices()).toHaveLength(1);
  });

  it('journey 5, a payment that comes after the late window and a service that cannot be read for days: found once it can be', async () => {
    await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
    const { artifactId } = await page(sara, TEST_KEY);
    control('POST', '/control/next', { lateMinutes: 100 * 60 });
    const { orderId, checkoutUrl } = await checkout(artifactId);
    await press(checkoutUrl, 'pay');
    await pass(orderId, 2);
    expect(await settle(orderId)).toMatchObject({ status: 'not_paid' });
    // Past the late window, with the service unreadable: nothing is learned, nothing is given up
    await pass(orderId, 60);
    const lastRead = (await orderRow(orderId)).lastReadAt;
    control('POST', '/control/unreadable', { mode: '5xx' });
    await prisma.appPageOrder.update({ where: { id: orderId }, data: { nextLookAt: new Date(Date.now() - 1000) } });
    expect((await sweepPageOrders()).looked).toBe(1);
    const waiting = await orderRow(orderId);
    expect(waiting).toMatchObject({ status: 'not_paid', reconciled: false });
    expect(waiting.lastReadAt).toEqual(lastRead);
    expect(waiting.nextLookAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await pagePaymentLoad()).unconfirmed.count).toBe(1);
    // Readable again, and the payment is there (it completed at 100 hours): paid, as a late payment, once
    control('POST', '/control/unreadable', { off: true });
    await pass(orderId, 45);
    await prisma.appPageOrder.update({ where: { id: orderId }, data: { nextLookAt: new Date(Date.now() - 1000) } });
    await sweepPageOrders();
    expect(await orderRow(orderId)).toMatchObject({ status: 'paid' });
    expect((await history(orderId)).filter((line) => line.includes('>paid:'))).toEqual(['not_paid>paid:paid_late']);
    expect((await pagePaymentLoad()).unconfirmed.count).toBe(0);
    expect(await notices()).toHaveLength(1);
  });

  it('journey 6, the same notice twice and one more later: one payment, one owner notice, the paid time never moves', async () => {
    control('POST', '/control/next', { duplicateNotice: 2 });
    const { artifactId } = await page(sara, TEST_KEY);
    const { orderId, checkoutUrl } = await checkout(artifactId);
    await press(checkoutUrl, 'pay');
    const paidAt = (await orderRow(orderId)).paidAt;
    expect(paidAt).not.toBeNull();
    control('POST', `/control/payments/${fakeId(checkoutUrl)}`, { action: 'notify', times: 2 });
    await fake().tick();
    expect((control('GET', '/control/notices').body as { notices: unknown[] }).notices.length).toBeGreaterThanOrEqual(4);
    await settle(orderId);
    expect((await orderRow(orderId)).paidAt).toEqual(paidAt);
    expect(await notices()).toHaveLength(1);
    expect((await history(orderId)).filter((line) => line.includes('>paid:'))).toHaveLength(1);
  });

  it.each([
    ['an amount that is not the order\'s', { amount: 1 }],
    ['another currency', { currency: 'USD' }],
    ['another mode', { live: true }],
    ['another order', { order: 'some-other-order' }],
  ])('journey 7, the service says it captured %s: never paid, held for a person to look at', async (_name, mismatch) => {
    control('POST', '/control/next', { mismatch });
    const { artifactId } = await page(sara, TEST_KEY);
    const { orderId, checkoutUrl } = await checkout(artifactId);
    await press(checkoutUrl, 'pay');
    await settle(orderId);
    const row = await orderRow(orderId);
    expect(row).toMatchObject({ status: 'cant_confirm', reconciled: true });
    expect(await history(orderId)).toContain('pending>cant_confirm:paid_for_something_else');
    expect(await notices()).toHaveLength(0);
    // Nothing is asked again: a payment for something else is final until a person looks
    expect((await sweepPageOrders()).looked).toBe(0);
  });

  it('journey 8, test and live: a test payment says it is a test, a live key sees only live payments, and neither unlocks the other', async () => {
    const test = await page(sara, TEST_KEY);
    const live = await page(omar, LIVE_KEY);
    const testOrder = await checkout(test.artifactId, omar);
    const liveOrder = await checkout(live.artifactId, sara);
    await press(testOrder.checkoutUrl, 'pay');
    await press(liveOrder.checkoutUrl, 'pay');
    await settle(testOrder.orderId);
    await settle(liveOrder.orderId);
    expect(await orderForArtifact(testOrder.orderId, test.artifactId, undefined, { accountId: omar })).toMatchObject({ status: 'paid', testPayment: true });
    expect(await orderForArtifact(liveOrder.orderId, live.artifactId, undefined, { accountId: sara })).toMatchObject({ status: 'paid', testPayment: false });
    // A live key cannot read a test payment and the other way round (the service answers "not found")
    const record = (id: string, key: string) => fake().handle({ method: 'GET', path: `/v2/charges/${id}`, headers: { authorization: `Bearer ${key}` } });
    expect(record(fakeId(testOrder.checkoutUrl), LIVE_KEY).status).toBe(404);
    expect(record(fakeId(liveOrder.checkoutUrl), TEST_KEY).status).toBe(404);
  });

  it('journey 9, a payment made while the answer is lost: no link is given for it, and asking again finds that same payment instead of making a second', async () => {
    const { artifactId } = await page(sara, TEST_KEY);
    control('POST', '/control/create-fault', { mode: 'timeout', times: 1, made: true });
    const intentId = wishId();
    const first = await ask(artifactId, { intentId, shownVersion: 1 }, omar);
    // The buyer is told it is unsure, with no link: a payment Orbit does not know is never given out
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ unsure: true });
    expect((control('GET', '/control/payments').body as { payments: unknown[] }).payments).toHaveLength(1);
    const again = await ask(artifactId, { intentId, shownVersion: 1 }, omar);
    expect(again.status).toBe(200);
    const started = await again.json();
    expect(started.checkoutUrl.startsWith(`${FAKE}/pay/chg_`)).toBe(true);
    // The same payment at the service (it was asked for with the order's own key), and one order
    expect((control('GET', '/control/payments').body as { payments: unknown[] }).payments).toHaveLength(1);
    expect(await prisma.appPageOrder.count({ where: { artifactId } })).toBe(1);
    await press(started.checkoutUrl, 'pay');
    await settle(started.orderId);
    expect(await orderRow(started.orderId)).toMatchObject({ status: 'paid' });
  });
});
