/**
 * Payments for pages (game #2044, step 3) against a real database: the owner's job per page, the visitor's checkout, and the check that
 * decides "paid". Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/app-direct-pay-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
type Sent = { host: string; path: string; method: string; headers: Record<string, string>; body?: string };
type Answered = { status: number; body?: unknown; redirected?: boolean };
const mockSend: { current: ((target: Sent) => Answered | Promise<Answered>) | null } = { current: null };
jest.mock('@/lib/app-direct/guard', () => {
  const actual = jest.requireActual('@/lib/app-direct/guard');
  return {
    ...actual,
    guardedRequest: jest.fn((request: Parameters<typeof actual.guardedRequest>[0], deps?: Parameters<typeof actual.guardedRequest>[1]) =>
      mockSend.current
        ? actual.guardedRequest(request, {
            resolve: async () => [{ address: '93.184.216.34', family: 4 }],
            send: async (target: Sent) => {
              const answer = await mockSend.current!(target);
              return { status: answer.status, redirected: answer.redirected ?? false, body: JSON.stringify(answer.body ?? {}), truncated: false, contentType: 'application/json' };
            },
          })
        : actual.guardedRequest(request, deps),
    ),
  };
});

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { disconnect } from '@/lib/app-connections';
import { definitionSchema, hashDefinition } from '@/lib/app-direct/definition';
import { openKeyForm, submitKey } from '@/lib/app-direct/connect';
import { getBrickLimits, saveServerLimits } from '@/lib/bot-limits';
import { GuardError } from '@/lib/app-direct/guard';
import { classifyPageContract, inventoryPaymentPages } from '@/lib/app-direct/page-contract-inventory';
import { GET as pagesInventory } from '@/app/api/app-pay/pages/route';

// The real inventory, but its calls are recorded (the route's page-size handling is checked by what it asks the inventory for)
jest.mock('@/lib/app-direct/page-contract-inventory', () => {
  const actual = jest.requireActual('@/lib/app-direct/page-contract-inventory');
  return { ...actual, inventoryPaymentPages: jest.fn(actual.inventoryPaymentPages) };
});
import { checkPurchase, checksHaveEnded, guestBuyerKey, isWaiting, lookStats, orderForArtifact, pagePaymentLoad, pollAfterMs, reconcileEveryMs, restorePurchase, shownVersionFor, startCheckout, sweepPageOrders, verifyOrder, verifyOrderForReturnPage } from '@/lib/app-direct/pay';
import { keyAppsOf, runKeyApp } from '@/lib/app-direct/use';
import { GET as readJob, POST as makeJob } from '@/app/api/bots/[id]/key-apps/[serverId]/page-jobs/route';
import { GET as sweepLoad, POST as sweepRoute } from '@/app/api/app-pay/sweep/route';
import { GET as listPages } from '@/app/api/me/apps/pages/route';
import { DELETE as stopPage } from '@/app/api/me/apps/pages/[jobId]/route';
import { GET as publicGet, POST as publicStart } from '@/app/api/pay/[artifactId]/route';
import { POST as gamePay } from '@/app/api/artifacts/[id]/pay/route';
import { POST as notice } from '@/app/api/app-pay/notice/[orderId]/route';
jest.mock('@/lib/app-direct/catalog', () => jest.requireActual('../helpers/example-gateway').catalogWithExample());

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const ADMIN_TOKEN = `admin-${tag}`;
const KEY = `sk_test_${randomUUID().replace(/-/g, '')}`;
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN, key: process.env.ENCRYPTION_KEY, api: process.env.NEXT_PUBLIC_API_URL };

let sara = '';
let omar = '';
let brick = '';
let limitsBefore: { value: unknown } | null = null;
const artifacts: string[] = [];

const request = (path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const okCheck = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async () => ({ status: 404, redirected: false, body: '{}', truncated: false, contentType: null }) };

async function connectGateway(ownerId = sara): Promise<{ id: string; serverId: string }> {
  const form = await openKeyForm({ ownerId, service: 'examplepay' });
  const { id } = await submitKey({ requestId: form.id, ownerId, key: KEY }, okCheck);
  const grant = await prisma.botMcpServer.findFirstOrThrow({ where: { botId: brick, connectionId: id } });
  return { id, serverId: grant.id };
}

async function makeArtifact(over: { ownerId?: string; kind?: string; openScope?: string } = {}): Promise<string> {
  const row = await prisma.artifact.create({
    data: { ownerId: over.ownerId ?? sara, makerBotId: brick, makerName: 'Brick', title: 'Shop', kind: over.kind ?? 'app', openScope: over.openScope ?? 'link', chatKind: 'dm', chatRef: `chat-${tag}` },
  });
  artifacts.push(row.id);
  return row.id;
}

const job = (serverId: string, artifactId: string, body: Record<string, unknown> = {}) =>
  makeJob(request(`/api/bots/${brick}/key-apps/${serverId}/page-jobs`, { method: 'POST', token: SERVICE_TOKEN, body: { requesterKey: `sara-${tag}`, artifactId, amount: '4.500', currency: 'KWD', description: 'A mug', ...body } }), params({ id: brick, serverId }));

/** The version a page opened by its link shows right now: the one its open page says it shows when it starts a payment. */
const onLink = async (artifactId: string) => shownVersionFor(await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId }, select: { latestVersion: true, publishedVersion: true } }), false);
const start = async (artifactId: string, address = '203.0.113.7') =>
  publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { shownVersion: await onLink(artifactId) }, headers: { 'x-forwarded-for': address } }), params({ artifactId }));

/** What the gateway answers: a charge made, then its record. */
let lastOrder = '';
function gateway(over: { create?: Record<string, unknown>; record?: (order: string) => Record<string, unknown>; createStatus?: number } = {}) {
  const sent: Sent[] = [];
  mockSend.current = (target) => {
    sent.push(target);
    if (target.method === 'POST') {
      lastOrder = JSON.parse(target.body ?? '{}').reference?.order ?? lastOrder;
      return { status: over.createStatus ?? 200, body: { id: 'chg_TS01', status: 'INITIATED', amount: 4.5, currency: 'KWD', transaction: { url: 'https://checkout.examplepay.com/?mode=page&token=abc' }, reference: { order: JSON.parse(target.body ?? '{}').reference?.order }, ...over.create } };
    }
    const order = lastOrder;
    return { status: 200, body: over.record ? over.record(order) : { id: 'chg_TS01', status: 'INITIATED', amount: 4.5, currency: 'KWD', live_mode: false, reference: { order } } };
  };
  return sent;
}
const paidRecord = (order: string, change: Record<string, unknown> = {}) => ({ id: 'chg_TS01', status: 'CAPTURED', amount: 4.5, currency: 'KWD', live_mode: false, reference: { order }, ...change });

async function checkout(artifactId: string, address?: string): Promise<{ orderId: string; checkoutUrl: string }> {
  const response = await start(artifactId, address);
  expect(response.status).toBe(200);
  return response.json();
}
async function pending(): Promise<{ artifactId: string; connectionId: string }> {
  const { id, serverId } = await connectGateway();
  const artifactId = await makeArtifact();
  await job(serverId, artifactId);
  return { artifactId, connectionId: id };
}
const settle = async (orderId: string) => {
  // The check is rate limited per order, and further apart the longer the order has waited: let the last look be old enough for any age
  await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * 3_600_000) } });
  return verifyOrder(orderId);
};
const notices = () => prisma.userNotice.findMany({ where: { userId: sara, kind: 'page_payment' } });

run('payments for pages, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.example.org';
    limitsBefore = await prisma.appSetting.findUnique({ where: { key: 'bot-limits' } });
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    brick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
  });

  afterEach(async () => {
    mockSend.current = null;
    mockUser.current = null;
    await prisma.appPageOrder.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    // The rows that count uses of a key stay when the app is disconnected, so they are cleared here (and the rows that count payment looks)
    await prisma.appKeyCall.deleteMany({ where: { ownerId: { in: [sara, omar, 'page-payments'] } } });
    await prisma.appPageJob.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.artifact.deleteMany({ where: { id: { in: artifacts.splice(0) } } });
    await prisma.appKeyRequest.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.botMcpServer.deleteMany({ where: { botId: brick } });
    await prisma.userNotice.deleteMany({ where: { userId: { in: [sara, omar] } } });
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    if (limitsBefore) await prisma.appSetting.create({ data: { key: 'bot-limits', value: limitsBefore.value as object } });
    for (const [key, value] of [['BOT_SERVICE_TOKEN', envBefore.service], ['ADMIN_API_TOKEN', envBefore.admin], ['ENCRYPTION_KEY', envBefore.key], ['NEXT_PUBLIC_API_URL', envBefore.api]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect();
  });

  /* ------------------------- the owner's job ------------------------- */

  describe('asking a Brick to make a page take a payment', () => {
    it('freezes the amount exactly, and the visitor can change nothing', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      const response = await job(serverId, artifactId);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.job).toMatchObject({ artifactId, amount: '4.500', currency: 'KWD', app: 'Example Pay', status: 'active' });
      const row = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      expect(row).toMatchObject({ amountMinor: 4500, currency: 'KWD', ownerId: sara });
    });

    it('replaces the terms for new checkouts only when asked again', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      gateway();
      const before = await checkout(artifactId);
      const again = await job(serverId, artifactId, { amount: '6', currency: 'KWD' });
      expect((await again.json()).replaced).toBe(true);
      expect(await prisma.appPageJob.count({ where: { artifactId } })).toBe(1);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: before.orderId } })).amountMinor).toBe(4500);
      const after = await checkout(artifactId);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: after.orderId } })).amountMinor).toBe(6000);
    });

    it.each([
      ['an amount of zero', { amount: '0' }],
      ['a negative amount', { amount: '-3' }],
      ['more decimals than the currency has', { amount: '4.5001' }],
      ['an exponent', { amount: '1e3' }],
      ['a currency it does not know', { currency: 'XXX' }],
    ])('turns down %s', async (_name, change) => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      const response = await job(serverId, artifactId, change);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('bad_terms');
      expect(await prisma.appPageJob.count({ where: { artifactId } })).toBe(0);
    });

    it('is only for the owner’s own page, and a document cannot take a payment', async () => {
      const { serverId } = await connectGateway();
      const others = await makeArtifact({ ownerId: omar });
      expect((await job(serverId, others)).status).toBe(404);
      expect((await job(serverId, randomUUID())).status).toBe(404);
      const document = await makeArtifact({ kind: 'markdown' });
      expect((await job(serverId, document)).status).toBe(400);
      expect(await prisma.appPageJob.count()).toBe(0);
    });

    it('is only for the owner asking', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      expect((await job(serverId, artifactId, { requesterKey: `omar-${tag}` })).status).toBe(403);
      expect((await job(serverId, artifactId, { requesterKey: undefined })).status).toBe(403);
      expect(await prisma.appPageJob.count()).toBe(0);
    });

    it('needs the service token', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      const response = await makeJob(request(`/api/bots/${brick}/key-apps/${serverId}/page-jobs`, { method: 'POST', body: { requesterKey: `sara-${tag}`, artifactId, amount: '1', currency: 'KWD' } }), params({ id: brick, serverId }));
      expect(response.status).toBe(401);
    });

    it('is refused for an app with no payment contract', async () => {
      const connection = await prisma.appConnection.create({ data: { ownerId: sara, name: 'Notes', serverUrl: 'https://mcp.example.com/mcp', authType: 'none', source: 'link' } });
      const grant = await prisma.botMcpServer.create({ data: { botId: brick, connectionId: connection.id, name: 'Notes', serverUrl: '', authType: 'none', connectedById: sara } });
      const artifactId = await makeArtifact();
      const response = await job(grant.id, artifactId);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('no_payments');
    });
  });

  /* ------------------------- the visitor's checkout ------------------------- */

  describe('a visitor starting a checkout', () => {
    it('makes the order first and sends only the owner’s terms, with the order as the idempotency key', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      const sent = gateway();
      const body = await checkout(artifactId);
      expect(body.checkoutUrl).toBe('https://checkout.examplepay.com/?mode=page&token=abc');
      const order = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: body.orderId } });
      expect(order).toMatchObject({ status: 'pending', amountMinor: 4500, currency: 'KWD', mode: 'test', providerRef: 'chg_TS01', ownerId: sara });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ host: 'api.examplepay.com', path: '/v2/charges', method: 'POST' });
      expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`);
      const payload = JSON.parse(sent[0].body as string);
      expect(payload).toMatchObject({ amount: 4.5, currency: 'KWD', description: 'A mug', reference: { order: order.id, idempotent: order.id }, post: { url: `https://orbit.example.org/api/app-pay/notice/${order.id}` }, redirect: { url: `https://orbit.example.org/pay/done?o=${order.id}` }, customer: { first_name: 'Customer' } });
    });

    it('takes no amount from the visitor', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      const sent = gateway();
      const response = await publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { amount: 0.001, currency: 'USD', shownVersion: 1 } }), params({ artifactId }));
      expect(response.status).toBe(200);
      expect(JSON.parse(sent[0].body as string)).toMatchObject({ amount: 4.5, currency: 'KWD' });
    });

    it('is only for a page anyone with the link may open', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact({ openScope: 'chat' });
      await job(serverId, artifactId);
      gateway();
      expect((await start(artifactId)).status).toBe(404);
      expect((await publicGet(request(`/api/pay/${artifactId}`), params({ artifactId }))).status).toBe(404);
      expect(await prisma.appPageOrder.count({ where: { ownerId: sara } })).toBe(0);
    });

    it('says whether a page takes payments, and nothing more', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      expect(await (await publicGet(request(`/api/pay/${artifactId}`), params({ artifactId }))).json()).toEqual({ enabled: false });
      await job(serverId, artifactId);
      expect(await (await publicGet(request(`/api/pay/${artifactId}`), params({ artifactId }))).json()).toEqual({ enabled: true });
    });

    it('does not send a buyer to a host the definition does not name', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      gateway({ create: { transaction: { url: 'https://checkout.evil.test/pay' } } });
      const response = await start(artifactId);
      expect(response.status).toBe(409);
      expect(await prisma.appPageOrder.findFirst({ where: { ownerId: sara } })).toMatchObject({ status: 'cant_confirm', checkoutUrl: null });
    });

    it('closes the order when the service does not answer well, and marks a refused key as stopped', async () => {
      const { id, serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      gateway({ createStatus: 401 });
      expect((await start(artifactId)).status).toBe(409);
      expect(await prisma.appPageOrder.findFirst({ where: { ownerId: sara } })).toMatchObject({ status: 'not_paid' });
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).not.toBeNull();
      // A mark never blocks the next visitor: the service is asked again, and a good answer clears the mark
      const sent = gateway();
      expect((await start(artifactId, '203.0.113.8')).status).toBe(200);
      expect(sent.length).toBeGreaterThan(0);
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
    });

    it('gives out no checkout address when the order was closed while the service was being asked', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      gateway();
      const answer = mockSend.current!;
      mockSend.current = async (target) => {
        // The order is closed (by a sweep, or by the owner stopping the page) after the charge was made and before it is kept
        await prisma.appPageOrder.updateMany({ where: { ownerId: sara }, data: { status: 'not_paid', closedAt: new Date() } });
        return answer(target);
      };
      const response = await start(artifactId);
      expect(response.status).toBe(409);
      expect(await response.json()).not.toHaveProperty('checkoutUrl');
      expect(await prisma.appPageOrder.findFirst({ where: { ownerId: sara } })).toMatchObject({ status: 'not_paid', checkoutUrl: null });
    });

    it('closes the order, never leaves it open, when the key cannot be read', async () => {
      const { id, serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      const sent = gateway();
      await prisma.appConnection.update({ where: { id }, data: { keyCipher: 'not-a-real-cipher' } });
      expect((await start(artifactId)).status).toBe(409);
      expect(sent).toHaveLength(0);
      expect(await prisma.appPageOrder.findMany({ where: { ownerId: sara }, select: { status: true } })).toEqual([{ status: 'not_paid' }]);
    });

    it('takes no payment with a key whose mode the app could not tell, and counts none for an order that has no mode', async () => {
      const { id, serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      const sent = gateway({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      await prisma.appPageOrder.update({ where: { id: orderId }, data: { mode: null } });
      expect(await settle(orderId)).toMatchObject({ status: 'cant_confirm' });
      expect(await notices()).toHaveLength(0);
      await prisma.appConnection.update({ where: { id }, data: { keyMode: null } });
      const before = sent.length;
      expect((await start(artifactId, '203.0.113.20')).status).toBe(409);
      expect(sent).toHaveLength(before);
    });

    it('clears the stopped mark when a lookup is answered well', async () => {
      const { id, serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      gateway();
      const { orderId } = await checkout(artifactId);
      await prisma.appConnection.update({ where: { id }, data: { signInLostAt: new Date() } });
      gateway({ record: (order) => paidRecord(order) });
      expect((await settle(orderId))?.status).toBe('paid');
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
    });

    it('writes a service that did not answer a checkout or a lookup on the App, never Orbit being busy, and a good answer clears it', async () => {
      const { id, serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      const noAnswerAt = async () => (await prisma.appConnection.findUniqueOrThrow({ where: { id } })).noAnswerAt;
      // Orbit had no room to try: nothing is written about the service
      mockSend.current = () => {
        throw new GuardError('unreachable', 'Too many name lookups are waiting', true);
      };
      expect((await start(artifactId)).status).toBe(409);
      expect(await noAnswerAt()).toBeNull();
      // The checkout got no answer: written
      mockSend.current = () => {
        throw new GuardError('timeout', 'no answer');
      };
      expect((await start(artifactId, '203.0.113.9')).status).toBe(409);
      expect(await noAnswerAt()).not.toBeNull();
      // A good checkout clears it
      gateway();
      const { orderId } = await checkout(artifactId, '203.0.113.10');
      expect(await noAnswerAt()).toBeNull();
      // A lookup that got no answer is written the same way, and a good one clears it
      await new Promise((resolve) => setTimeout(resolve, 5));
      mockSend.current = () => {
        throw new GuardError('unreachable', 'The service could not be reached');
      };
      await settle(orderId);
      expect(await noAnswerAt()).not.toBeNull();
      gateway({ record: (order) => paidRecord(order) });
      expect((await settle(orderId))?.status).toBe('paid');
      expect(await noAnswerAt()).toBeNull();
    });

    it('a refused lookup for one order does not stop other pages from taking payments', async () => {
      const { id, serverId } = await connectGateway();
      const first = await makeArtifact();
      const second = await makeArtifact();
      await job(serverId, first);
      await job(serverId, second);
      gateway();
      const { orderId } = await checkout(first);
      // The service refuses this one lookup (for example a charge it no longer shows this key)
      mockSend.current = () => ({ status: 403 });
      // The checkout's good call was a minute ago or more (a refusal right behind a recorded good call is not read as a loss)
      await prisma.appConnection.update({ where: { id }, data: { lastWorkedAt: new Date(Date.now() - 2 * 60_000) } });
      await settle(orderId);
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).not.toBeNull();
      // Another page still gets its checkout, which clears the mark
      gateway();
      expect((await start(second, '203.0.113.9')).status).toBe(200);
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
    });

    it('stops when the owner stops it, at once', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      const made = await (await job(serverId, artifactId)).json();
      gateway();
      mockUser.current = { id: sara };
      const stopped = await stopPage(request(`/api/me/apps/pages/${made.job.id}`, { method: 'DELETE' }), params({ jobId: made.job.id }));
      expect(stopped.status).toBe(200);
      expect((await start(artifactId)).status).toBe(409);
      expect(await prisma.appPageOrder.count({ where: { ownerId: sara } })).toBe(0);
    });

    it('lets only the owner stop it', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      const made = await (await job(serverId, artifactId)).json();
      mockUser.current = { id: omar };
      expect((await stopPage(request(`/api/me/apps/pages/${made.job.id}`, { method: 'DELETE' }), params({ jobId: made.job.id }))).status).toBe(404);
      expect((await prisma.appPageJob.findUniqueOrThrow({ where: { id: made.job.id } })).status).toBe('active');
    });

    it('does not use a definition that changed since the owner asked', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      await prisma.appPageJob.update({ where: { artifactId }, data: { definitionHash: 'f'.repeat(64) } });
      gateway();
      expect((await start(artifactId)).status).toBe(409);
    });

    it('counts tries per visitor, per page and per person, all from Limits', async () => {
      await saveServerLimits({ bricks: { checkoutsPerVisitor: 2, checkoutsPerPage: 3, checkoutsPerOwner: 100 } }, sara);
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      gateway();
      expect((await start(artifactId, '198.51.100.1')).status).toBe(200);
      expect((await start(artifactId, '198.51.100.1')).status).toBe(200);
      expect((await start(artifactId, '198.51.100.1')).status).toBe(429);
      expect((await start(artifactId, '198.51.100.2')).status).toBe(200);
      expect((await start(artifactId, '198.51.100.3')).status).toBe(429);
      await saveServerLimits({ bricks: { checkoutsPerPage: 100, checkoutsPerOwner: 3 } }, sara);
      expect((await start(artifactId, '198.51.100.9')).status).toBe(429);
    });

    it('never keeps who the visitor was, only a hash', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      gateway();
      const { orderId } = await checkout(artifactId, '203.0.113.99');
      const order = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(JSON.stringify(order)).not.toContain('203.0.113.99');
      expect(order.visitorHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('lets the game’s server start one for someone who may open the page, and no one else', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      gateway();
      const viewer = { person: { signedIn: true, identifier: `sara-${tag}` }, inChat: true, chat: { kind: 'dm', ref: `chat-${tag}` } };
      const call = (body: unknown, token: string | null = ADMIN_TOKEN) => gamePay(request(`/api/artifacts/${artifactId}/pay`, { method: 'POST', token: token ?? undefined, body }), params({ id: artifactId }));
      expect((await call({ viewer }, null)).status).toBe(401);
      expect((await call({ viewer }, SERVICE_TOKEN)).status).toBe(401);
      expect(await (await call({ viewer })).json()).toEqual({ enabled: true });
      const started = await call({ viewer, start: true, shownVersion: 1 });
      expect(started.status).toBe(200);
      const { orderId } = await started.json();
      expect((await (await call({ viewer, order: orderId })).json()).status).toBe('checking');
      // A person who may not open the page hears nothing about it (this one is shared with its chat, and they are not in it)
      await prisma.artifact.update({ where: { id: artifactId }, data: { openScope: 'chat' } });
      const stranger = { person: { signedIn: true, identifier: `omar-${tag}` }, inChat: false };
      expect((await call({ viewer: stranger, start: true, shownVersion: 1 })).status).toBe(404);
    });
  });

  /* ------------------------- terms set on a draft (GPT audit 26 Nov, O2) ------------------------- */

  describe('terms set on a version newer than the one the link shows', () => {
    /** A page with versions 1..latest, version `published` published (null: never), as the owner's drafts leave it. */
    async function pageWith(latest: number, published: number | null, openScope = 'link'): Promise<string> {
      const artifactId = await makeArtifact({ openScope });
      for (let number = 1; number <= latest; number++) await prisma.artifactVersion.create({ data: { artifactId, number, fileKey: `o2/${artifactId}/${number}.html`, sizeBytes: 10 } });
      await prisma.artifact.update({ where: { id: artifactId }, data: { latestVersion: latest, publishedVersion: published, publishedAt: published === null ? null : new Date(), publishedTitle: published === null ? null : 'Shop' } });
      return artifactId;
    }
    const publish = (artifactId: string, version: number) => prisma.artifact.update({ where: { id: artifactId }, data: { publishedVersion: version, publishedAt: new Date() } });
    /** A start from the game's window, open on version `shown` (what the viewer is shown: the latest for the owner, what was published for others). */
    const gameCall = (artifactId: string, viewer: unknown, shown: number) =>
      gamePay(request(`/api/artifacts/${artifactId}/pay`, { method: 'POST', token: ADMIN_TOKEN, body: { viewer, start: true, shownVersion: shown } }), params({ id: artifactId }));
    const outsider = { person: { signedIn: true, identifier: `omar-${tag}` }, inChat: false };
    const owner = { person: { signedIn: true, identifier: `sara-${tag}` }, inChat: false };
    const word = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const wish = () => `i${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    it('refuses a visitor of the published version 1 when the terms were set on draft version 2, charges nothing, and works once the owner publishes again', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await pageWith(2, 1);
      const made = await job(serverId, artifactId);
      expect(made.status).toBe(200);
      // The Brick is told the terms go live when the owner publishes
      expect(await made.json()).toMatchObject({ waitsForPublish: true });
      const sent = gateway();
      const refused = await start(artifactId);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: 'This page isn’t taking payments right now. Try again later', code: 'not_published' });
      // Nothing was made, nothing was sent to the service, nothing was counted
      expect(await prisma.appPageOrder.count({ where: { artifactId } })).toBe(0);
      expect(sent).toHaveLength(0);
      // The same through the game, for someone who sees only what was published
      const game = await gameCall(artifactId, outsider, 1);
      expect(game.status).toBe(409);
      expect(await game.json()).toMatchObject({ error: 'not_published' });
      expect(sent).toHaveLength(0);
      // The owner publishes version 2: the same visitor now checks out with the terms version 2 shows
      await publish(artifactId, 2);
      const body = await checkout(artifactId);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: body.orderId } })).amountMinor).toBe(4500);
      expect(sent).toHaveLength(1);
      // And the job read back no longer waits
      const read = await readJob(request(`/api/bots/${brick}/key-apps/${serverId}/page-jobs?artifactId=${artifactId}`, { token: SERVICE_TOKEN }), params({ id: brick, serverId }));
      expect(await read.json()).toMatchObject({ waitsForPublish: false });
    });

    it('lets the owner check out on the latest version in the game while visitors of the link wait', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await pageWith(2, 1);
      await job(serverId, artifactId);
      gateway();
      expect((await gameCall(artifactId, owner, 2)).status).toBe(200);
      expect((await start(artifactId, '203.0.113.20')).status).toBe(409);
    });

    it('does not wait on a page never published (its link shows the latest), nor on terms set on the published version', async () => {
      const { serverId } = await connectGateway();
      const never = await pageWith(2, null);
      expect(await (await job(serverId, never)).json()).toMatchObject({ waitsForPublish: false });
      const same = await pageWith(2, 2);
      expect(await (await job(serverId, same)).json()).toMatchObject({ waitsForPublish: false });
      gateway();
      expect((await start(never, '203.0.113.21')).status).toBe(200);
      expect((await start(same, '203.0.113.22')).status).toBe(200);
      // A draft made AFTER the terms keeps the terms on the published version: they were set on what visitors see
      await prisma.artifactVersion.create({ data: { artifactId: same, number: 3, fileKey: `o2/${same}/3.html`, sizeBytes: 10 } });
      await prisma.artifact.update({ where: { id: same }, data: { latestVersion: 3 } });
      expect((await start(same, '203.0.113.23')).status).toBe(200);
    });

    it('refuses when the owner publishes an older version again after setting the terms', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await pageWith(2, 2);
      await job(serverId, artifactId);
      gateway();
      expect((await start(artifactId, '203.0.113.24')).status).toBe(200);
      await publish(artifactId, 1);
      expect((await start(artifactId, '203.0.113.25')).status).toBe(409);
    });

    const startShown = (artifactId: string, shownVersion: number | undefined, address: string, extra: Record<string, unknown> = {}) =>
      publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { ...(shownVersion === undefined ? {} : { shownVersion }), ...extra }, headers: { 'x-forwarded-for': address } }), params({ artifactId }));

    it('never charges terms set on a newer version than the one the buyer’s open page shows, even once that version is published (CodeRabbit, 26 Nov)', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await pageWith(2, 2);
      await job(serverId, artifactId);
      const sent = gateway();
      // The buyer opened the page while version 1 was published; the owner then published version 2 with these terms
      const stale = await startShown(artifactId, 1, '203.0.113.30');
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: 'This page was updated. Reload it to see the latest version before you pay', code: 'page_changed' });
      expect(await prisma.appPageOrder.count({ where: { artifactId } })).toBe(0);
      expect(sent).toHaveLength(0);
      // The same through the game's window
      const game = await gamePay(request(`/api/artifacts/${artifactId}/pay`, { method: 'POST', token: ADMIN_TOKEN, body: { viewer: outsider, start: true, shownVersion: 1 } }), params({ id: artifactId }));
      expect(game.status).toBe(409);
      expect(await game.json()).toMatchObject({ error: 'page_changed' });
      expect(sent).toHaveLength(0);
      // After a reload the page shows version 2: it checks out
      expect((await startShown(artifactId, 2, '203.0.113.31')).status).toBe(200);
    });

    it('makes no new order for a page that does not say which version it shows, on either route, and a reload that says it checks out (CodeRabbit, 26 Nov)', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await pageWith(1, 1);
      await job(serverId, artifactId);
      const sent = gateway();
      const silent = await startShown(artifactId, undefined, '203.0.113.32', { intentId: wish(), recoveryCode: word() });
      expect(silent.status).toBe(409);
      expect(await silent.json()).toEqual({ error: 'This page was updated. Reload it to see the latest version before you pay', code: 'page_changed' });
      const game = await gamePay(request(`/api/artifacts/${artifactId}/pay`, { method: 'POST', token: ADMIN_TOKEN, body: { viewer: owner, start: true } }), params({ id: artifactId }));
      expect(game.status).toBe(409);
      expect(await game.json()).toMatchObject({ error: 'page_changed' });
      expect(await prisma.appPageOrder.count({ where: { artifactId } })).toBe(0);
      expect(sent).toHaveLength(0);
      expect((await startShown(artifactId, 1, '203.0.113.32', { intentId: wish(), recoveryCode: word() })).status).toBe(200);
    });

    it('lets a page still open on an older version pay with terms that were set on that version or before it', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await pageWith(1, 1);
      await job(serverId, artifactId);
      // Version 2 is published after the terms were set on version 1: the terms are the same for both
      await prisma.artifactVersion.create({ data: { artifactId, number: 2, fileKey: `o2/${artifactId}/2.html`, sizeBytes: 10 } });
      await prisma.artifact.update({ where: { id: artifactId }, data: { latestVersion: 2 } });
      await publish(artifactId, 2);
      gateway();
      expect((await startShown(artifactId, 1, '203.0.113.33')).status).toBe(200);
    });

    it('gives a wish the order it already made, not a refusal, when the terms moved to a draft while its first try was on its way (CodeRabbit, 26 Nov)', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await pageWith(1, 1);
      await job(serverId, artifactId);
      gateway();
      const intentId = wish();
      const code = word();
      const first = await startShown(artifactId, 1, '203.0.113.34', { intentId, recoveryCode: code });
      expect(first.status).toBe(200);
      const { orderId } = await first.json();
      // The owner sets terms on a draft version 2; the same wish asks again, and its first look misses the order (as when the first try had not committed yet)
      await prisma.artifactVersion.create({ data: { artifactId, number: 2, fileKey: `o2/${artifactId}/2.html`, sizeBytes: 10 } });
      await prisma.artifact.update({ where: { id: artifactId }, data: { latestVersion: 2 } });
      await job(serverId, artifactId);
      const look = jest.spyOn(prisma.appPageOrder, 'findFirst').mockResolvedValueOnce(null);
      try {
        const again = await startShown(artifactId, 1, '203.0.113.34', { intentId, recoveryCode: code });
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ orderId, reused: true });
      } finally {
        look.mockRestore();
      }
      expect(await prisma.appPageOrder.count({ where: { artifactId } })).toBe(1);
      // A new wish is refused: nothing new is made on terms the link does not show
      expect((await startShown(artifactId, 1, '203.0.113.35', { intentId: wish(), recoveryCode: code })).status).toBe(409);
    });

    it('still carries on an order made before the terms moved to a draft, at the order’s own amount', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await pageWith(1, 1);
      await job(serverId, artifactId);
      // The order's start never finished (the server stopped); then the owner made a draft and set the same terms on it
      const sent = gateway({ createStatus: 503 });
      const intentId = wish();
      const code = word();
      const first = await publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { intentId, recoveryCode: code, shownVersion: 1 }, headers: { 'x-forwarded-for': '203.0.113.26' } }), params({ artifactId }));
      expect(first.status).toBe(409);
      expect(await first.json()).toMatchObject({ unsure: true });
      await prisma.artifactVersion.create({ data: { artifactId, number: 2, fileKey: `o2/${artifactId}/2.html`, sizeBytes: 10 } });
      await prisma.artifact.update({ where: { id: artifactId }, data: { latestVersion: 2 } });
      await job(serverId, artifactId);
      // The same wish again finds its order and carries it on, never a refusal and never a second order. It needs no version: the order
      // already holds the terms its buyer was shown (an older host that never says one still gets its own order back)
      gateway();
      await prisma.appPageOrder.updateMany({ where: { artifactId }, data: { checkedAt: new Date(Date.now() - 3_600_000) } });
      const again = await publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { intentId, recoveryCode: code }, headers: { 'x-forwarded-for': '203.0.113.26' } }), params({ artifactId }));
      expect(again.status).toBe(200);
      expect(await prisma.appPageOrder.count({ where: { artifactId } })).toBe(1);
      expect(sent.length).toBeGreaterThan(0);
    });
  });

  /* ------------------------- is it paid ------------------------- */

  describe('deciding that it is paid', () => {
    it('writes paid only when the service’s own record says completed for this order, amount, currency and mode, and tells the owner once', async () => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'paid', testPayment: true, checkoutUrl: null });
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'paid' });
      await settle(orderId);
      await verifyOrder(orderId);
      const found = await notices();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ title: 'Test payment on Shop', badge: 'Test' });
      expect(found[0].body).toContain('4.500 KWD');
      expect(found[0].body).toContain('Example Pay confirmed it.');
      expect(found[0].body).toContain('The first one today.');
    });

    it('asks the service with the key, for that one payment, and nothing about it comes from the visitor', async () => {
      const { artifactId } = await pending();
      const sent = gateway({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      await settle(orderId);
      const look = sent[sent.length - 1];
      expect(look).toMatchObject({ method: 'GET', host: 'api.examplepay.com', path: '/v2/charges/chg_TS01' });
      expect(look.headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it.each([
      ['a different amount', { amount: 0.5 }],
      ['a different currency', { currency: 'USD' }],
      ['another order’s payment', { reference: { order: randomUUID() } }],
      ['a real payment for a test order', { live_mode: true }],
      ['a payment that does not say which mode it was made in', { live_mode: undefined }],
      ['no order reference', { reference: {} }],
    ])('does not count %s', async (_name, change) => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order, change) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'cant_confirm' });
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'cant_confirm', paidAt: null });
      expect(await notices()).toHaveLength(0);
    });

    it.each(['AUTHORIZED', 'INITIATED', 'IN_PROGRESS', 'SOMETHING_NEW'])('does not count %s, and keeps the order open', async (state) => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order, { status: state }) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'checking', checkoutUrl: 'https://checkout.examplepay.com/?mode=page&token=abc' });
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
      expect(await notices()).toHaveLength(0);
    });

    it.each(['DECLINED', 'CANCELLED', 'FAILED', 'ABANDONED', 'TIMEDOUT'])('closes the order at %s, and counts nothing', async (state) => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order, { status: state }) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'not_paid' });
      expect(await notices()).toHaveLength(0);
    });

    it('closes an order nobody paid after the open hours from Limits, but still counts a payment that completes late', async () => {
      await saveServerLimits({ bricks: { checkoutOpenHours: 1 } }, sara);
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const unpaid = await checkout(artifactId, '198.51.100.20');
      await prisma.appPageOrder.update({ where: { id: unpaid.orderId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      expect(await settle(unpaid.orderId)).toMatchObject({ status: 'not_paid' });
      const late = await checkout(artifactId, '198.51.100.21');
      gateway({ record: (order) => paidRecord(order) });
      await prisma.appPageOrder.update({ where: { id: late.orderId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      expect(await settle(late.orderId)).toMatchObject({ status: 'paid' });
    });

    it('N12 (d522f4b3 pass): an order that runs out of time closes AS OF when its open time ended, however late the first look is (a readable answer that is not final); an order the service declares failed closes at the look', async () => {
      await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const late = await checkout(artifactId, '198.51.100.40');
      const createdAt = new Date(Date.now() - 30 * 3_600_000);
      await prisma.appPageOrder.update({ where: { id: late.orderId }, data: { createdAt } });
      expect(await settle(late.orderId)).toMatchObject({ status: 'not_paid' });
      // The first look came 29 hours after the open time ended: the late window starts when the open time ended, not then
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: late.orderId } })).closedAt?.getTime()).toBe(createdAt.getTime() + 3_600_000);
      // CONTROL: a closing the service itself declared is dated by the look
      gateway({ record: (order) => paidRecord(order, { status: 'FAILED' }) });
      const failed = await checkout(artifactId, '198.51.100.41');
      await prisma.appPageOrder.update({ where: { id: failed.orderId }, data: { createdAt } });
      const before = Date.now();
      expect(await settle(failed.orderId)).toMatchObject({ status: 'not_paid' });
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: failed.orderId } })).closedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('closes an order whose look keeps failing once it has been open too long, so the buyer stops waiting, and still finds a late payment', async () => {
      await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const stuck = await checkout(artifactId, '198.51.100.30');
      // The service now refuses every look (a charge it no longer knows): within the open time this is only "asked again"
      mockSend.current = () => ({ status: 404, body: { error: 'not found' } });
      const waiting = await settle(stuck.orderId);
      expect(waiting).toMatchObject({ status: 'checking' });
      expect(isWaiting(waiting as never)).toBe(true);
      // Past the open time it ends, however the service answers: no look waits for ever
      await prisma.appPageOrder.update({ where: { id: stuck.orderId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      const ended = await settle(stuck.orderId);
      expect(ended).toMatchObject({ status: 'not_paid' });
      expect(isWaiting(ended as never)).toBe(false);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: stuck.orderId } })).closedAt).not.toBeNull();
      // Closed is not final: a payment that turns out to be real is still counted
      gateway({ record: (order) => paidRecord(order) });
      expect(await settle(stuck.orderId)).toMatchObject({ status: 'paid' });
    });

    describe('a payment that completes after the order was closed as not paid', () => {
      const closeByExpiry = async (artifactId: string, address: string) => {
        await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
        gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
        const order = await checkout(artifactId, address);
        await prisma.appPageOrder.update({ where: { id: order.orderId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
        expect(await settle(order.orderId)).toMatchObject({ status: 'not_paid' });
        return order.orderId;
      };

      it('is counted once, with one notice that says it came in late', async () => {
        const { artifactId } = await pending();
        const before = (await notices()).length;
        const orderId = await closeByExpiry(artifactId, '198.51.100.30');
        gateway({ record: (order) => paidRecord(order) });
        expect(await settle(orderId)).toMatchObject({ status: 'paid' });
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'paid' });
        await settle(orderId);
        const made = (await notices()).slice(before);
        expect(made).toHaveLength(1);
        expect(made[0].body).toContain('came in after the checkout had closed');
      });

      it('is counted once, with one notice, when two callers ask at the same moment', async () => {
        const { artifactId } = await pending();
        const before = (await notices()).length;
        const orderId = await closeByExpiry(artifactId, '198.51.100.31');
        gateway({ record: (order) => paidRecord(order) });
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * 3_600_000) } });
        await Promise.all([verifyOrder(orderId), notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body: { status: 'CAPTURED' } }), params({ orderId }))]);
        expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('paid');
        expect((await notices()).slice(before)).toHaveLength(1);
      });

      it('is never counted when the amount, currency or mode is not what was asked: it goes to cannot-confirm', async () => {
        const { artifactId } = await pending();
        const before = (await notices()).length;
        const orderId = await closeByExpiry(artifactId, '198.51.100.32');
        gateway({ record: (order) => paidRecord(order, { amount: 1 }) });
        expect(await settle(orderId)).toMatchObject({ status: 'cant_confirm' });
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'cant_confirm', paidAt: null });
        expect((await notices()).slice(before)).toHaveLength(0);
      });

      it('stays closed while the service still does not call it completed', async () => {
        const { artifactId } = await pending();
        const orderId = await closeByExpiry(artifactId, '198.51.100.33');
        gateway({ record: (order) => paidRecord(order, { status: 'FAILED' }) });
        expect(await settle(orderId)).toMatchObject({ status: 'not_paid', checkoutUrl: null });
        gateway({ record: (order) => paidRecord(order, { status: 'SOMETHING_NEW' }) });
        expect(await settle(orderId)).toMatchObject({ status: 'not_paid' });
      });

      it('is asked about again, slowly and with no end date, once it is older than the late-payment hours: a timeout alone is never "not paid"', async () => {
        const { artifactId } = await pending();
        const orderId = await closeByExpiry(artifactId, '198.51.100.34');
        // The window runs from when it was closed: closed more than the late hours ago, with the service never once read
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - 80 * 3_600_000), closedAt: new Date(Date.now() - 60 * 3_600_000), lastReadAt: null, nextLookAt: null } });
        // The service cannot be read for the whole window: nothing is learned, and the order is not given up on
        mockSend.current = () => ({ status: 503, body: {} });
        expect((await sweepPageOrders()).looked).toBe(1);
        const waiting = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } });
        expect(waiting).toMatchObject({ status: 'not_paid', reconciled: false, lastReadAt: null });
        // A look that could not be read is tried again soon, never at the week its age would give (one blip must not put a payment that may be real a week away)
        expect(waiting.nextLookAt!.getTime()).toBeGreaterThan(Date.now());
        expect(waiting.nextLookAt!.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5_000);
        const answer = await settle(orderId);
        expect(answer).toMatchObject({ status: 'not_paid' });
        // The page that refreshes itself is not told that no look will ever be made
        expect(checksHaveEnded(answer!)).toBe(false);
        // The queue shows it, with its age, so an order that keeps waiting is an alert
        expect((await pagePaymentLoad()).unconfirmed).toMatchObject({ count: 1, neverRead: 1 });
        expect((await pagePaymentLoad()).unconfirmed.oldestSeconds).toBeGreaterThan(70 * 3_600);
        // Its schedule is not due yet, so the next pass leaves it alone (a spaced order is not a look)
        const sent = gateway({ record: (order) => paidRecord(order) });
        expect((await sweepPageOrders()).looked).toBe(0);
        expect(sent).toHaveLength(0);
        // The service is readable again, and says it was paid: found once, as a late payment, with one notice
        const before = (await notices()).length;
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { nextLookAt: new Date(Date.now() - 1_000) } });
        expect((await sweepPageOrders()).moved).toBeGreaterThanOrEqual(1);
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'paid', reconciled: false });
        expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).lastReadAt).not.toBeNull();
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { nextLookAt: new Date(Date.now() - 1_000) } });
        await sweepPageOrders();
        await settle(orderId);
        expect((await notices()).slice(before)).toHaveLength(1);
        expect((await prisma.appPageOrderEvent.findMany({ where: { orderId, toStatus: 'paid' } })).map((line) => line.reason)).toEqual(['paid_late']);
        expect((await pagePaymentLoad()).unconfirmed.count).toBe(0);
      });

      it('an unclosed not-paid order older than the late window plus the open time is in the long wait: the sweep looks at it and the numbers count it (no order drops out for lacking a close time)', async () => {
        const { artifactId } = await pending();
        await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        const order = await prisma.appPageOrder.create({
          data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'not_paid', providerRef: 'chg_TS01', reconciled: false, closedAt: null, nextLookAt: null, visitorHash: 'v', intentId: `i-${randomUUID().slice(0, 8)}`, description: jobRow.description, createdAt: new Date(Date.now() - 100 * 3_600_000) },
        });
        gateway({ record: () => paidRecord(order.id) });
        expect((await pagePaymentLoad()).unconfirmed).toMatchObject({ count: 1 });
        const swept = await sweepPageOrders();
        expect(swept.looked).toBe(1);
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'paid' });
      });

      it('the long-wait pass of the sweep is planned on an index: the query the sweep runs can be answered from app_page_orders_reconciled_status_next_look_at_idx', async () => {
        class RollBack extends Error {
          constructor(readonly plan: string) {
            super('rolled back');
          }
        }
        const explain = async (dropOurs: boolean): Promise<string> => {
          try {
            await prisma.$transaction(async (tx) => {
              // A table this small is scanned whatever indexes it has, and which index the planner prefers on an empty table is not the question: whether an index CAN
              // answer this query is. So scans are turned off, the other two indexes that carry status are dropped (inside this transaction, which is rolled back), and what is left is asked
              await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
              await tx.$executeRawUnsafe('DROP INDEX app_page_orders_status_created_at_idx');
              await tx.$executeRawUnsafe('DROP INDEX app_page_orders_artifact_id_buyer_key_status_idx');
              if (dropOurs) await tx.$executeRawUnsafe('DROP INDEX app_page_orders_reconciled_status_next_look_at_idx');
              const plan = await tx.$queryRawUnsafe<Array<Record<string, string>>>(
                `EXPLAIN SELECT id FROM app_page_orders WHERE reconciled = false AND provider_ref IS NOT NULL AND (status = 'cant_confirm' OR (status = 'not_paid' AND closed_at < now() - interval '48 hours')) AND (next_look_at IS NULL OR next_look_at <= now()) ORDER BY next_look_at ASC NULLS FIRST, created_at ASC LIMIT 50`,
              );
              throw new RollBack(plan.map((line) => Object.values(line)[0]).join('\n'));
            });
          } catch (error) {
            if (error instanceof RollBack) return error.plan;
            throw error;
          }
          throw new Error('the plan was not read');
        };
        expect(await explain(false)).toContain('app_page_orders_reconciled_status_next_look_at_idx');
        // Without it, nothing can answer the query from an index
        expect(await explain(true)).not.toContain('Index');
        // The rolled-back drops left both in place
        const names = (await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(`SELECT indexname FROM pg_indexes WHERE tablename = 'app_page_orders'`)).map((row) => row.indexname);
        expect(names).toEqual(expect.arrayContaining(['app_page_orders_status_created_at_idx', 'app_page_orders_artifact_id_buyer_key_status_idx', 'app_page_orders_reconciled_status_next_look_at_idx']));
      });

      it('stops asking only when the service says the last word: a final failed state (and nothing is asked after it), or a payment for something else', async () => {
        const { artifactId } = await pending();
        const orderId = await closeByExpiry(artifactId, '198.51.100.36');
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - 80 * 3_600_000), closedAt: new Date(Date.now() - 60 * 3_600_000), reconciled: false, nextLookAt: null } });
        // A readable answer that is not final (still "started"): it stays in the long wait, with its next look moved on
        gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
        expect((await sweepPageOrders()).looked).toBe(1);
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'not_paid', reconciled: false });
        // The service names a final failed state: its last word. Nothing is asked after it
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { nextLookAt: null } });
        gateway({ record: (order) => paidRecord(order, { status: 'FAILED' }) });
        await sweepPageOrders();
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'not_paid', reconciled: true });
        const sent = gateway({ record: (order) => paidRecord(order) });
        const answer = await settle(orderId);
        expect(answer).toMatchObject({ status: 'not_paid' });
        expect(checksHaveEnded(answer!)).toBe(true);
        expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(0);
        // A payment for something else is for a person: it is not counted and nothing more is asked about it
        const other = await closeByExpiry(artifactId, '198.51.100.37');
        await prisma.appPageOrder.update({ where: { id: other }, data: { createdAt: new Date(Date.now() - 80 * 3_600_000), closedAt: new Date(Date.now() - 60 * 3_600_000), nextLookAt: null } });
        gateway({ record: (order) => paidRecord(order, { amount: 1 }) });
        await sweepPageOrders();
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: other } })).toMatchObject({ status: 'cant_confirm', reconciled: true, paidAt: null });
      });

      it('an order that could not be confirmed (its app was disconnected) goes on being asked about once the owner connects the app again, and a payment found there is counted once', async () => {
        const { id: firstConnection, serverId } = await connectGateway();
        const artifactId = await makeArtifact();
        await job(serverId, artifactId);
        gateway();
        const orderId = (await checkout(artifactId, '198.51.100.38')).orderId;
        const before = (await notices()).length;
        // The owner disconnects the app: the page's job goes, and the order is left with neither a connection nor a job
        await disconnect(sara, firstConnection);
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ connectionId: null, jobId: null });
        expect(await settle(orderId)).toMatchObject({ status: 'cant_confirm' });
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'cant_confirm', reconciled: false });
        // With no app, nothing can be asked: it waits (not given up on, not over), on its own schedule
        const sent = gateway({ record: (order) => paidRecord(order) });
        const waiting = await settle(orderId);
        expect(waiting).toMatchObject({ status: 'cant_confirm' });
        expect(checksHaveEnded(waiting!)).toBe(false);
        expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(0);
        // The owner connects the app again and sets the page up again: the payment is found, counted once, as a late one
        const again = await connectGateway();
        await job(again.serverId, artifactId);
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { nextLookAt: null, checkedAt: null } });
        await sweepPageOrders();
        await sweepPageOrders();
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'paid' });
        expect((await notices()).slice(before)).toHaveLength(1);
        expect(await prisma.appPageOrderEvent.count({ where: { orderId, toStatus: 'paid' } })).toBe(1);
      });

      it('a payment service other than the one that made the order never ends it: its failed, unknown or mismatching answer leaves the order in the long wait (no end, not reconciled, Check payment still asks); only a payment that matches in reference, amount and currency counts', async () => {
        // (1) An order closed past its late window whose app was then disconnected, and (2) one that could not be confirmed: both asked about through the page's NEW app
        const first = await pending();
        const closed = await closeByExpiry(first.artifactId, '198.51.100.60');
        await prisma.appPageOrder.update({ where: { id: closed }, data: { createdAt: new Date(Date.now() - 80 * 3_600_000), closedAt: new Date(Date.now() - 60 * 3_600_000), reconciled: false, nextLookAt: null } });
        gateway();
        const unconfirmed = (await checkout(first.artifactId, '198.51.100.61')).orderId;
        await disconnect(sara, first.connectionId);
        expect(await settle(unconfirmed)).toMatchObject({ status: 'cant_confirm' });
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: closed } })).toMatchObject({ connectionId: null });
        const again = await connectGateway();
        await job(again.serverId, first.artifactId);
        const stands = async () => {
          for (const id of [closed, unconfirmed]) {
            expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: id === closed ? 'not_paid' : 'cant_confirm', reconciled: false, paidAt: null });
          }
          expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: closed } })).closedAt?.getTime()).toBeLessThan(Date.now() - 59 * 3_600_000);
          expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: unconfirmed } })).closedAt).toBeNull();
        };
        const lookAgain = () => prisma.appPageOrder.updateMany({ where: { id: { in: [closed, unconfirmed] } }, data: { nextLookAt: null, checkedAt: null } });
        for (const record of [{ status: 'FAILED' }, { status: 'INITIATED' }, { status: 'CAPTURED', amount: 1 }, { status: 'CAPTURED', currency: 'USD' }, { status: 'CAPTURED', reference: { order: 'someone-elses' } }]) {
          await lookAgain();
          gateway({ record: (order) => paidRecord(order, record) });
          await sweepPageOrders();
          await stands();
        }
        // Check payment still asks it, and still ends nothing
        await lookAgain();
        gateway({ record: (order) => paidRecord(order, { status: 'FAILED' }) });
        expect(await verifyOrder(unconfirmed, {}, undefined, { explicit: true })).toMatchObject({ status: 'cant_confirm' });
        await stands();
        // A payment that matches in reference, amount and currency is found, counted once, as a late one
        // (the fake gateway names the order it was last asked to make: each order is the one looked at in turn)
        for (const id of [closed, unconfirmed]) {
          await lookAgain();
          await prisma.appPageOrder.updateMany({ where: { id: id === closed ? unconfirmed : closed }, data: { nextLookAt: new Date(Date.now() + 3_600_000) } });
          gateway({ record: (order) => paidRecord(order) });
          lastOrder = id;
          await sweepPageOrders();
          expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'paid' });
        }
        expect(await prisma.appPageOrderEvent.count({ where: { orderId: { in: [closed, unconfirmed] }, toStatus: 'paid' } })).toBe(2);
      });

      it('an order that could not be confirmed, and can be read again while its time lasts, goes on as open', async () => {
        const { artifactId } = await pending();
        gateway();
        const orderId = (await checkout(artifactId, '198.51.100.39')).orderId;
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { status: 'cant_confirm', checkedAt: null } });
        gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
        expect(await verifyOrder(orderId)).toMatchObject({ status: 'checking' });
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'pending', reconciled: false });
      });

      it('still asks again while it is inside the late-payment hours, and says checks go on', async () => {
        const { artifactId } = await pending();
        const orderId = await closeByExpiry(artifactId, '198.51.100.35');
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { closedAt: new Date(Date.now() - 3_600_000) } });
        gateway({ record: (order) => paidRecord(order, { status: 'FAILED' }) });
        const answer = await settle(orderId);
        expect(answer).toMatchObject({ status: 'not_paid' });
        expect(checksHaveEnded(answer!)).toBe(false);
      });
    });

    it('asks the service at most once in the seconds from Limits, however often it is asked', async () => {
      const { artifactId } = await pending();
      const sent = gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId);
      await Promise.all(Array.from({ length: 8 }, () => verifyOrder(orderId)));
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(1);
    });

    it('marks it paid once and tells once when the notice and the page both ask at the same moment', async () => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      await Promise.all([verifyOrder(orderId), notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body: { status: 'CAPTURED' } }), params({ orderId })), orderForArtifact(orderId, artifactId)]);
      await settle(orderId);
      expect(await notices()).toHaveLength(1);
    });

    it('believes nothing in a notice: it only asks the service, and always answers 200', async () => {
      const { artifactId } = await pending();
      const sent = gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId);
      const response = await notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body: { id: 'chg_TS01', status: 'CAPTURED', amount: 4.5, currency: 'KWD' } }), params({ orderId }));
      expect(response.status).toBe(200);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(1);
      for (const odd of ['not-an-id', randomUUID(), "'; drop table app_page_orders;--"]) {
        expect((await notice(request(`/api/app-pay/notice/${encodeURIComponent(odd)}`, { method: 'POST' }), params({ orderId: odd }))).status).toBe(200);
      }
    });

    it('does not answer an order on a page it was not made for', async () => {
      const { artifactId } = await pending();
      gateway();
      const { orderId } = await checkout(artifactId);
      const other = await makeArtifact();
      expect((await publicGet(request(`/api/pay/${other}?order=${orderId}`), params({ artifactId: other }))).status).toBe(404);
      const own = await publicGet(request(`/api/pay/${artifactId}?order=${orderId}`), params({ artifactId }));
      expect(await own.json()).toEqual({ status: 'checking', checkoutUrl: 'https://checkout.examplepay.com/?mode=page&token=abc', testPayment: true, orderId, pollAfterMs: 3_000 });
    });

    it('tells a real payment from a test one in what the owner reads', async () => {
      const form = await openKeyForm({ ownerId: sara, service: 'examplepay' });
      const live = `sk_live_${randomUUID().replace(/-/g, '')}`;
      const { id } = await submitKey({ requestId: form.id, ownerId: sara, key: live }, okCheck);
      const grant = await prisma.botMcpServer.findFirstOrThrow({ where: { botId: brick, connectionId: id } });
      const artifactId = await makeArtifact();
      await job(grant.id, artifactId);
      gateway({ record: (order) => paidRecord(order, { live_mode: true }) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'paid', testPayment: false });
      const [found] = await notices();
      expect(found.title).toBe('Someone just paid on Shop');
      expect(found.body).not.toContain('test');
    });

    it('does not trust a payment whose app was disconnected: the order can no longer be confirmed', async () => {
      const { artifactId, connectionId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      expect(await disconnect(sara, connectionId)).toBe(true);
      // The job goes with the app; the order stays, with nothing left to ask
      expect(await prisma.appPageJob.count({ where: { artifactId } })).toBe(0);
      expect(await settle(orderId)).toMatchObject({ status: 'cant_confirm' });
      expect(await notices()).toHaveLength(0);
      expect((await start(artifactId)).status).toBe(409);
    });

    it('still counts a payment for an order begun before the app definition changed (a new key after a deploy)', async () => {
      const { artifactId, connectionId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      // A new catalog entry after a deploy: a valid definition with a new hash
      const before = await prisma.appConnection.findUniqueOrThrow({ where: { id: connectionId } });
      const changed = { ...(before.definition as Record<string, unknown>), keyHint: 'Your test key starts with sk_test' } as never;
      await prisma.appConnection.update({ where: { id: connectionId }, data: { definition: changed, definitionHash: hashDefinition(definitionSchema.parse(changed)) } });
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: connectionId } })).definitionHash).not.toBe(before.definitionHash);
      expect(await settle(orderId)).toMatchObject({ status: 'paid' });
      expect(await notices()).toHaveLength(1);
    });

    it('still checks an order that was open when the owner stopped payments', async () => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      const row = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      mockUser.current = { id: sara };
      await stopPage(request(`/api/me/apps/pages/${row.id}`, { method: 'DELETE' }), params({ jobId: row.id }));
      expect(await settle(orderId)).toMatchObject({ status: 'paid' });
    });

    it('treats a key the service refuses as "still checking", never as paid or unpaid', async () => {
      const { artifactId, connectionId } = await pending();
      gateway();
      const { orderId } = await checkout(artifactId);
      mockSend.current = () => ({ status: 401, body: { errors: [{ code: '1103' }] } });
      await prisma.appConnection.update({ where: { id: connectionId }, data: { lastWorkedAt: new Date(Date.now() - 2 * 60_000) } });
      expect(await settle(orderId)).toMatchObject({ status: 'checking' });
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: connectionId } })).signInLostAt).not.toBeNull();
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
    });

    it('never puts the key in anything kept about the order', async () => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      await settle(orderId);
      const everything = JSON.stringify([await prisma.appPageOrder.findMany({ where: { ownerId: sara } }), await prisma.appPageJob.findMany({ where: { ownerId: sara } }), await notices()]);
      expect(everything).not.toContain(KEY);
    });

    it('lists the owner’s pages with what each has taken, and only theirs', async () => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const first = await checkout(artifactId, '198.51.100.30');
      await settle(first.orderId);
      await checkout(artifactId, '198.51.100.31');
      mockUser.current = { id: sara };
      const mine = await (await listPages(request('/api/me/apps/pages'))).json();
      expect(mine.pages).toHaveLength(1);
      expect(mine.pages[0]).toMatchObject({ title: 'Shop', amount: '4.500', currency: 'KWD', paid: 1, open: 1, status: 'active' });
      mockUser.current = { id: omar };
      expect((await (await listPages(request('/api/me/apps/pages'))).json()).pages).toEqual([]);
    });

    it('is rate-limited per platform', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 1 } }, sara);
      const { artifactId } = await pending();
      gateway();
      expect((await startCheckout({ artifactId, visitor: 'one', shownVersion: 1 })).status).toBe('ok');
      expect((await startCheckout({ artifactId, visitor: 'two', shownVersion: 1 })).status).toBe('limit');
    });
  });

  describe('the platform’s limit', () => {
    it('is counted by one checkout at a time across every owner, so two at the same moment cannot both take the last place', async () => {
      const { artifactId } = await pending();
      gateway();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const taken = new Promise<void>((resolve) => (locked = resolve));
      // Another owner's checkout is in the middle of counting and writing its order
      const other = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('page-orders:platform', 0))`;
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await taken;
      let finished = false;
      const mine = startCheckout({ artifactId, visitor: 'one', shownVersion: 1 }).then((outcome) => ((finished = true), outcome));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
      release();
      await other;
      expect((await mine).status).toBe('ok');
    });

    it('never counts a Brick\'s use of its owner\'s own key: a busy hour of key calls leaves every place to checkouts', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 1 } }, sara);
      const { artifactId } = await pending();
      const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      await prisma.appKeyCall.createMany({
        data: Array.from({ length: 5 }, (_, index) => ({ connectionId: jobRow.connectionId, ownerId: sara, botId: brick, callId: `busy-${tag}-${index}`, operation: 'x', state: 'done', outcome: 'ok' })),
      });
      gateway();
      expect((await startCheckout({ artifactId, visitor: 'one', shownVersion: 1 })).status).toBe('ok');
    });

    it('does not wait for a Brick\'s key call: checkouts and own-key calls share no lock and no count', async () => {
      const { artifactId } = await pending();
      gateway();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const taken = new Promise<void>((resolve) => (locked = resolve));
      // A key call (lib/app-direct/use.ts) is in the middle of writing its row, under the only lock it takes (its owner's)
      const call = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`key-calls:${sara}`}, 0))`;
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await taken;
      try {
        expect((await startCheckout({ artifactId, visitor: 'one', shownVersion: 1 })).status).toBe('ok');
      } finally {
        release();
        await call;
      }
    });
  });

  describe('the platform’s limit, orders and own-key uses apart', () => {
    it('never lets a committed order take room from a Brick\'s use of its owner\'s own key', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 1 } }, sara);
      const { artifactId, serverId } = await (async () => {
        const gate = await connectGateway();
        const artifact = await makeArtifact();
        await job(gate.serverId, artifact);
        return { artifactId: artifact, serverId: gate.serverId };
      })();
      gateway();
      expect((await startCheckout({ artifactId, visitor: 'one', shownVersion: 1 })).status).toBe('ok');
      const [app] = await keyAppsOf(brick);
      const deps = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async () => ({ status: 200, redirected: false, body: '{"id":"chg_9","status":"INITIATED"}', truncated: false, contentType: null }) };
      // The order took the checkouts' one place: the Brick's own-key use is not counted against it and is sent
      const outcome = await runKeyApp({ botId: brick, serverId, requesterKey: `sara-${tag}`, callId: `use-${tag}`, operation: 'lookUpPayment', arguments: { chargeId: 'chg_9' }, definitionHash: app.definitionHash }, deps);
      expect(outcome).toMatchObject({ status: 'done', ok: true, httpStatus: 200 });
    });

    it('two checkouts of different owners at the same moment for the last place: one is made, the other is over the limit, and one order is written', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 1 } }, sara);
      const first = await pending();
      // Omar has his own app and page (made in the rows, since the Brick that grants an app is Sara's)
      const form = await openKeyForm({ ownerId: omar, service: 'examplepay' });
      const omarsApp = await submitKey({ requestId: form.id, ownerId: omar, key: KEY }, okCheck);
      const omarsArtifact = await makeArtifact({ ownerId: omar });
      const saraJob = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId: first.artifactId } });
      const { id: _drop, createdAt: _created, updatedAt: _updated, ...rest } = saraJob as typeof saraJob & { updatedAt?: Date };
      void _drop;
      void _created;
      void _updated;
      const omarConnection = await prisma.appConnection.findUniqueOrThrow({ where: { id: omarsApp.id } });
      await prisma.appPageJob.create({ data: { ...rest, ownerId: omar, connectionId: omarsApp.id, artifactId: omarsArtifact, definitionHash: omarConnection.definitionHash ?? rest.definitionHash } as never });
      gateway();
      const [one, two] = await Promise.all([startCheckout({ artifactId: first.artifactId, visitor: 'a', shownVersion: 1 }), startCheckout({ artifactId: omarsArtifact, visitor: 'b', shownVersion: 1 })]);
      expect([one.status, two.status].sort()).toEqual(['limit', 'ok']);
      expect(await prisma.appPageOrder.count({ where: { ownerId: { in: [sara, omar] } } })).toBe(1);
    });
  });

  describe('after the review of the first version', () => {
    it('measures the late-payment window from when the order was closed, not from when it was made', async () => {
      const { artifactId } = await pending();
      await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
      gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const order = await checkout(artifactId, '198.51.100.50');
      // Made 60 hours ago, and only now found to have run out of time: still a day and a half to come in
      await prisma.appPageOrder.update({ where: { id: order.orderId }, data: { createdAt: new Date(Date.now() - 60 * 3_600_000) } });
      expect(await settle(order.orderId)).toMatchObject({ status: 'not_paid' });
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: order.orderId } })).closedAt).not.toBeNull();
      gateway({ record: (id) => paidRecord(id) });
      expect(await settle(order.orderId)).toMatchObject({ status: 'paid' });
    });

    it('keeps an order whose start never finished while an order may stay open, then ends it, instead of leaving it checking for ever', async () => {
      const { artifactId } = await pending();
      const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      const stuck = await prisma.appPageOrder.create({
        data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, status: 'creating', visitorHash: 'v', createdAt: new Date(Date.now() - 3_600_000) },
      });
      const fresh = await prisma.appPageOrder.create({
        data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, status: 'creating', visitorHash: 'v2' },
      });
      expect(await verifyOrder(fresh.id)).toMatchObject({ status: 'checking' });
      // An hour old: the same wish asked again can still carry it on, so it is not ended yet
      expect(await verifyOrder(stuck.id)).toMatchObject({ status: 'checking' });
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('creating');
      // Past the open time (24 hours by default) it ends, as not paid, with a line of history
      const createdLong = new Date(Date.now() - 25 * 3_600_000);
      await prisma.appPageOrder.update({ where: { id: stuck.id }, data: { createdAt: createdLong } });
      expect(await verifyOrder(stuck.id)).toMatchObject({ status: 'not_paid' });
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: 'not_paid', paidAt: null });
      // It closes AS OF when its open time ended (created + 24 hours), not at the look: the late window starts there (Opus on 14c4e407)
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: stuck.id } })).closedAt?.getTime()).toBe(createdLong.getTime() + 24 * 3_600_000);
      expect(await prisma.appPageOrderEvent.findMany({ where: { orderId: stuck.id }, select: { fromStatus: true, toStatus: true, reason: true } })).toEqual([{ fromStatus: 'creating', toStatus: 'not_paid', reason: 'start_never_finished' }]);
    });

    it('never keeps or gives out a checkout address that carries the key', async () => {
      const { artifactId } = await pending();
      gateway({ create: { transaction: { url: `https://checkout.examplepay.com/?mode=page&token=${KEY}` } } });
      const response = await start(artifactId, '198.51.100.51');
      expect(response.status).toBe(409);
      expect(JSON.stringify(await response.json())).not.toContain(KEY);
      const order = await prisma.appPageOrder.findFirstOrThrow({ where: { artifactId } });
      expect(order).toMatchObject({ status: 'cant_confirm', checkoutUrl: null });
      // Percent-encoded is the same key
      gateway({ create: { transaction: { url: `https://checkout.examplepay.com/?t=${'%73' + KEY.slice(1)}` } } });
      expect((await start(artifactId, '198.51.100.52')).status).toBe(409);
    });

    it('also refuses an address with a stray percent sign beside a partly encoded key', async () => {
      const { artifactId } = await pending();
      // A "%" that cannot be decoded must not hide a key that is partly encoded
      gateway({ create: { transaction: { url: `https://checkout.examplepay.com/?t=${'%73' + KEY.slice(1)}&x=%` } } });
      const response = await start(artifactId, '198.51.100.56');
      expect(response.status).toBe(409);
      expect(JSON.stringify(await response.json())).not.toContain(KEY);
      expect(await prisma.appPageOrder.findFirstOrThrow({ where: { artifactId } })).toMatchObject({ status: 'cant_confirm', checkoutUrl: null });
    });

    it('answers a notice with a request to come back when the service could not be asked, and waits for it', async () => {
      const { artifactId } = await pending();
      gateway();
      const { orderId } = await checkout(artifactId, '198.51.100.57');
      const ask = () => notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body: { status: 'CAPTURED' } }), params({ orderId }));
      const old = () => prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * 3_600_000) } });
      // The service is down
      mockSend.current = () => ({ status: 503, body: {} });
      await old();
      const down = await ask();
      expect(down.status).toBe(429);
      expect(Number(down.headers.get('retry-after'))).toBeGreaterThan(0);
      // Redirected: the key is never followed anywhere
      mockSend.current = () => ({ status: 200, redirected: true, body: {} });
      await old();
      expect((await ask()).status).toBe(429);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
      // When it is back, the same notice is answered and the order is paid
      gateway({ record: (order) => paidRecord(order) });
      await old();
      expect((await ask()).status).toBe(200);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('paid');
    });

    it('asks the service to come back for a notice it could not use: an order still being made, a database error, an answer with no state', async () => {
      const { artifactId } = await pending();
      gateway();
      const { orderId } = await checkout(artifactId, '198.51.100.68');
      const ask = (id = orderId) => notice(request(`/api/app-pay/notice/${id}`, { method: 'POST', body: { status: 'CAPTURED' } }), params({ orderId: id }));
      const old = () => prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * 3_600_000) } });
      // An answer that names no state is not an answer
      mockSend.current = () => ({ status: 200, body: { id: 'chg_TS01' } });
      await old();
      const nothing = await ask();
      expect(nothing.status).toBe(429);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
      // Our own failure is not "handled" either
      const failing = jest.spyOn(prisma.appPageOrder, 'findUnique').mockRejectedValueOnce(new Error('database is down'));
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const broken = await ask();
        expect(broken.status).toBe(503);
        expect(Number(broken.headers.get('retry-after'))).toBeGreaterThan(0);
      } finally {
        failing.mockRestore();
        quiet.mockRestore();
      }
      // An order whose start is not finished: the notice may be the only one the service sends
      const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      const starting = await prisma.appPageOrder.create({
        data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, status: 'creating', visitorHash: 'v3' },
      });
      expect((await ask(starting.id)).status).toBe(429);
      // A notice for an order that is not there is nothing to come back for
      expect((await ask('00000000-0000-4000-8000-000000000000')).status).toBe(200);
    });

    it('takes the app the page is on when the lock is taken, not the one read before it', async () => {
      const { id: firstId, serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      expect((await job(serverId, artifactId)).status).toBe(200);
      // A second app that can take the same payments, as when the owner moves the page onto another connection
      const original = await prisma.appConnection.findUniqueOrThrow({ where: { id: firstId } });
      const { id: _id, createdAt: _created, updatedAt: _updated, ...scalars } = original;
      void _id;
      void _created;
      void _updated;
      const second = await prisma.appConnection.create({ data: { ...scalars, name: 'Second account', catalogKey: `direct:second-${tag}` } as never });
      gateway();
      const real = prisma.$transaction.bind(prisma);
      const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: unknown, ...rest: unknown[]) => {
        return (async () => {
          // Between the first read and the lock the page moves to the second app
          await prisma.appPageJob.update({ where: { artifactId }, data: { connectionId: second.id } });
          return (real as (...args: unknown[]) => Promise<unknown>)(fn, ...rest);
        })();
      }) as never);
      try {
        const { orderId } = await checkout(artifactId, '198.51.100.58');
        const order = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } });
        // The order is on the app the locked job pointed to, and the request went out with that app's key mode
        expect(order.connectionId).toBe(second.id);
        expect(order.mode).toBe(second.keyMode);
      } finally {
        spy.mockRestore();
      }
    });

    it('holds the lock on the app the locked job names: a key replacement there waits until the order is written, the other app is free', async () => {
      const { id: firstId, serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      expect((await job(serverId, artifactId)).status).toBe(200);
      const original = await prisma.appConnection.findUniqueOrThrow({ where: { id: firstId } });
      const { id: _id, createdAt: _created, updatedAt: _updated, ...scalars } = original;
      void _id;
      void _created;
      void _updated;
      const second = await prisma.appConnection.create({ data: { ...scalars, name: 'Second account', catalogKey: `direct:locked-${tag}` } as never });
      gateway();
      const touch = (id: string) => prisma.$executeRaw`UPDATE "app_connections" SET "name" = "name" WHERE "id" = ${id}`;
      const seen = { secondWaited: false, firstFree: false };
      let replaced: Promise<unknown> = Promise.resolve();
      let replacedDone = false;
      const real = prisma.$transaction.bind(prisma);
      const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
        return (async () => {
          // Between the first read and the lock the page moves to the second app
          await prisma.appPageJob.update({ where: { artifactId }, data: { connectionId: second.id } });
          const wrap = (tx: Record<string, unknown>) =>
            new Proxy(tx, {
              get(target, property) {
                const value = Reflect.get(target, property) as unknown;
                if (property === 'appPageOrder') {
                  return new Proxy(value as Record<string, unknown>, {
                    get(model, name) {
                      const inner = Reflect.get(model, name) as (...args: unknown[]) => unknown;
                      if (name !== 'create') return typeof inner === 'function' ? inner.bind(model) : inner;
                      // The order is about to be written, so the locks are held now: try to replace the key on each app
                      return async (...args: unknown[]) => {
                        replaced = touch(second.id).then(() => {
                          replacedDone = true;
                        });
                        await touch(firstId);
                        seen.firstFree = true;
                        await new Promise((resolve) => setTimeout(resolve, 400));
                        seen.secondWaited = !replacedDone;
                        return inner.apply(model, args);
                      };
                    },
                  });
                }
                return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
              },
            });
          return (real as (...args: unknown[]) => Promise<unknown>)((tx: Record<string, unknown>) => fn(wrap(tx)), ...rest);
        })();
      }) as never);
      try {
        const { orderId } = await checkout(artifactId, '198.51.100.69');
        await replaced;
        expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).connectionId).toBe(second.id);
        // The app the page was on when the lock was taken was held; the one it had left was not
        expect(seen).toEqual({ secondWaited: true, firstFree: true });
      } finally {
        spy.mockRestore();
      }
    });

    describe('what a service insists on is said when the page is set up', () => {
      /** Changes the create operation of the connected service, and the job-making that follows sees the new definition. */
      async function connectChanged(change: (operation: { params: { name: string; required?: boolean; oneOf?: string[] }[] }) => void) {
        const { id: connectionId, serverId } = await connectGateway();
        const before = await prisma.appConnection.findUniqueOrThrow({ where: { id: connectionId } });
        const definition = JSON.parse(JSON.stringify(before.definition)) as { operations: { id: string; params: { name: string; required?: boolean; oneOf?: string[] }[] }[] };
        change(definition.operations.find((operation) => operation.id === 'makePaymentLink')!);
        const hash = hashDefinition(definitionSchema.parse(definition));
        await prisma.appConnection.update({ where: { id: connectionId }, data: { definition: definition as never, definitionHash: hash } });
        return serverId;
      }

      it('refuses a page with no description when the service insists on one, and accepts it with one', async () => {
        const serverId = await connectChanged((operation) => {
          operation.params.find((param) => param.name === 'description')!.required = true;
        });
        const artifactId = await makeArtifact();
        const refused = await job(serverId, artifactId, { description: '' });
        expect(refused.status).toBe(400);
        expect(JSON.stringify(await refused.json())).toContain('description');
        expect(await prisma.appPageJob.count({ where: { artifactId } })).toBe(0);
        expect((await job(serverId, artifactId, { description: 'A mug' })).status).toBe(200);
      });

      it('refuses a currency the service does not take, and accepts one it does', async () => {
        const serverId = await connectChanged((operation) => {
          const field = operation.params.find((param) => param.name === 'currency')!;
          field.oneOf = ['USD'];
        });
        const artifactId = await makeArtifact();
        const refused = await job(serverId, artifactId, { currency: 'KWD' });
        expect(refused.status).toBe(400);
        expect(JSON.stringify(await refused.json())).toContain('USD');
        expect((await job(serverId, artifactId, { currency: 'USD', amount: '4.50' })).status).toBe(200);
      });
    });

    describe('the owner’s words in the service’s description field', () => {
      type Op = { id: string; params: { name: string; type: string; maxLength?: number; oneOf?: string[] }[]; body?: Record<string, unknown> };
      /** Starts a checkout on a service whose create operation was changed by `change`, and answers what was sent to it. */
      async function sentWith(description: string, change: (operation: Op) => void, address: string): Promise<Record<string, unknown>> {
        const { id: connectionId, serverId } = await connectGateway();
        const artifactId = await makeArtifact();
        expect((await job(serverId, artifactId, { description })).status).toBe(200);
        const before = await prisma.appConnection.findUniqueOrThrow({ where: { id: connectionId } });
        const definition = JSON.parse(JSON.stringify(before.definition)) as { operations: Op[] };
        change(definition.operations.find((operation) => operation.id === 'makePaymentLink')!);
        const hash = hashDefinition(definitionSchema.parse(definition));
        await prisma.appConnection.update({ where: { id: connectionId }, data: { definition: definition as never, definitionHash: hash } });
        await prisma.appPageJob.update({ where: { artifactId }, data: { definitionHash: hash } });
        const sent = gateway();
        await checkout(artifactId, address);
        return JSON.parse(sent.find((entry) => entry.method === 'POST')!.body ?? '{}');
      }
      const limit = (maxLength: number) => (operation: Op) => {
        operation.params.find((param) => param.name === 'description')!.maxLength = maxLength;
      };

      it('cuts words longer than the limit, and leaves words of exactly the limit alone', async () => {
        expect(await sentWith('A mug with a very long name', limit(5), '198.51.100.60')).toMatchObject({ description: 'A mug' });
        expect(await sentWith('A mug', limit(5), '198.51.100.61')).toMatchObject({ description: 'A mug' });
      });

      it('never cuts in the middle of a character, and never goes over the limit', async () => {
        // Each of these is two units long: a limit of 5 holds two of them, not two and half
        const body = await sentWith('😀😀😀😀', limit(5), '198.51.100.62');
        expect(body.description).toBe('😀😀');
      });

      it('trims the words, and leaves them out when nothing is left', async () => {
        expect(await sentWith('   A mug   ', limit(50), '198.51.100.63')).toMatchObject({ description: 'A mug' });
        const empty = await sentWith('   ', limit(50), '198.51.100.64');
        expect(empty).not.toHaveProperty('description');
      });

      it('leaves them out for a field that is not text or only takes set values', async () => {
        const numeric = await sentWith(
          'A mug',
          (operation) => {
            operation.params.find((param) => param.name === 'description')!.type = 'number';
            delete (operation.params.find((param) => param.name === 'description') as { maxLength?: number }).maxLength;
          },
          '198.51.100.65',
        );
        expect(numeric).not.toHaveProperty('description');
        const fixed = await sentWith(
          'A mug',
          (operation) => {
            operation.params.find((param) => param.name === 'description')!.oneOf = ['Gift', 'Order'];
          },
          '198.51.100.66',
        );
        expect(fixed).not.toHaveProperty('description');
      });

      it('leaves them out when the service has no description field', async () => {
        const body = await sentWith(
          'A mug',
          (operation) => {
            operation.params = operation.params.filter((param) => param.name !== 'description');
            const template = operation.body as Record<string, unknown>;
            delete template.description;
          },
          '198.51.100.67',
        );
        expect(body).not.toHaveProperty('description');
      });
    });

    it('sends the currency the way the service lists it when the service lists its currencies in lower case', async () => {
      const body = await (async () => {
        const { id: connectionId, serverId } = await connectGateway();
        const artifactId = await makeArtifact();
        expect((await job(serverId, artifactId, { currency: 'USD', amount: '4.50' })).status).toBe(200);
        const before = await prisma.appConnection.findUniqueOrThrow({ where: { id: connectionId } });
        const definition = JSON.parse(JSON.stringify(before.definition)) as { operations: { id: string; params: { name: string; oneOf?: string[] }[] }[] };
        definition.operations.find((operation) => operation.id === 'makePaymentLink')!.params.find((param) => param.name === 'currency')!.oneOf = ['usd', 'kwd'];
        const hash = hashDefinition(definitionSchema.parse(definition));
        await prisma.appConnection.update({ where: { id: connectionId }, data: { definition: definition as never, definitionHash: hash } });
        await prisma.appPageJob.update({ where: { artifactId }, data: { definitionHash: hash } });
        const sent = gateway();
        const started = await checkout(artifactId, '198.51.100.68');
        expect(started.orderId).toBeTruthy();
        return JSON.parse(sent.find((entry) => entry.method === 'POST')!.body ?? '{}');
      })();
      // The job keeps USD; the service is sent usd, so its own list accepts it and the checkout does not fail
      expect(body.currency).toBe('usd');
    });

    it('spaces the looks at an order further apart the longer it has waited, up to sixty times the check time', async () => {
      await saveServerLimits({ bricks: { paymentCheckSeconds: 5, checkoutOpenHours: 24 } }, sara);
      const { artifactId } = await pending();
      const sent = gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId, '198.51.100.40');
      const looks = () => sent.filter((entry) => entry.method === 'GET').length;
      const lookedAgo = async (seconds: number, ageMinutes: number) => {
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - ageMinutes * 60_000), checkedAt: new Date(Date.now() - seconds * 1000) } });
        const before = looks();
        await verifyOrder(orderId);
        return looks() - before;
      };
      // A new order: one look every five seconds
      expect(await lookedAgo(6, 0)).toBe(1);
      expect(await lookedAgo(3, 0)).toBe(0);
      // Ten minutes in, a look every 55 seconds: thirty seconds ago is too soon, a minute ago is not
      expect(await lookedAgo(30, 10)).toBe(0);
      expect(await lookedAgo(60, 10)).toBe(1);
      // Hours in, never further apart than sixty times the check time (five minutes)
      expect(await lookedAgo(200, 600)).toBe(0);
      expect(await lookedAgo(310, 600)).toBe(1);
    });

    it('ends an order past its open time even when the owner has no room left for looks', async () => {
      await saveServerLimits({ bricks: { paymentLooksPerOwner: 1, checkoutOpenHours: 1 } }, sara);
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const first = await checkout(artifactId, '198.51.100.41');
      await settle(first.orderId);
      const second = await checkout(artifactId, '198.51.100.42');
      // This owner's room for looks is spent: a new order's look waits, an old one's still ends
      expect(await settle(second.orderId)).toMatchObject({ status: 'checking' });
      await prisma.appPageOrder.update({ where: { id: second.orderId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      expect(await settle(second.orderId)).toMatchObject({ status: 'not_paid' });
    });

    it('counts looks at payments for each owner, and waits when that is spent', async () => {
      await saveServerLimits({ bricks: { paymentLooksPerOwner: 1 } }, sara);
      const { artifactId } = await pending();
      const sent = gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId, '198.51.100.53');
      await settle(orderId);
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(1);
      expect(await prisma.appKeyCall.count({ where: { ownerId: 'page-payments' } })).toBe(1);
      // This owner's room for looks is spent: the next look waits, and says so to a notice
      const again = await settle(orderId);
      expect(again).toMatchObject({ status: 'checking' });
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(1);
      // Never charged to the owner's own allowance
      expect(await prisma.appKeyCall.count({ where: { ownerId: sara } })).toBe(0);
    });

    it('has a built-in ceiling on looks for each owner that applies when Limits was never touched', async () => {
      // No Limits row at all (the suite starts and ends each test without one)
      expect(await prisma.appSetting.findUnique({ where: { key: 'bot-limits' } })).toBeNull();
      expect((await getBrickLimits()).paymentLooksPerOwner).toBe(2_000);
      const { artifactId } = await pending();
      const sent = gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId, '198.51.100.73');
      // This owner's room for the hour is used up by 2,000 earlier looks: the next one waits, and the service is not asked
      await prisma.appKeyCall.createMany({
        data: Array.from({ length: 2_000 }, (_, index) => ({ ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:seed-${tag}:${index}`, operation: 'lookUpPayment', state: 'done', outcome: 'ok' })),
      });
      expect(await settle(orderId)).toMatchObject({ status: 'checking' });
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(0);
      // One look fewer and it goes through: the ceiling is exactly 2,000, not "none" and not "all refused"
      await prisma.appKeyCall.deleteMany({ where: { callId: `look:${sara}:seed-${tag}:0` } });
      await settle(orderId);
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(1);
    });

    it('counts looks at payments for everyone together, apart from what Bricks and checkouts may do', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 2 } }, sara);
      const { artifactId } = await pending();
      const sent = gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId, '198.51.100.70');
      await settle(orderId);
      await settle(orderId);
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(2);
      // Everyone's room for looks is spent
      expect(await settle(orderId)).toMatchObject({ status: 'checking' });
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(2);
    });

    it('does not let looks at payments use up what checkouts may do', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 3 } }, sara);
      const { artifactId } = await pending();
      const sent = gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId, '198.51.100.71');
      await settle(orderId);
      await settle(orderId);
      expect(await prisma.appKeyCall.count({ where: { ownerId: 'page-payments' } })).toBe(2);
      // One order and two looks: counted together that would be the three the platform may send, and a second checkout would be refused
      expect((await start(artifactId, '198.51.100.72')).status).toBe(200);
      expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(2);
    });

    it('answers a notice that had to wait with a request to come back, so the service asks again', async () => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId, '198.51.100.54');
      await settle(orderId);
      // The order was asked about a moment ago
      const waited = await notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body: { status: 'CAPTURED' } }), params({ orderId }));
      expect(waited.status).toBe(429);
      expect(Number(waited.headers.get('retry-after'))).toBeGreaterThan(0);
      // After the wait it asks, and is done
      await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * 3_600_000) } });
      gateway({ record: (order) => paidRecord(order) });
      const done = await notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body: { status: 'CAPTURED' } }), params({ orderId }));
      expect(done.status).toBe(200);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('paid');
    });

    it('starts a checkout with the terms the owner holds when the lock is taken, not the ones read before it', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      expect((await job(serverId, artifactId)).status).toBe(200);
      gateway();
      // The owner replaces the terms between the first read and the lock
      const real = prisma.$transaction.bind(prisma);
      const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: unknown, ...rest: unknown[]) => {
        return (async () => {
          await prisma.appPageJob.update({ where: { artifactId }, data: { amountMinor: 9_000 } });
          return (real as (...args: unknown[]) => Promise<unknown>)(fn, ...rest);
        })();
      }) as never);
      try {
        const { orderId } = await checkout(artifactId, '198.51.100.55');
        const order = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } });
        expect(order.amountMinor).toBe(9_000);
      } finally {
        spy.mockRestore();
      }
    });
  });

  /* ------------------ a purchase a buyer can always get back to (O3) ------------------ */

  describe('a purchase wish: one order, and a way back to it', () => {
    const word = () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const wish = () => `i${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const buyerOf = (code: string) => guestBuyerKey(code) as string;
    const begin = (artifactId: string, intentId: string, code: string, visitor = 'visitor-1') => startCheckout({ artifactId, visitor, intentId, buyerKey: buyerOf(code), shownVersion: 1 });
    const orders = (artifactId: string) => prisma.appPageOrder.findMany({ where: { artifactId }, orderBy: { createdAt: 'asc' } });
    const old = (orderId: string) => prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * 3_600_000) } });

    it('gives the same wish the same order, with the same link, and asks the service once', async () => {
      const { artifactId } = await pending();
      const sent = gateway();
      const code = word();
      const intentId = wish();
      const one = await begin(artifactId, intentId, code);
      const two = await begin(artifactId, intentId, code);
      if (one.status !== 'ok' || two.status !== 'ok') throw new Error('expected both to be ok');
      expect(two.orderId).toBe(one.orderId);
      expect(two.checkoutUrl).toBe(one.checkoutUrl);
      expect([one.reused, two.reused]).toEqual([false, true]);
      expect(sent).toHaveLength(1);
      expect(await orders(artifactId)).toHaveLength(1);
      expect(await orders(artifactId)).toEqual([expect.objectContaining({ intentId, buyerKey: buyerOf(code), status: 'pending' })]);
    });

    it('makes one order when two tabs send the same wish at the same moment', async () => {
      const { artifactId } = await pending();
      const sent = gateway();
      const code = word();
      const intentId = wish();
      const both = await Promise.all([begin(artifactId, intentId, code), begin(artifactId, intentId, code)]);
      const ids = both.map((outcome) => (outcome.status === 'ok' ? outcome.orderId : null));
      expect(ids[0]).not.toBeNull();
      expect(ids[1]).toBe(ids[0]);
      expect(sent.filter((target) => target.method === 'POST')).toHaveLength(1);
      expect(await orders(artifactId)).toHaveLength(1);
    });

    it('makes a new order for a deliberate new purchase, and a separate one for another buyer with the same wish', async () => {
      const { artifactId } = await pending();
      gateway();
      const code = word();
      const intentId = wish();
      const first = await begin(artifactId, intentId, code);
      const second = await begin(artifactId, wish(), code, 'visitor-2');
      const third = await begin(artifactId, intentId, word(), 'visitor-3');
      const ids = [first, second, third].map((outcome) => (outcome.status === 'ok' ? outcome.orderId : null));
      expect(new Set(ids).size).toBe(3);
      expect(await orders(artifactId)).toHaveLength(3);
    });

    it('stores only a hash of a guest’s recovery code, and refuses a code that is too short to be unguessable', async () => {
      const { artifactId } = await pending();
      gateway();
      const code = word();
      await begin(artifactId, wish(), code);
      const stored = JSON.stringify(await orders(artifactId));
      expect(stored).not.toContain(code);
      expect(guestBuyerKey('short')).toBeNull();
      expect(guestBuyerKey('has spaces in it and is long enough to pass the length rule!!')).toBeNull();
    });

    it('carries on an order whose start was lost with the same wish: the same order, the same key at the service, no second order', async () => {
      const { artifactId } = await pending();
      const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      const code = word();
      const intentId = wish();
      // The server stopped after writing the order and before the service answered: nobody was given a link
      const lost = await prisma.appPageOrder.create({
        data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'creating', visitorHash: 'v', intentId, buyerKey: buyerOf(code), createdAt: new Date(Date.now() - 120_000) },
      });
      const sent = gateway();
      const outcome = await begin(artifactId, intentId, code);
      if (outcome.status !== 'ok') throw new Error('expected ok');
      expect(outcome.orderId).toBe(lost.id);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0].body as string)).toMatchObject({ amount: 4.5, currency: 'KWD', reference: { order: lost.id, idempotent: lost.id } });
      expect(await orders(artifactId)).toHaveLength(1);
      expect((await orders(artifactId))[0]).toMatchObject({ status: 'pending', providerRef: 'chg_TS01' });
    });

    it('lets only one of two requests carry on a lost start, and gives both the same order', async () => {
      const { artifactId } = await pending();
      const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      const code = word();
      const intentId = wish();
      const lost = await prisma.appPageOrder.create({
        data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'creating', visitorHash: 'v', intentId, buyerKey: buyerOf(code), createdAt: new Date(Date.now() - 120_000) },
      });
      const sent = gateway();
      const both = await Promise.all([begin(artifactId, intentId, code), begin(artifactId, intentId, code)]);
      expect(both.map((outcome) => (outcome.status === 'ok' ? outcome.orderId : null))).toEqual([lost.id, lost.id]);
      expect(sent.filter((target) => target.method === 'POST')).toHaveLength(1);
    });

    it('waits for a start another request is still making, and answers with its order', async () => {
      const { artifactId } = await pending();
      const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      const code = word();
      const intentId = wish();
      const busy = await prisma.appPageOrder.create({
        data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'creating', visitorHash: 'v', intentId, buyerKey: buyerOf(code) },
      });
      const sent = gateway();
      setTimeout(() => { prisma.appPageOrder.update({ where: { id: busy.id }, data: { status: 'pending', providerRef: 'chg_OTHER', checkoutUrl: 'https://checkout.examplepay.com/?mode=page&token=other' } }).catch(() => undefined); }, 400);
      const outcome = await begin(artifactId, intentId, code);
      expect(outcome).toMatchObject({ status: 'ok', orderId: busy.id, checkoutUrl: 'https://checkout.examplepay.com/?mode=page&token=other', reused: true });
      expect(sent).toHaveLength(0);
    });

    it('does not carry on a lost start for a page the owner stopped, or past the time an order may stay open', async () => {
      const { artifactId } = await pending();
      const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      const make = (intentId: string, code: string, age: number) =>
        prisma.appPageOrder.create({
          data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'creating', visitorHash: 'v', intentId, buyerKey: buyerOf(code), createdAt: new Date(Date.now() - age) },
        });
      const sent = gateway();
      const code = word();
      const tooOld = await make(wish(), code, 25 * 3_600_000);
      expect((await begin(artifactId, tooOld.intentId as string, code)).status).toBe('unavailable');
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: tooOld.id } })).toMatchObject({ status: 'not_paid' });
      const stopped = await make(wish(), code, 120_000);
      await prisma.appPageJob.update({ where: { artifactId }, data: { status: 'stopped' } });
      expect((await begin(artifactId, stopped.intentId as string, code)).status).toBe('unavailable');
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: stopped.id } })).toMatchObject({ status: 'not_paid' });
      expect(sent).toHaveLength(0);
    });

    it('keeps a line of history for every move an order makes', async () => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const outcome = await begin(artifactId, wish(), word());
      if (outcome.status !== 'ok') throw new Error('expected ok');
      await old(outcome.orderId);
      await verifyOrder(outcome.orderId);
      const lines = await prisma.appPageOrderEvent.findMany({ where: { orderId: outcome.orderId }, orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, reason: true } });
      expect(lines).toEqual([
        { fromStatus: null, toStatus: 'creating', reason: 'started' },
        { fromStatus: 'creating', toStatus: 'pending', reason: 'checkout_ready' },
        { fromStatus: 'pending', toStatus: 'paid', reason: 'paid' },
      ]);
    });

    describe('review findings on the order machine (CodeRabbit, 19 Nov)', () => {
      const lostOrder = async (artifactId: string, code: string, intentId: string, over: Record<string, unknown> = {}) => {
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        return prisma.appPageOrder.create({
          data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'creating', visitorHash: 'v', intentId, buyerKey: buyerOf(code), description: jobRow.description, createdAt: new Date(Date.now() - 120_000), ...over },
        });
      };
      const POSTS = (sent: Sent[]) => sent.filter((target) => target.method === 'POST');

      it('writes the state an order really left, read under the lock: a payment that arrives after a close is late', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const made = await begin(artifactId, wish(), word());
        if (made.status !== 'ok') throw new Error('expected ok');
        // The service is asked, and while it is being asked the order is closed (another request ran out its time)
        const records = mockSend.current!;
        mockSend.current = async (target) => {
          await prisma.appPageOrder.update({ where: { id: made.orderId }, data: { status: 'not_paid', closedAt: new Date() } });
          return records(target);
        };
        await old(made.orderId);
        await verifyOrder(made.orderId);
        const lines = await prisma.appPageOrderEvent.findMany({ where: { orderId: made.orderId }, orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, reason: true } });
        expect(lines.at(-1)).toEqual({ fromStatus: 'not_paid', toStatus: 'paid', reason: 'paid_late' });
        expect((await notices()).some((notice) => notice.body.includes('came in after the checkout had closed'))).toBe(true);
      });

      it('keeps a start attempt that was taken over from changing the order', async () => {
        const { artifactId } = await pending();
        const code = word();
        const intentId = wish();
        const sent = gateway();
        const answers = mockSend.current!;
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => { release = resolve; });
        mockSend.current = async () => {
          // The first attempt is stuck at the service; a later attempt takes the order over (it moves `checkedAt`), then the first one fails
          await prisma.appPageOrder.updateMany({ where: { artifactId }, data: { checkedAt: new Date() } });
          release();
          await held;
          return { status: 400, body: {} };
        };
        expect((await begin(artifactId, intentId, code)).status).toBe('unavailable');
        // The first attempt's failure did not close an order that now belongs to the later one
        expect((await orders(artifactId))[0]).toMatchObject({ status: 'creating' });
        mockSend.current = answers;
        expect(sent).toHaveLength(0);
      });

      it('keeps an order recoverable when the service did not clearly refuse: it may have made the payment', async () => {
        const { artifactId } = await pending();
        const code = word();
        const intentId = wish();
        // Trouble at the service (5xx) and no answer in time: neither closes the order
        for (const trouble of ['5xx', 'timeout'] as const) {
          const wishId = trouble === '5xx' ? intentId : wish();
          mockSend.current = () => {
            if (trouble === 'timeout') throw new GuardError('timeout', 'no answer');
            return { status: 503, body: {} };
          };
          const outcome = await begin(artifactId, wishId, code);
          // It says an order may exist, so the host offers Check payment (a clear refusal below does not)
          expect(outcome).toMatchObject({ status: 'unavailable', unsure: true });
          const made = (await orders(artifactId)).find((row) => row.intentId === wishId);
          expect(made).toMatchObject({ status: 'creating' });
          // Nothing is in flight any more: it can be carried on within a few seconds, not after a whole start time (Check payment has 30 s)
          const limits = await getBrickLimits();
          const wait = made!.checkedAt!.getTime() + limits.keyCallSeconds * 1000 + 2_000 - Date.now();
          expect(wait).toBeGreaterThan(0);
          expect(wait).toBeLessThanOrEqual(5_200);
          expect((await prisma.appPageOrderEvent.findMany({ where: { orderId: made!.id } })).map((line) => line.reason)).toContain(trouble === '5xx' ? 'start_service_trouble' : 'start_unsure');
        }
        // The same wish asked again, once the wait is over, goes on with the SAME order and the same key at the service
        const first = (await orders(artifactId)).find((row) => row.intentId === intentId)!;
        await prisma.appPageOrder.update({ where: { id: first.id }, data: { createdAt: new Date(Date.now() - 120_000), checkedAt: new Date(Date.now() - 120_000) } });
        const sent = gateway();
        const again = await begin(artifactId, intentId, code);
        expect(again).toMatchObject({ status: 'ok', orderId: first.id });
        expect(JSON.parse(POSTS(sent)[0].body as string)).toMatchObject({ reference: { order: first.id, idempotent: first.id } });
        // A clear refusal (the service said no) still closes the order
        gateway({ createStatus: 400 });
        const refused = wish();
        const clear = await begin(artifactId, refused, code);
        expect(clear.status).toBe('unavailable');
        expect(clear).not.toHaveProperty('unsure');
        expect((await orders(artifactId)).find((row) => row.intentId === refused)).toMatchObject({ status: 'not_paid' });
      });

      it('a start that failed quickly can be carried on a few seconds later, not after a whole start time, and by one request only', async () => {
        const { artifactId } = await pending();
        const code = word();
        const intentId = wish();
        mockSend.current = () => {
          throw new GuardError('timeout', 'no answer');
        };
        expect(await begin(artifactId, intentId, code)).toMatchObject({ status: 'unavailable', unsure: true });
        const sent = gateway();
        // Six seconds on (the order was only just made): the same wish goes on with the same order, and a second ask at that moment waits for it
        const real = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(real + 6_000);
        try {
          const [first, second] = await Promise.all([begin(artifactId, intentId, code), begin(artifactId, intentId, code)]);
          expect(first.status).toBe('ok');
          expect(second.status).toBe('ok');
        } finally {
          clock.mockRestore();
        }
        expect(POSTS(sent)).toHaveLength(1);
      });

      it('says `unsure` in the 409 of both routes when an order may exist, and not when nothing was made', async () => {
        const { artifactId } = await pending();
        mockSend.current = () => {
          throw new GuardError('timeout', 'no answer');
        };
        const response = await publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { intentId: wish(), recoveryCode: word(), shownVersion: 1 }, headers: { 'x-forwarded-for': '203.0.113.77' } }), params({ artifactId }));
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'unavailable', unsure: true });
        const game = await gamePay(request(`/api/artifacts/${artifactId}/pay`, { method: 'POST', token: ADMIN_TOKEN, body: { viewer: { person: { signedIn: false, name: 'Visitor' }, inChat: true, chat: { kind: 'dm', ref: `chat-${tag}` } }, start: true, intentId: wish(), recoveryCode: word(), shownVersion: 1 } }), params({ id: artifactId }));
        expect(game.status).toBe(409);
        expect(await game.json()).toMatchObject({ error: 'unavailable', unsure: true });
      });

      it('never starts a payment for a buyer who only holds a receipt link’s code, in Check payment or in Restore', async () => {
        const { artifactId } = await pending();
        const sender = word();
        const mine = word();
        const intentId = wish();
        const lost = await lostOrder(artifactId, sender, intentId);
        const sent = gateway();
        const keys = [buyerOf(mine), buyerOf(sender)];
        await checkPurchase({ artifactId, buyerKeys: keys, ownKeys: [keys[0]], intentId });
        expect(await restorePurchase({ artifactId, buyerKeys: keys, ownKeys: [keys[0]] })).toMatchObject({ status: 'checking', orderId: lost.id, checkoutUrl: null, via: 'receipt' });
        expect(sent).toHaveLength(0);
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: lost.id } })).toMatchObject({ status: 'creating' });
        // Its own buyer's keys do carry it on, in Check payment
        await checkPurchase({ artifactId, buyerKeys: keys, ownKeys: [keys[1]], intentId });
        expect(POSTS(sent)).toHaveLength(1);
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: lost.id } })).toMatchObject({ status: 'pending' });
      });

      it('an order in the long wait whose look had no room in the hour stays as due as it was (the whole claim given back), never a week later; a look that was really made keeps its age-based interval', async () => {
        const { artifactId } = await pending();
        await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, paymentLooksPerOwner: 1 } }, sara);
        const old = await lostOrder(artifactId, word(), wish(), { status: 'not_paid', providerRef: 'chg_TS01', reconciled: false, createdAt: new Date(Date.now() - 40 * 24 * 3_600_000), closedAt: new Date(Date.now() - 39 * 24 * 3_600_000), nextLookAt: null });
        const young = await lostOrder(artifactId, word(), wish(), { status: 'not_paid', providerRef: 'chg_TS02', reconciled: false, createdAt: new Date(Date.now() - 80 * 3_600_000), closedAt: new Date(Date.now() - 60 * 3_600_000), nextLookAt: null });
        const sent = gateway({ record: (orderId) => paidRecord(orderId, { status: 'INITIATED' }) });
        // The owner's hourly room for looks is one: the first order is asked (its look is made, so its own interval stands), the second finds no room
        await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
        await verifyOrder(young.id, undefined, undefined, { background: true });
        expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
        const made = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: young.id } });
        expect(made.nextLookAt!.getTime() - Date.now()).toBeGreaterThan(5 * 3_600_000);
        await verifyOrder(old.id, undefined, undefined, { background: true });
        expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
        const waited = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: old.id } });
        // Weekly is what its age would give; with no room nothing is moved: it was never scheduled and still is not (due at the next sweep), and no look is counted
        expect(waited).toMatchObject({ nextLookAt: null, checkedAt: null, checks: 0 });
        // The room is back: it is looked at, and its own interval stands from then
        await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
        await verifyOrder(old.id, undefined, undefined, { background: true });
        expect(sent.filter((target) => target.method === 'GET')).toHaveLength(2);
        const looked = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: old.id } });
        expect(looked.checks).toBe(1);
        expect(looked.nextLookAt!.getTime() - Date.now()).toBeGreaterThan(5 * 24 * 3_600_000);
      });

      it('an order in the long wait whose look was taken but could not be READ (an error, a timeout, a refusal, a page that is not a record, no state, a key that cannot be read) is tried again soon, never a week later; a look that was read keeps the age-based interval', async () => {
        const { artifactId } = await pending();
        const longWait = (ref: string) => lostOrder(artifactId, word(), wish(), { status: 'not_paid', providerRef: ref, reconciled: false, createdAt: new Date(Date.now() - 40 * 24 * 3_600_000), closedAt: new Date(Date.now() - 39 * 24 * 3_600_000), nextLookAt: null });
        const nextIn = async (id: string) => (await prisma.appPageOrder.findUniqueOrThrow({ where: { id } })).nextLookAt!.getTime() - Date.now();
        const unreadable: Array<[string, (target: Sent) => Answered | Promise<Answered>]> = [
          ['a 5xx', () => ({ status: 503, body: { error: 'down' } })],
          ['a timeout', () => { throw new GuardError('timeout', 'no answer'); }],
          ['a 401', () => ({ status: 401, body: { error: 'no' } })],
          ['a page that is not a record', () => ({ status: 200, body: 'not a record' })],
          ['an answer with no state', () => ({ status: 200, body: {} })],
          ['a redirect', () => ({ status: 200, redirected: true, body: {} })],
        ];
        let n = 0;
        for (const [name, answer] of unreadable) {
          const order = await longWait(`chg_UR0${(n += 1)}`);
          await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
          mockSend.current = answer;
          await verifyOrder(order.id, undefined, undefined, { background: true });
          // Weekly is what its age would give: not read, so it is tried again within the quarter hour
          const left = await nextIn(order.id);
          expect({ name, soon: left > 0 && left <= 15 * 60_000 + 5_000 }).toEqual({ name, soon: true });
        }
        // A look that WAS read (still open at the service) keeps the interval its age gives
        const read = await longWait('chg_UR10');
        await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
        gateway({ record: (orderId) => paidRecord(orderId, { status: 'INITIATED' }) });
        await verifyOrder(read.id, undefined, undefined, { background: true });
        expect(await nextIn(read.id)).toBeGreaterThan(5 * 24 * 3_600_000);
        // A key that cannot be read cannot ask: the same
        const other = await pending();
        await prisma.appConnection.update({ where: { id: other.connectionId }, data: { keyCipher: 'not a key' } });
        const blind = await lostOrder(other.artifactId, word(), wish(), { status: 'not_paid', providerRef: 'chg_UR11', reconciled: false, createdAt: new Date(Date.now() - 40 * 24 * 3_600_000), closedAt: new Date(Date.now() - 39 * 24 * 3_600_000), nextLookAt: null });
        await verifyOrder(blind.id, undefined, undefined, { background: true });
        const blindLeft = await nextIn(blind.id);
        expect(blindLeft).toBeGreaterThan(0);
        expect(blindLeft).toBeLessThanOrEqual(15 * 60_000 + 5_000);
      });

      describe('the long wait never ends and never says "checking" for ever (Sentry MEDIUM; Opus R5/O3: no end date, a buyer who paid in advance never pays twice)', () => {
        const DAY = 24 * 3_600_000;
        // An order closed `closedDaysAgo` days ago; its late window (48 hours) ended two days after that
        const longOrder = async (artifactId: string, code: string, ref: string, closedDaysAgo: number, over: Record<string, unknown> = {}) =>
          lostOrder(artifactId, code, wish(), { status: 'not_paid', providerRef: ref, reconciled: false, createdAt: new Date(Date.now() - (closedDaysAgo + 1) * DAY), closedAt: new Date(Date.now() - closedDaysAgo * DAY), nextLookAt: null, ...over });
        const setUp = async () => {
          const made = await pending();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
          await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
          return made;
        };
        const row = (id: string) => prisma.appPageOrder.findUniqueOrThrow({ where: { id } });
        const nextIn = async (id: string) => (await row(id)).nextLookAt!.getTime() - Date.now();

        it('a payment found at day 200 is counted once, late, with one notice: the order is still looked at, monthly after 90 days', async () => {
          const { artifactId } = await setUp();
          const old = await longOrder(artifactId, word(), 'chg_LW01', 202);
          // The service still calls it started: looked at, nothing ends, the next look is a month away
          const sent = gateway({ record: () => paidRecord(old.id, { status: 'INITIATED' }) });
          await sweepPageOrders();
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
          expect(await row(old.id)).toMatchObject({ status: 'not_paid', reconciled: false });
          expect(await nextIn(old.id)).toBeGreaterThan(29 * DAY);
          expect(await nextIn(old.id)).toBeLessThanOrEqual(30 * DAY + 5_000);
          // A month later it was paid (the buyer paid in advance): found, counted once, with one notice
          gateway({ record: () => paidRecord(old.id) });
          const before = (await notices()).length;
          await prisma.appPageOrder.update({ where: { id: old.id }, data: { nextLookAt: new Date(Date.now() - 1_000) } });
          await sweepPageOrders();
          expect(await row(old.id)).toMatchObject({ status: 'paid' });
          expect((await prisma.appPageOrderEvent.findMany({ where: { orderId: old.id, toStatus: 'paid' } })).map((line) => line.reason)).toEqual(['paid_late']);
          await sweepPageOrders();
          expect((await notices()).slice(before)).toHaveLength(1);
        });

        it('the buyer’s words switch at 90 days past the window: "still checking" before, "contact the page’s owner" after (Check payment, the done page and Restore), and the page stops refreshing; the looks go on', async () => {
          const { artifactId } = await setUp();
          const code = word();
          const intentId = wish();
          const keys = [buyerOf(code)];
          // 60 days past the window: still checking
          const young = await lostOrder(artifactId, code, intentId, { status: 'not_paid', providerRef: 'chg_LW02', reconciled: false, createdAt: new Date(Date.now() - 63 * DAY), closedAt: new Date(Date.now() - 62 * DAY), nextLookAt: null });
          gateway({ record: () => paidRecord(young.id, { status: 'INITIATED' }) });
          const early = await checkPurchase({ artifactId, buyerKeys: keys, ownKeys: keys, intentId });
          expect(early).toMatchObject({ status: 'checking', longWait: true });
          expect(early).not.toHaveProperty('longWaitOver');
          expect(await restorePurchase({ artifactId, buyerKeys: keys, ownKeys: keys })).toMatchObject({ status: 'checking', longWait: true, orderId: young.id });
          expect(checksHaveEnded(early!)).toBe(false);
          // 100 days past it: closed-order words, flagged, no refresh, and the order is still unsettled and still looked at
          await prisma.appPageOrder.update({ where: { id: young.id }, data: { createdAt: new Date(Date.now() - 103 * DAY), closedAt: new Date(Date.now() - 102 * DAY), checkedAt: null } });
          const late = await checkPurchase({ artifactId, buyerKeys: keys, ownKeys: keys, intentId });
          expect(late).toMatchObject({ status: 'not_paid', longWaitOver: true, checkoutUrl: null });
          expect(late).not.toHaveProperty('longWait');
          expect(checksHaveEnded(late!)).toBe(true);
          const seen = await verifyOrderForReturnPage(young.id);
          expect(seen).toMatchObject({ status: 'not_paid' });
          expect(checksHaveEnded(seen!)).toBe(true);
          expect(await restorePurchase({ artifactId, buyerKeys: keys, ownKeys: keys })).toMatchObject({ status: 'checking', longWait: true, longWaitOver: true, orderId: young.id });
          expect(await row(young.id)).toMatchObject({ status: 'not_paid', reconciled: false });
          expect((await pagePaymentLoad()).unconfirmed.count).toBe(1);
          // And it is still found when it was paid after all
          gateway({ record: () => paidRecord(young.id) });
          await prisma.appPageOrder.update({ where: { id: young.id }, data: { checkedAt: null, nextLookAt: null } });
          expect(await checkPurchase({ artifactId, buyerKeys: keys, ownKeys: keys, intentId })).toMatchObject({ status: 'paid' });
        });

        it('an unreadable look keeps trying and backs off to the order’s own cadence, never stopping: soon after a read look, then twice the gap since the unread one, up to a month after 90 days', async () => {
          const { artifactId } = await setUp();
          mockSend.current = () => ({ status: 503, body: {} });
          const lookFor = async (checkedAgo: number, readAgo: number | null) => {
            const order = await longOrder(artifactId, word(), `chg_LW${Math.random().toString(36).slice(2, 6)}`, 102, { checkedAt: new Date(Date.now() - checkedAgo), lastReadAt: readAgo === null ? null : new Date(Date.now() - readAgo), nextLookAt: new Date(Date.now() - 1_000) });
            await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
            await verifyOrder(order.id, undefined, undefined, { background: true });
            return nextIn(order.id);
          };
          // The look before it was read (last read at the same moment): the first failure, tried again within the quarter hour
          const first = await lookFor(30 * DAY, 30 * DAY);
          expect(first).toBeGreaterThan(0);
          expect(first).toBeLessThanOrEqual(15 * 60_000 + 5_000);
          // The look before it was NOT read, an hour ago: twice that
          const second = await lookFor(60 * 60_000, 40 * DAY);
          expect(second).toBeGreaterThan(110 * 60_000);
          expect(second).toBeLessThanOrEqual(120 * 60_000 + 5_000);
          // Unread for ten days: twenty days; unread for twenty: capped at the month the order's age gives, never beyond it and never stopped
          const ten = await lookFor(10 * DAY, 40 * DAY);
          expect(ten).toBeGreaterThan(19 * DAY);
          expect(ten).toBeLessThanOrEqual(20 * DAY + 5_000);
          const long = await lookFor(20 * DAY, 40 * DAY);
          expect(long).toBeGreaterThan(29 * DAY);
          expect(long).toBeLessThanOrEqual(30 * DAY + 5_000);
          // Never read at all, looked at before: backs off the same way
          const never = await lookFor(60 * 60_000, null);
          expect(never).toBeGreaterThan(110 * 60_000);
        });

        it('the alert is on a STALLED look, never on age: an order of any age looked at on schedule shows only as a count and its age; an overdue look, an order the schedule never reached, and looks that are made and not read each stall', async () => {
          const { artifactId } = await setUp();
          const calm = await longOrder(artifactId, word(), 'chg_LW10', 202, { checkedAt: new Date(Date.now() - 3_600_000), lastReadAt: new Date(Date.now() - 3_600_000), nextLookAt: new Date(Date.now() + 20 * DAY) });
          let load = (await pagePaymentLoad()).unconfirmed;
          expect(load).toMatchObject({ count: 1, overdue: 0, neverChecked: 0, unreadLooks: 0, stalled: [] });
          expect(load.oldestSeconds).toBeGreaterThan(200 * 86_400);
          // A scheduled look more than an hour late
          await prisma.appPageOrder.update({ where: { id: calm.id }, data: { nextLookAt: new Date(Date.now() - 2 * 3_600_000) } });
          expect((await pagePaymentLoad()).unconfirmed.stalled).toEqual(['overdue']);
          // An order the schedule never reached
          await prisma.appPageOrder.update({ where: { id: calm.id }, data: { nextLookAt: new Date(Date.now() + 20 * DAY), checkedAt: null } });
          expect((await pagePaymentLoad()).unconfirmed.stalled).toEqual(['never_checked']);
          // Looked at again and again with no good read for hours
          await prisma.appPageOrder.update({ where: { id: calm.id }, data: { checkedAt: new Date(Date.now() - 60_000), lastReadAt: new Date(Date.now() - 6 * 3_600_000), nextLookAt: new Date(Date.now() + 1_000) } });
          load = (await pagePaymentLoad()).unconfirmed;
          expect(load).toMatchObject({ unreadLooks: 1, stalled: ['unreadable'] });
          // Back on schedule: the alert clears whatever the age
          await prisma.appPageOrder.update({ where: { id: calm.id }, data: { lastReadAt: new Date(), checkedAt: new Date(), nextLookAt: new Date(Date.now() + 20 * DAY) } });
          expect((await pagePaymentLoad()).unconfirmed.stalled).toEqual([]);
        });

        it('an order unreadable for days stays "unreadable" while its looks back off to weekly and monthly (no one-day window), and clears the moment a look is read', async () => {
          const { artifactId } = await setUp();
          // Unreadable for 10 days: looked at 3 days ago (weekly cadence), the last good read 13 days ago, its next look days away
          const stuck = await longOrder(artifactId, word(), 'chg_LW20', 60, { checks: 9, checkedAt: new Date(Date.now() - 3 * DAY), lastReadAt: new Date(Date.now() - 13 * DAY), nextLookAt: new Date(Date.now() + 4 * DAY) });
          let load = (await pagePaymentLoad()).unconfirmed;
          expect(load).toMatchObject({ unreadLooks: 1, stalled: ['unreadable'], overdue: 0 });
          // Monthly after 90 days: looked at 20 days ago and never read since the window, still not clear
          await prisma.appPageOrder.update({ where: { id: stuck.id }, data: { createdAt: new Date(Date.now() - 203 * DAY), closedAt: new Date(Date.now() - 202 * DAY), checkedAt: new Date(Date.now() - 20 * DAY), lastReadAt: null, nextLookAt: new Date(Date.now() + 10 * DAY) } });
          load = (await pagePaymentLoad()).unconfirmed;
          expect(load).toMatchObject({ unreadLooks: 1, stalled: ['unreadable'] });
          // A look that was read: cleared (whatever the age, and however far off the next look is)
          await prisma.appPageOrder.update({ where: { id: stuck.id }, data: { checkedAt: new Date(Date.now() - 20 * DAY), lastReadAt: new Date(Date.now() - 20 * DAY) } });
          expect((await pagePaymentLoad()).unconfirmed).toMatchObject({ unreadLooks: 0, stalled: [] });
          // Fewer than three looks and no read yet is not a pattern
          await prisma.appPageOrder.update({ where: { id: stuck.id }, data: { checks: 2, lastReadAt: null } });
          expect((await pagePaymentLoad()).unconfirmed.unreadLooks).toBe(0);
        });

        it('an order starved of look budget for sweep after sweep is not "unreadable": the whole claim is given back (no look counted, last look and schedule unchanged), so it shows as OVERDUE once starved past the hour, and is looked at and cleared when the room is back', async () => {
          const { artifactId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, paymentLooksPerOwner: 1 } }, sara);
          const lastLook = new Date(Date.now() - 3 * DAY);
          const due = new Date(Date.now() - 2 * 3_600_000);
          // The owner's hourly room is one look: the first order takes it, the second is starved
          const first = await longOrder(artifactId, word(), 'chg_LW30', 60, { checks: 4, checkedAt: lastLook, lastReadAt: lastLook, nextLookAt: new Date(Date.now() - 3 * 3_600_000) });
          const starved = await longOrder(artifactId, word(), 'chg_LW31', 60, { checks: 5, checkedAt: lastLook, lastReadAt: lastLook, nextLookAt: due });
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          for (let sweep = 0; sweep < 4; sweep += 1) {
            await sweepPageOrders();
            const kept = await row(starved.id);
            // Nothing was asked of the service for it: no look counted, the last look still the last, and its look still due exactly as it was (never pushed ahead)
            expect({ sweep, checks: kept.checks, checkedAt: kept.checkedAt?.getTime(), nextLookAt: kept.nextLookAt?.getTime() }).toEqual({ sweep, checks: 5, checkedAt: lastLook.getTime(), nextLookAt: due.getTime() });
          }
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
          expect((await row(first.id)).checks).toBe(5);
          // Starved for two hours: overdue (and said), never "unreadable"
          const load = (await pagePaymentLoad()).unconfirmed;
          expect(load).toMatchObject({ unreadLooks: 0, overdue: 1 });
          expect(load.stalled).toEqual(['overdue']);
          // The room is back: it is looked at at the next sweep, and the alert clears
          await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
          await sweepPageOrders();
          expect(await row(starved.id)).toMatchObject({ checks: 6 });
          expect((await row(starved.id)).lastReadAt!.getTime()).toBeGreaterThan(lastLook.getTime());
          expect((await row(starved.id)).nextLookAt!.getTime()).toBeGreaterThan(Date.now());
          expect((await pagePaymentLoad()).unconfirmed).toMatchObject({ overdue: 0, stalled: [] });
          // A look that really was made and not read, three times, does count
          await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
          const failing = await longOrder(artifactId, word(), 'chg_LW32', 60, { checks: 2, checkedAt: lastLook, lastReadAt: null, nextLookAt: null });
          mockSend.current = () => ({ status: 503, body: {} });
          for (let look = 0; look < 3; look += 1) {
            await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
            await prisma.appPageOrder.update({ where: { id: failing.id }, data: { nextLookAt: new Date(Date.now() - 1_000) } });
            await prisma.appPageOrder.updateMany({ where: { id: { in: [first.id, starved.id] } }, data: { nextLookAt: new Date(Date.now() + 20 * DAY) } });
            await sweepPageOrders();
          }
          expect((await row(failing.id)).checks).toBe(5);
          expect((await pagePaymentLoad()).unconfirmed).toMatchObject({ unreadLooks: 1, stalled: ['unreadable'] });
        });

        it('a key that cannot be read is a real failed look (it needs a person to give the key again): counted, backed off, and alerted as unreadable, never silent (Opus)', async () => {
          const made = await pending();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
          const lastLook = new Date(Date.now() - 3 * DAY);
          // An order that was looked at and read before; then its app's key can no longer be read
          const order = await longOrder(made.artifactId, word(), 'chg_LW40', 60, { checks: 5, checkedAt: lastLook, lastReadAt: lastLook, nextLookAt: new Date(Date.now() - 60_000) });
          await prisma.appConnection.update({ where: { id: made.connectionId }, data: { keyCipher: 'not a key' } });
          await sweepPageOrders();
          const kept = await row(order.id);
          // The look is counted (the claim stays), and the order is tried again soon (the first failure of a streak)
          expect(kept.checks).toBe(6);
          expect(kept.checkedAt!.getTime()).toBeGreaterThan(lastLook.getTime());
          expect(kept.lastReadAt!.getTime()).toBe(lastLook.getTime());
          expect(await nextIn(order.id)).toBeGreaterThan(0);
          expect(await nextIn(order.id)).toBeLessThanOrEqual(15 * 60_000 + 5_000);
          const load = (await pagePaymentLoad()).unconfirmed;
          expect(load).toMatchObject({ unreadLooks: 1, stalled: ['unreadable'] });
          // Looked at again an hour later, still unreadable: the wait doubles (the streak backs off), the alert stays
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { checkedAt: new Date(Date.now() - 2 * 3_600_000), nextLookAt: new Date(Date.now() - 1_000) } });
          await sweepPageOrders();
          expect(await nextIn(order.id)).toBeGreaterThan(3.5 * 3_600_000);
          expect((await pagePaymentLoad()).unconfirmed.stalled).toEqual(['unreadable']);
        });

        it('an order whose app was disconnected after a good read is a failed look that needs a person: counted, backed off and alerted as unreadable, never a quiet future schedule (CodeRabbit)', async () => {
          const made = await pending();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
          const lastLook = new Date(Date.now() - 3 * DAY);
          const order = await longOrder(made.artifactId, word(), 'chg_LW50', 60, { checks: 5, checkedAt: lastLook, lastReadAt: lastLook, nextLookAt: new Date(Date.now() - 60_000) });
          // The app is disconnected: the order's connection and the page's are gone
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { connectionId: null } });
          await prisma.appPageJob.deleteMany({ where: { artifactId: made.artifactId } });
          await prisma.appConnection.delete({ where: { id: made.connectionId } });
          await sweepPageOrders();
          const kept = await row(order.id);
          expect(kept.checks).toBe(6);
          expect(kept.checkedAt!.getTime()).toBeGreaterThan(lastLook.getTime());
          expect(kept.lastReadAt!.getTime()).toBe(lastLook.getTime());
          expect(await nextIn(order.id)).toBeGreaterThan(0);
          expect(await nextIn(order.id)).toBeLessThanOrEqual(15 * 60_000 + 5_000);
          expect((await pagePaymentLoad()).unconfirmed).toMatchObject({ unreadLooks: 1, stalled: ['unreadable'] });
          // Still not back an hour later: the wait doubles, and the alert stays
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { checkedAt: new Date(Date.now() - 2 * 3_600_000), nextLookAt: new Date(Date.now() - 1_000) } });
          await sweepPageOrders();
          expect(await nextIn(order.id)).toBeGreaterThan(3.5 * 3_600_000);
          expect((await pagePaymentLoad()).unconfirmed.stalled).toEqual(['unreadable']);
        });

        it('an older look that fails after a newer one was taken never overwrites the newer look’s schedule (CodeRabbit)', async () => {
          const { artifactId } = await setUp();
          const order = await longOrder(artifactId, word(), 'chg_LW60', 60, { checks: 3, checkedAt: new Date(Date.now() - 3 * DAY), lastReadAt: new Date(Date.now() - 3 * DAY), nextLookAt: new Date(Date.now() - 60_000) });
          const newer = new Date(Date.now() + 5_000);
          const scheduled = new Date(Date.now() + 9 * DAY);
          // The first look is still in flight when a newer look takes the order, reads the service and sets the age-based schedule; then the first one fails
          mockSend.current = async () => {
            await prisma.appPageOrder.update({ where: { id: order.id }, data: { checkedAt: newer, checks: { increment: 1 }, lastReadAt: newer, nextLookAt: scheduled } });
            return { status: 503, body: { error: 'down' } };
          };
          await verifyOrder(order.id, undefined, undefined, { background: true });
          expect((await row(order.id)).nextLookAt!.getTime()).toBe(scheduled.getTime());
        });

        it('a look at a disconnected app is counted and backed off only when it is DUE, by the same rule as a connected one: a page that refreshes inside the spacing changes nothing (CodeRabbit)', async () => {
          const made = await pending();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
          const lastLook = new Date(Date.now() - 30_000);
          const scheduled = new Date(Date.now() + 5 * DAY);
          const order = await longOrder(made.artifactId, word(), 'chg_LW52', 60, { checks: 5, checkedAt: lastLook, lastReadAt: lastLook, nextLookAt: scheduled });
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { connectionId: null } });
          await prisma.appPageJob.deleteMany({ where: { artifactId: made.artifactId } });
          await prisma.appConnection.delete({ where: { id: made.connectionId } });
          // A refresh of the page: the order was looked at half a minute ago, so this is not a look that is due: nothing is counted, nothing moves
          await verifyOrder(order.id);
          expect(await row(order.id)).toMatchObject({ checks: 5, checkedAt: lastLook, nextLookAt: scheduled });
          // A look that is due (the order's own schedule, asked by the sweep) is a failed look that needs a person: counted once, backed off
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { checkedAt: new Date(Date.now() - 2 * 3_600_000), nextLookAt: new Date(Date.now() - 1_000) } });
          await verifyOrder(order.id, undefined, undefined, { background: true });
          expect((await row(order.id)).checks).toBe(6);
          expect(await nextIn(order.id)).toBeGreaterThan(0);
        });

        it('with the platform’s room for looks spent the sweep stops asking the service, but the orders of its batch still get their own time read: a pending one past its open time ends, counted as moved and not as a look, and a closed late-window one first never blocks the rest (CodeRabbit)', async () => {
          const { artifactId, connectionId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, keyCallsPlatform: 1 } }, sara);
          await prisma.appKeyCall.create({ data: { connectionId, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:spent:1`, operation: 'x', state: 'done', outcome: 'ok' } });
          // First in line: an order closed a day ago (inside its late window), never looked at; behind it, three pending orders that ran out of their open hour
          const closed = await longOrder(artifactId, word(), 'chg_PS0', 1, { checkedAt: null, createdAt: new Date(Date.now() - 30 * 3_600_000) });
          const ran = [];
          for (let i = 1; i <= 3; i += 1) ran.push(await lostOrder(artifactId, word(), wish(), { status: 'pending', providerRef: `chg_PS${i}`, reconciled: false, createdAt: new Date(Date.now() - (5 - i) * 3_600_000 - 3_600_000), checkedAt: null, checkoutUrl: 'https://checkout.examplepay.com/?mode=page&token=abc' }));
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          const noRoomBefore = lookStats.noRoom;
          const done = await sweepPageOrders();
          // Nothing was asked of the service, no room was used, and every pending order ended. Only the first order found the platform's room spent: the rest of the batch never asked the budget
          expect(lookStats.noRoom - noRoomBefore).toBe(1);
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(0);
          expect(await prisma.appKeyCall.count({ where: { ownerId: 'page-payments' } })).toBe(1);
          for (const order of ran) expect((await row(order.id)).status).toBe('not_paid');
          expect((await row(closed.id)).status).toBe('not_paid');
          expect(done).toMatchObject({ looked: 0, moved: 3 });
        });

        it('an order that ran out of time while its OWNER had no room for looks ends, and the sweep counts it as moved before it moves on (CodeRabbit)', async () => {
          const { artifactId, connectionId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, paymentLooksPerOwner: 1 } }, sara);
          await prisma.appKeyCall.create({ data: { connectionId, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:spent:1`, operation: 'x', state: 'done', outcome: 'ok' } });
          const ran = await lostOrder(artifactId, word(), wish(), { status: 'pending', providerRef: 'chg_OW1', reconciled: false, createdAt: new Date(Date.now() - 3 * 3_600_000), checkedAt: null, checkoutUrl: 'https://checkout.examplepay.com/?mode=page&token=abc' });
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          const done = await sweepPageOrders();
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(0);
          expect((await row(ran.id)).status).toBe('not_paid');
          // N12 (d522f4b3 pass): the sweep's closing is dated by the end of the open time (created 3 hours ago, open 1 hour), not by the sweep
          expect((await row(ran.id)).closedAt?.getTime()).toBe((await row(ran.id)).createdAt.getTime() + 3_600_000);
          expect(done).toMatchObject({ looked: 0, moved: 1 });
        });

        it('a closed order refused for its OWNER’s room first never leaves that owner’s expired pending order "checking": it ends without a look, in this sweep and not only in a later one (CodeRabbit)', async () => {
          const { artifactId, connectionId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, paymentLooksPerOwner: 1 } }, sara);
          await prisma.appKeyCall.create({ data: { connectionId, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:spent:1`, operation: 'x', state: 'done', outcome: 'ok' } });
          const url = 'https://checkout.examplepay.com/?mode=page&token=abc';
          // First in line: an order closed a day ago (inside its late window), never looked at; behind it, one pending order of the same owner past its open hour, and one still inside it
          const closed = await longOrder(artifactId, word(), 'chg_EX0', 1, { checkedAt: null, createdAt: new Date(Date.now() - 30 * 3_600_000) });
          const ran = await lostOrder(artifactId, word(), wish(), { status: 'pending', providerRef: 'chg_EX1', reconciled: false, createdAt: new Date(Date.now() - 3 * 3_600_000), checkedAt: null, checkoutUrl: url });
          const fresh = await lostOrder(artifactId, word(), wish(), { status: 'pending', providerRef: 'chg_EX2', reconciled: false, createdAt: new Date(Date.now() - 10 * 60_000), checkedAt: null, checkoutUrl: url });
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          const done = await sweepPageOrders();
          // The owner's room stays spent: nothing was asked of the service for any of them and no room was used. The expired one ended; the closed one was left exactly as it was; the one inside its open hour is still open
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(0);
          expect(await prisma.appKeyCall.count({ where: { ownerId: 'page-payments' } })).toBe(1);
          expect((await row(ran.id)).status).toBe('not_paid');
          expect(await row(closed.id)).toMatchObject({ status: 'not_paid', checks: 0, checkedAt: null });
          expect(await row(fresh.id)).toMatchObject({ status: 'pending', checks: 0, checkedAt: null });
          expect(done).toMatchObject({ looked: 0, moved: 1 });
        });

        it('while one owner’s room is spent and their expired orders end without a look, another owner’s order is still asked about at the service (CodeRabbit)', async () => {
          const { artifactId, connectionId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, paymentLooksPerOwner: 1 } }, sara);
          await prisma.appKeyCall.create({ data: { connectionId, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:spent:1`, operation: 'x', state: 'done', outcome: 'ok' } });
          const url = 'https://checkout.examplepay.com/?mode=page&token=abc';
          await longOrder(artifactId, word(), 'chg_EX10', 1, { checkedAt: null, createdAt: new Date(Date.now() - 30 * 3_600_000) });
          // Omar's order has room: it is asked about at the service like any other, and found paid
          const his = await lostOrder(artifactId, word(), wish(), { status: 'pending', providerRef: 'chg_EX11', reconciled: false, ownerId: omar, createdAt: new Date(Date.now() - 3 * 3_600_000), checkedAt: null, checkoutUrl: url });
          const sent = gateway({ record: () => paidRecord(his.id, { status: 'INITIATED' }) });
          await sweepPageOrders();
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
          expect((await row(his.id)).checks).toBe(1);
        });

        it('a look at a disconnected app never records a failed look on an order that was marked paid after it was read: the answer is the order as it is now (CodeRabbit)', async () => {
          const made = await pending();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
          const lastLook = new Date(Date.now() - 2 * 3_600_000);
          const order = await longOrder(made.artifactId, word(), 'chg_LW57', 60, { checks: 5, checkedAt: lastLook, lastReadAt: lastLook, nextLookAt: new Date(Date.now() - 1_000) });
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { connectionId: null } });
          await prisma.appPageJob.deleteMany({ where: { artifactId: made.artifactId } });
          await prisma.appConnection.delete({ where: { id: made.connectionId } });
          // An earlier look finds the payment while this one is deciding that the app cannot be asked: the paid move leaves the count, the last look and the schedule as they were
          const real = prisma.appPageJob.findUnique.bind(prisma.appPageJob);
          const spy = jest.spyOn(prisma.appPageJob, 'findUnique').mockImplementationOnce(((args: never) => prisma.appPageOrder.update({ where: { id: order.id }, data: { status: 'paid' } }).then(() => real(args))) as never);
          let told;
          try {
            told = await verifyOrder(order.id, undefined, undefined, { background: true });
          } finally {
            spy.mockRestore();
          }
          expect(await row(order.id)).toMatchObject({ status: 'paid', checks: 5, checkedAt: lastLook });
          expect(told).toMatchObject({ status: 'paid', orderId: order.id });
          expect(isWaiting(told!)).toBe(false);
        });

        it('a look at a disconnected app that is DUE and still disconnected records one failed look, and answers that it is waiting (CodeRabbit)', async () => {
          const made = await pending();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
          const lastLook = new Date(Date.now() - 2 * 3_600_000);
          const order = await longOrder(made.artifactId, word(), 'chg_LW58', 60, { checks: 5, checkedAt: lastLook, lastReadAt: lastLook, nextLookAt: new Date(Date.now() - 1_000) });
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { connectionId: null } });
          await prisma.appPageJob.deleteMany({ where: { artifactId: made.artifactId } });
          await prisma.appConnection.delete({ where: { id: made.connectionId } });
          const told = await verifyOrder(order.id, undefined, undefined, { background: true });
          expect((await row(order.id)).checks).toBe(6);
          expect(told).toMatchObject({ status: 'not_paid' });
          expect(isWaiting(told!)).toBe(true);
        });

        it('a look whose reservation committed but whose answer was lost is never found by the next one as a row that exists: it is looked at, and counted once (CodeRabbit)', async () => {
          const { artifactId } = await setUp();
          const order = await longOrder(artifactId, word(), 'chg_LW53', 60, { checks: 2, checkedAt: new Date(Date.now() - 3 * DAY), lastReadAt: new Date(Date.now() - 3 * DAY), nextLookAt: new Date(Date.now() - 60_000) });
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          // The first attempt's transaction commits (its claim and its row are kept) and the answer is lost
          const real = prisma.$transaction.bind(prisma) as (fn: unknown, options?: unknown) => Promise<unknown>;
          const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: unknown, options?: unknown) => real(fn, options).then(() => Promise.reject(new Error('the connection was lost')))) as never);
          const first: { contacted: boolean } = { contacted: false };
          try {
            await verifyOrder(order.id, undefined, first, { background: true });
          } finally {
            spy.mockRestore();
          }
          expect(first.contacted).toBe(false);
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(0);
          // It was a look that was not read: tried again soon (a time still to come, so a sweep does not return to it at once), never a month later
          expect(await nextIn(order.id)).toBeGreaterThan(0);
          expect(await nextIn(order.id)).toBeLessThanOrEqual(15 * 60_000 + 5_000);
          // The next attempt (due again) goes through, with a row of its own
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { nextLookAt: new Date(Date.now() - 1_000) } });
          const second: { contacted: boolean } = { contacted: false };
          await verifyOrder(order.id, undefined, second, { background: true });
          expect(second.contacted).toBe(true);
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
          expect(await prisma.appKeyCall.count({ where: { ownerId: 'page-payments', callId: { startsWith: `look:${sara}:${order.id}:` } } })).toBe(2);
        });

        it('a row left under the same count by an attempt whose commit was lost never blocks the next look: each attempt has a reservation of its own (CodeRabbit)', async () => {
          const { artifactId, connectionId } = await setUp();
          const order = await longOrder(artifactId, word(), 'chg_LW56', 60, { checks: 2, checkedAt: new Date(Date.now() - 3 * DAY), lastReadAt: new Date(Date.now() - 3 * DAY), nextLookAt: new Date(Date.now() - 60_000) });
          // What an attempt that took the count 3 left behind (its commit went through, its answer was lost)
          await prisma.appKeyCall.create({ data: { connectionId, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:${order.id}:3`, operation: 'x', state: 'done', outcome: 'ok' } });
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          const trace: { contacted: boolean } = { contacted: false };
          await verifyOrder(order.id, undefined, trace, { background: true });
          expect(trace.contacted).toBe(true);
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
        });

        it('a look that finds no room keeps the order exactly as it was, with no write of its own outside the transaction (not even one that would undo a claim): the decision and the claim are one transaction (CodeRabbit)', async () => {
          const { artifactId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, paymentLooksPerOwner: 1 } }, sara);
          const first = new Date(Date.now() - 3 * DAY);
          const scheduled = new Date(Date.now() - 60_000);
          const order = await longOrder(artifactId, word(), 'chg_LW54', 60, { checks: 3, checkedAt: first, lastReadAt: first, nextLookAt: scheduled });
          await prisma.appKeyCall.create({ data: { connectionId: (await row(order.id)).connectionId!, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:spent:1`, operation: 'x', state: 'done', outcome: 'ok' } });
          // The denied look writes nothing to the order outside its transaction: not a compensating write, not a rollback. Any top-level write is counted (and fails, as a database that went away would make it fail)
          let writes = 0;
          const spy = jest.spyOn(prisma.appPageOrder, 'updateMany').mockImplementation((() => {
            writes += 1;
            return Promise.reject(new Error('the database went away'));
          }) as never);
          try {
            await verifyOrder(order.id, undefined, undefined, { background: true });
          } finally {
            spy.mockRestore();
          }
          expect(writes).toBe(0);
          const kept = await row(order.id);
          expect({ checks: kept.checks, checkedAt: kept.checkedAt?.getTime(), nextLookAt: kept.nextLookAt?.getTime() }).toEqual({ checks: 3, checkedAt: first.getTime(), nextLookAt: scheduled.getTime() });
        });

        it('a read never moves the time of the last good read backward: a look that was taken earlier and answers later leaves a newer read as it is (CodeRabbit)', async () => {
          const { artifactId } = await setUp();
          const newer = new Date(Date.now() + 60_000);
          const order = await longOrder(artifactId, word(), 'chg_LW55', 60, { checks: 3, checkedAt: new Date(Date.now() - 3 * DAY), lastReadAt: newer, nextLookAt: new Date(Date.now() - 60_000) });
          gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          await verifyOrder(order.id, undefined, undefined, { background: true });
          expect((await row(order.id)).lastReadAt!.getTime()).toBe(newer.getTime());
          // A read that is newer than the one kept still moves it forward
          await prisma.appPageOrder.update({ where: { id: order.id }, data: { lastReadAt: new Date(Date.now() - 3 * DAY), nextLookAt: new Date(Date.now() - 1_000) } });
          await verifyOrder(order.id, undefined, undefined, { background: true });
          expect((await row(order.id)).lastReadAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
        });

        it('a budget denial restores the state immediately before ITS claim: a look that came in between the read and the claim is never undone (CodeRabbit)', async () => {
          const { artifactId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, paymentLooksPerOwner: 1 } }, sara);
          const first = new Date(Date.now() - 3 * DAY);
          const mid = new Date(Date.now() - 2 * 3_600_000);
          const scheduled = new Date(Date.now() + 9 * DAY);
          const order = await longOrder(artifactId, word(), 'chg_LW70', 60, { checks: 3, checkedAt: first, lastReadAt: first, nextLookAt: new Date(Date.now() - 60_000) });
          // The owner's hourly room is spent
          await prisma.appKeyCall.create({ data: { connectionId: (await row(order.id)).connectionId!, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:spent:1`, operation: 'x', state: 'done', outcome: 'ok' } });
          // Another look reads the order and finishes between this check's read of the order and its claim (its transaction)
          const real = prisma.$transaction.bind(prisma) as (fn: unknown, options?: unknown) => Promise<unknown>;
          const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: unknown, options?: unknown) =>
            prisma.appPageOrder.update({ where: { id: order.id }, data: { checkedAt: mid, checks: { increment: 1 }, lastReadAt: mid, nextLookAt: scheduled } }).then(() => real(fn, options))) as never);
          await verifyOrder(order.id, undefined, undefined, { explicit: true });
          spy.mockRestore();
          const kept = await row(order.id);
          expect({ checks: kept.checks, checkedAt: kept.checkedAt?.getTime(), lastReadAt: kept.lastReadAt?.getTime(), nextLookAt: kept.nextLookAt?.getTime() }).toEqual({ checks: 4, checkedAt: mid.getTime(), lastReadAt: mid.getTime(), nextLookAt: scheduled.getTime() });
        });

        it('one owner’s spent room never keeps the sweep from other owners: the denied orders stay due as they were, the pass goes on to the others, and the platform’s spent room ends it (CodeRabbit)', async () => {
          const { artifactId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, paymentLooksPerOwner: 1 } }, sara);
          // Sara's room for looks is spent; she has 52 orders due (more than one pass takes), the oldest first; Omar has one, due later
          const first = await longOrder(artifactId, word(), 'chg_LW80', 60, { nextLookAt: new Date(Date.now() - 600 * 60_000) });
          await prisma.appKeyCall.create({ data: { connectionId: first.connectionId!, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:spent:1`, operation: 'x', state: 'done', outcome: 'ok' } });
          const hers: string[] = [first.id];
          for (let i = 1; i < 52; i += 1) hers.push((await longOrder(artifactId, word(), `chg_LW8${i}`, 60, { nextLookAt: new Date(Date.now() - (600 - i) * 60_000) })).id);
          const his = await longOrder(artifactId, word(), 'chg_LW90', 60, { ownerId: omar, nextLookAt: new Date(Date.now() - 60_000) });
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          await sweepPageOrders();
          // Omar's was asked about (his room is his own); not one of Sara's was, and every one of hers is exactly as due as it was
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
          expect((await row(his.id)).checks).toBe(1);
          for (const id of hers) expect(await row(id)).toMatchObject({ checks: 0, checkedAt: null });
          expect(await prisma.appPageOrder.count({ where: { id: { in: hers }, nextLookAt: { lte: new Date() } } })).toBe(52);
        });

        it('the platform’s own spent room ends the pass at once: nobody has any, so no further order is tried', async () => {
          const { artifactId } = await setUp();
          await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48, keyCallsPlatform: 1 } }, sara);
          const a = await longOrder(artifactId, word(), 'chg_LW95', 60, { nextLookAt: new Date(Date.now() - 600 * 60_000) });
          await prisma.appKeyCall.create({ data: { connectionId: a.connectionId!, ownerId: 'page-payments', botId: 'page-payments', callId: `look:${sara}:spent:1`, operation: 'x', state: 'done', outcome: 'ok' } });
          for (let i = 0; i < 5; i += 1) await longOrder(artifactId, word(), `chg_LW96${i}`, 60, { ownerId: omar, nextLookAt: new Date(Date.now() - (500 - i) * 60_000) });
          const before = lookStats.noRoom;
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          await sweepPageOrders();
          expect(lookStats.noRoom - before).toBe(1);
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(0);
        });

        it('Restore asks about the orders of the page’s current offer first: five older orders at an old price never use up every look and leave the current one unchecked (CodeRabbit)', async () => {
          const { artifactId } = await setUp();
          const code = word();
          const keys = [buyerOf(code)];
          const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
          for (let i = 0; i < 5; i += 1) await longOrder(artifactId, code, `chg_OLD${i}`, 60, { amountMinor: jobRow.amountMinor + 1000, checkedAt: null });
          // The order at the current price is still open, and was captured at the service
          const current = await lostOrder(artifactId, code, wish(), { status: 'pending', providerRef: 'chg_CUR', reconciled: false, createdAt: new Date(Date.now() - 20 * 60_000), checkedAt: new Date(Date.now() - 3_600_000), checkoutUrl: 'https://checkout.examplepay.com/?mode=page&token=abc' });
          mockSend.current = (target) => (target.path.includes('chg_CUR') ? { status: 200, body: paidRecord(current.id, { id: 'chg_CUR' }) } : { status: 200, body: { id: 'old', status: 'INITIATED', amount: 5.5, currency: 'KWD', live_mode: false, reference: { order: 'x' } } });
          expect(await restorePurchase({ artifactId, buyerKeys: keys, ownKeys: keys })).toMatchObject({ status: 'paid', orderId: current.id });
        });

        it('a cannot-confirm order that reads as still started keeps the time it closed at: the buyer’s 90 days do not start over (CodeRabbit)', async () => {
          const { artifactId } = await setUp();
          const code = word();
          const keys = [buyerOf(code)];
          const created = new Date(Date.now() - 200 * DAY);
          const order = await lostOrder(artifactId, code, wish(), { status: 'cant_confirm', providerRef: 'chg_CC1', reconciled: false, createdAt: created, closedAt: null, nextLookAt: null });
          gateway({ record: () => paidRecord(order.id, { status: 'INITIATED' }) });
          await verifyOrder(order.id, undefined, undefined, { background: true });
          const kept = await row(order.id);
          expect(kept.status).toBe('not_paid');
          // Closed as of when its open time ran out (an hour after it began), not now
          expect(kept.closedAt!.getTime()).toBe(created.getTime() + 3_600_000);
          expect(await restorePurchase({ artifactId, buyerKeys: keys, ownKeys: keys })).toMatchObject({ status: 'checking', longWait: true, longWaitOver: true, orderId: order.id });
        });

        it('the long-wait pass takes a fixed batch per sweep, the oldest look first', async () => {
          const { artifactId } = await setUp();
          const ids: string[] = [];
          for (let i = 0; i < 52; i += 1) ids.push((await longOrder(artifactId, word(), `chg_LB${i}`, 102, { nextLookAt: new Date(Date.now() - (60 - i) * 60_000) })).id);
          const sent = gateway({ record: () => paidRecord('x', { status: 'INITIATED' }) });
          await sweepPageOrders();
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(50);
          // The two whose looks were most recently due are the ones left for the next pass
          expect(await prisma.appPageOrder.count({ where: { id: { in: ids }, checkedAt: null } })).toBe(2);
          expect((await row(ids[50])).checkedAt).toBeNull();
          expect((await row(ids[51])).checkedAt).toBeNull();
        });
      });

      it('the short look interval is only for Check payment and Restore: a page that refreshes itself, a poll or a notice keeps the age-grown spacing on an order in the long wait', async () => {
        const { artifactId } = await pending();
        await saveServerLimits({ bricks: { paymentCheckSeconds: 5, checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
        const code = word();
        const intentId = wish();
        const order = await lostOrder(artifactId, code, intentId, { status: 'not_paid', providerRef: 'chg_TS01', reconciled: false, createdAt: new Date(Date.now() - 80 * 3_600_000), closedAt: new Date(Date.now() - 60 * 3_600_000), nextLookAt: null });
        const recent = () => prisma.appPageOrder.update({ where: { id: order.id }, data: { checkedAt: new Date(Date.now() - 30_000) } });
        const sent = gateway({ record: () => paidRecord(order.id, { status: 'INITIATED' }) });
        const GETS = () => sent.filter((target) => target.method === 'GET').length;
        // Thirty seconds after its last look: the passive askers (the done page's refresh, the poll, the notice) are spaced like any order of that age (5 seconds a minute of age, up to 60)
        await recent();
        await verifyOrder(order.id);
        await verifyOrder(order.id);
        expect(GETS()).toBe(0);
        // The buyer pressing Check payment is looked at as soon as the ordinary spacing allows
        await checkPurchase({ artifactId, buyerKeys: [buyerOf(code)], intentId });
        expect(GETS()).toBe(1);
        // And so is Restore
        await recent();
        await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] });
        expect(GETS()).toBe(2);
      });

      it('gives a reloaded buyer a way forward: Restore carries their unfinished start on and hands back its own link', async () => {
        const { artifactId } = await pending();
        const code = word();
        const lost = await lostOrder(artifactId, code, wish());
        const sent = gateway();
        const restored = await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] });
        expect(restored).toMatchObject({ status: 'checking', orderId: lost.id, via: 'own' });
        expect(restored.checkoutUrl).toBe('https://checkout.examplepay.com/?mode=page&token=abc');
        expect(JSON.parse(POSTS(sent)[0].body as string)).toMatchObject({ reference: { order: lost.id } });
      });

      it('an early reload: Restore says it is still going on (no link, its own), asks nothing, and the same Restore after the wait carries it on', async () => {
        const { artifactId } = await pending();
        const code = word();
        // The server stopped a moment ago: the start is too recent to be taken over
        const lost = await lostOrder(artifactId, code, wish(), { createdAt: new Date(Date.now() - 2_000), checkedAt: new Date(Date.now() - 1_000) });
        const sent = gateway();
        const early = await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] });
        expect(early).toMatchObject({ status: 'checking', orderId: lost.id, via: 'own', checkoutUrl: null });
        expect(early.pollAfterMs).toBeGreaterThan(0);
        expect(POSTS(sent)).toHaveLength(0);
        // The wait is over: asked again, the same order goes on with the same id and the link comes back
        await prisma.appPageOrder.update({ where: { id: lost.id }, data: { createdAt: new Date(Date.now() - 120_000), checkedAt: new Date(Date.now() - 120_000) } });
        const later = await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] });
        expect(later).toMatchObject({ status: 'checking', orderId: lost.id, via: 'own' });
        expect(later.checkoutUrl).toBe('https://checkout.examplepay.com/?mode=page&token=abc');
        expect(POSTS(sent)).toHaveLength(1);
        // A receipt code alone never gets that far
        const other = word();
        await lostOrder(artifactId, other, wish());
        expect((await restorePurchase({ artifactId, buyerKeys: [buyerOf(other)], ownKeys: [buyerOf(code)] })).checkoutUrl ?? null).toBeNull();
      });

      it('refuses to carry on a start for an offer the owner has changed since, and sends the description the order was made with', async () => {
        const { artifactId, connectionId } = await pending();
        const code = word();
        const lost = await lostOrder(artifactId, code, wish(), { description: 'An old mug' });
        await prisma.appPageJob.update({ where: { artifactId }, data: { amountMinor: 9000 } });
        const sent = gateway();
        expect((await begin(artifactId, lost.intentId as string, code)).status).toBe('unavailable');
        expect(sent).toHaveLength(0);
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: lost.id } })).toMatchObject({ status: 'not_paid' });
        expect((await prisma.appPageOrderEvent.findMany({ where: { orderId: lost.id } })).map((line) => line.reason)).toContain('resume_offer_changed');
        // Same offer, but the owner's words changed: what the first start would have sent is what is sent
        await prisma.appPageJob.update({ where: { artifactId }, data: { amountMinor: lost.amountMinor, description: 'A new mug' } });
        const second = await lostOrder(artifactId, code, wish(), { description: 'An old mug' });
        const sent2 = gateway();
        expect((await begin(artifactId, second.intentId as string, code)).status).toBe('ok');
        expect(JSON.parse(POSTS(sent2)[0].body as string).description).toBe('An old mug');
        expect(connectionId).toBeDefined();
      });

      it('does not hand back an old price’s checkout as the offer’s, and asks about the orders asked longest ago first', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const code = word();
        const key = buyerOf(code);
        const open = await begin(artifactId, wish(), code);
        if (open.status !== 'ok') throw new Error('expected ok');
        await prisma.appPageJob.update({ where: { artifactId }, data: { amountMinor: 9000 } });
        expect(await restorePurchase({ artifactId, buyerKeys: [key] })).toMatchObject({ status: 'none' });
        await prisma.appPageJob.update({ where: { artifactId }, data: { amountMinor: 4500 } });
        // Six open orders: the five newest were asked about a moment ago, the oldest never. Restore reaches the oldest, which was paid.
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        await prisma.appPageOrder.deleteMany({ where: { artifactId } });
        const made: string[] = [];
        for (let n = 0; n < 6; n += 1) {
          const row = await prisma.appPageOrder.create({
            data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: 4500, currency: 'KWD', mode: 'test', status: 'pending', providerRef: `chg_${n}`, checkoutUrl: 'https://checkout.examplepay.com/?token=x', visitorHash: 'v', intentId: wish(), buyerKey: key, createdAt: new Date(Date.now() - (6 - n) * 60_000), checkedAt: n === 0 ? null : new Date() },
          });
          made.push(row.id);
        }
        mockSend.current = () => ({ status: 200, body: paidRecord(made[0]) });
        const found = await restorePurchase({ artifactId, buyerKeys: [key] });
        expect(found).toMatchObject({ status: 'paid', orderId: made[0] });
      });

      it('prefers a live purchase however many newer test purchases there are', async () => {
        const { artifactId } = await pending();
        const code = word();
        const key = buyerOf(code);
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        const make = (mode: string, minutes: number) =>
          prisma.appPageOrder.create({
            data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode, status: 'paid', paidAt: new Date(Date.now() - minutes * 60_000), visitorHash: 'v', intentId: wish(), buyerKey: key },
          });
        const live = await make('live', 600);
        for (let n = 0; n < 21; n += 1) await make('test', n);
        expect(await restorePurchase({ artifactId, buyerKeys: [key] })).toMatchObject({ status: 'paid', orderId: live.id, testPayment: false });
      });

      it('finds a late payment by when the order closed, not when it was made, in the sweep and in Restore', async () => {
        const { artifactId } = await pending();
        const code = word();
        const limits = await getBrickLimits();
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        // Made long ago, closed an hour ago (its open time had run out only just then): still inside the late window
        const row = await prisma.appPageOrder.create({
          data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'not_paid', providerRef: 'chg_late', checkoutUrl: 'https://checkout.examplepay.com/?token=x', visitorHash: 'v', intentId: wish(), buyerKey: buyerOf(code), createdAt: new Date(Date.now() - (limits.checkoutOpenHours + limits.latePaymentHours + 5) * 3_600_000), closedAt: new Date(Date.now() - 3_600_000) },
        });
        mockSend.current = () => ({ status: 200, body: paidRecord(row.id) });
        expect(await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] })).toMatchObject({ status: 'paid', orderId: row.id });
        await prisma.appPageOrder.update({ where: { id: row.id }, data: { status: 'not_paid', paidAt: null, checkedAt: null } });
        expect((await sweepPageOrders()).moved).toBeGreaterThanOrEqual(1);
        expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('paid');
      });

      it('lets the buyer find it with Check payment on the ORIGINAL wish, long after the window, without making a second order', async () => {
        const { artifactId } = await pending();
        const code = word();
        const intentId = wish();
        const limits = await getBrickLimits();
        gateway();
        const made = await begin(artifactId, intentId, code);
        if (made.status !== 'ok') throw new Error('expected ok');
        await prisma.appPageOrder.update({ where: { id: made.orderId }, data: { status: 'not_paid', createdAt: new Date(Date.now() - (limits.checkoutOpenHours + limits.latePaymentHours + 40) * 3_600_000), closedAt: new Date(Date.now() - (limits.latePaymentHours + 30) * 3_600_000), checkedAt: new Date(Date.now() - 24 * 3_600_000) } });
        const sent = gateway({ record: (order) => paidRecord(order) });
        const found = await checkPurchase({ artifactId, buyerKeys: [buyerOf(code)], intentId });
        expect(found).toMatchObject({ status: 'paid', orderId: made.orderId });
        // The original order, never a second one: nothing was started at the service
        expect(await orders(artifactId)).toHaveLength(1);
        expect(sent.filter((entry) => entry.method === 'POST')).toHaveLength(0);
      });

      it('finds it through Restore too, once, and a second Restore of the same paid purchase gives the same order and changes nothing', async () => {
        const { artifactId } = await pending();
        const code = word();
        const limits = await getBrickLimits();
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        const row = await prisma.appPageOrder.create({
          data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'not_paid', providerRef: 'chg_long', checkoutUrl: 'https://checkout.examplepay.com/?token=x', visitorHash: 'v', intentId: wish(), buyerKey: buyerOf(code), createdAt: new Date(Date.now() - (limits.checkoutOpenHours + limits.latePaymentHours + 90) * 3_600_000), closedAt: new Date(Date.now() - (limits.latePaymentHours + 80) * 3_600_000) },
        });
        const before = (await notices()).length;
        mockSend.current = () => ({ status: 200, body: paidRecord(row.id) });
        const first = await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] });
        expect(first).toMatchObject({ status: 'paid', orderId: row.id });
        const paidAt = (await prisma.appPageOrder.findUniqueOrThrow({ where: { id: row.id } })).paidAt;
        const [second, third] = await Promise.all([restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] }), restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] })]);
        // The same entitlement: the same order every time, no new order, no second notice, the paid time never moves
        expect([second.orderId, third.orderId]).toEqual([row.id, row.id]);
        expect(await orders(artifactId)).toHaveLength(1);
        expect((await notices()).slice(before)).toHaveLength(1);
        expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: row.id } })).paidAt).toEqual(paidAt);
        expect(await prisma.appPageOrderEvent.count({ where: { orderId: row.id, toStatus: 'paid' } })).toBe(1);
      });

      describe('an order the service has not had the last word about (round 2)', () => {
        /** A guest's order that is long closed: it has its reference at the service, which still says "started", and nothing final was ever said. */
        const longWaitOrder = async (hoursClosed = 100) => {
          const { artifactId } = await pending();
          const code = word();
          const intentId = wish();
          const limits = await getBrickLimits();
          gateway();
          const made = await begin(artifactId, intentId, code);
          if (made.status !== 'ok') throw new Error('expected ok');
          await prisma.appPageOrder.update({ where: { id: made.orderId }, data: { status: 'not_paid', createdAt: new Date(Date.now() - (limits.checkoutOpenHours + hoursClosed) * 3_600_000), closedAt: new Date(Date.now() - hoursClosed * 3_600_000), checkedAt: new Date(Date.now() - 24 * 3_600_000), nextLookAt: null } });
          return { artifactId, code, intentId, orderId: made.orderId };
        };
        const ask = async (artifactId: string, body: Record<string, unknown>, address: string) => {
          mockUser.current = null;
          const response = await publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body, headers: { 'x-forwarded-for': address } }), params({ artifactId }));
          return { status: response.status, body: (await response.json()) as Record<string, unknown> };
        };

        it('Check payment and Restore both hand back the existing order as still being checked, never "not paid" and never "nothing found", and nothing is started again', async () => {
          const { artifactId, code, intentId, orderId } = await longWaitOrder();
          const sent = gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          // The same asks the host makes: Check payment by the wish, then Restore, as a guest with the browser's own recovery code
          const check = await ask(artifactId, { check: true, intentId, recoveryCode: code }, '198.51.100.80');
          expect(check.status).toBe(200);
          expect(check.body).toMatchObject({ status: 'checking', longWait: true, orderId, checkoutUrl: null, buyer: 'guest' });
          const restored = await ask(artifactId, { restore: true, recoveryCode: code }, '198.51.100.81');
          expect(restored.status).toBe(200);
          expect(restored.body).toMatchObject({ status: 'checking', longWait: true, orderId, checkoutUrl: null, via: 'own' });
          expect(restored.body.status).not.toBe('none');
          // The rows: the same one order, still closed and still not reconciled, no second payment asked of the service, no entitlement
          expect(await orders(artifactId)).toHaveLength(1);
          expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'not_paid', reconciled: false });
          expect(await prisma.appPageOrder.count({ where: { artifactId, status: 'paid' } })).toBe(0);
          expect(POSTS(sent)).toHaveLength(0);
          // The order poll says the same (the host that adopted it must not say "not paid" a moment later)
          const polled = await orderForArtifact(orderId, artifactId);
          expect(polled).toMatchObject({ status: 'checking', longWait: true });
        });

        it('is the ordinary rate-limited check on the original order: pressing again at once asks the service once', async () => {
          const { artifactId, code, intentId } = await longWaitOrder();
          const sent = gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          for (let n = 0; n < 4; n += 1) expect((await ask(artifactId, { check: true, intentId, recoveryCode: code }, `198.51.100.${90 + n}`)).body).toMatchObject({ status: 'checking', longWait: true });
          for (let n = 0; n < 3; n += 1) expect((await ask(artifactId, { restore: true, recoveryCode: code }, `198.51.100.${100 + n}`)).body).toMatchObject({ status: 'checking', longWait: true });
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(1);
        });

        it('a later confirmed payment lands on the SAME order, with one entitlement and one notice, however it is asked for', async () => {
          const { artifactId, code, intentId, orderId } = await longWaitOrder();
          gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          expect((await ask(artifactId, { restore: true, recoveryCode: code }, '198.51.100.110')).body).toMatchObject({ status: 'checking', longWait: true });
          const before = (await notices()).length;
          // The service now says it was paid
          const sent = gateway({ record: (id) => paidRecord(id) });
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * 3_600_000) } });
          const checked = await ask(artifactId, { check: true, intentId, recoveryCode: code }, '198.51.100.111');
          expect(checked.body).toMatchObject({ status: 'paid', orderId });
          const [one, two] = await Promise.all([ask(artifactId, { restore: true, recoveryCode: code }, '198.51.100.112'), ask(artifactId, { restore: true, recoveryCode: code }, '198.51.100.113')]);
          expect([one.body, two.body]).toMatchObject([{ status: 'paid', orderId }, { status: 'paid', orderId }]);
          expect(await orders(artifactId)).toHaveLength(1);
          expect(await prisma.appPageOrder.count({ where: { artifactId, status: 'paid' } })).toBe(1);
          expect((await prisma.appPageOrderEvent.findMany({ where: { orderId, toStatus: 'paid' } })).map((line) => line.reason)).toEqual(['paid_late']);
          expect((await notices()).slice(before)).toHaveLength(1);
          expect(POSTS(sent)).toHaveLength(0);
        });

        it('is still "nothing found" for another buyer, and ends for good only on the service’s own last word', async () => {
          const { artifactId, code, intentId, orderId } = await longWaitOrder();
          gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          // Someone else's browser never sees it
          expect((await ask(artifactId, { restore: true, recoveryCode: word() }, '198.51.100.120')).body).toMatchObject({ status: 'none' });
          expect((await ask(artifactId, { check: true, intentId, recoveryCode: word() }, '198.51.100.121')).status).toBe(404);
          // The service says it failed: that is its last word, and now it is not paid and nothing is found
          gateway({ record: (id) => paidRecord(id, { status: 'FAILED' }) });
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 24 * 3_600_000) } });
          expect((await ask(artifactId, { check: true, intentId, recoveryCode: code }, '198.51.100.122')).body).toMatchObject({ status: 'not_paid', orderId });
          expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'not_paid', reconciled: true });
          expect((await ask(artifactId, { restore: true, recoveryCode: code }, '198.51.100.123')).body).toMatchObject({ status: 'none' });
        });

        it('an order that could not be confirmed (the app was gone) is handed back as still being checked too, by a receipt link as well', async () => {
          const { artifactId, code, orderId } = await longWaitOrder();
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { status: 'cant_confirm', closedAt: null } });
          gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          // Another browser holding only the receipt link's code: the order is found, and said to be a receipt's, never given a new receipt
          const via = await ask(artifactId, { restore: true, recoveryCode: word(), receiptCode: code }, '198.51.100.130');
          expect(via.body).toMatchObject({ status: 'checking', longWait: true, orderId, via: 'receipt' });
        });

        it('an order that could not be confirmed is still being checked for the order poll and Check payment too, never "cannot confirm", whether or not the service is asked this time; one the service settled as a payment for something else stays final', async () => {
          const { artifactId, code, intentId, orderId } = await longWaitOrder();
          // Looked at a moment ago, so this ask makes no look of its own and answers from the order as it stands
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { status: 'cant_confirm', closedAt: null, checkedAt: new Date() } });
          const sent = gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          expect(await orderForArtifact(orderId, artifactId)).toMatchObject({ status: 'checking', longWait: true, orderId, checkoutUrl: null });
          const check = await ask(artifactId, { check: true, intentId, recoveryCode: code }, '198.51.100.131');
          expect(check.body).toMatchObject({ status: 'checking', longWait: true, orderId, checkoutUrl: null });
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(0);
          // Reconciled (the service named a payment for something else): final, and said as it is
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { status: 'cant_confirm', reconciled: true, checkedAt: new Date() } });
          const final = await orderForArtifact(orderId, artifactId);
          expect(final).toMatchObject({ status: 'cant_confirm' });
          expect(final?.longWait).toBeUndefined();
        });

        it('the page a buyer returns to after paying tells an order that could not be confirmed the same way: still being checked while the service has not had the last word, its own words once settled', async () => {
          const { orderId } = await longWaitOrder();
          // Looked at a moment ago, so the return page makes no look of its own
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { status: 'cant_confirm', closedAt: null, checkedAt: new Date() } });
          const sent = gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          const waiting = await verifyOrderForReturnPage(orderId);
          expect(waiting).toMatchObject({ status: 'checking', longWait: true, orderId });
          // The plain look (what the page called before) would have said "cannot confirm" and scheduled nothing
          expect(await verifyOrder(orderId)).toMatchObject({ status: 'cant_confirm' });
          expect(sent.filter((target) => target.method === 'GET')).toHaveLength(0);
          // Settled (the service named a payment for something else): final, said as it is
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { reconciled: true } });
          const final = await verifyOrderForReturnPage(orderId);
          expect(final).toMatchObject({ status: 'cant_confirm' });
          expect(final?.longWait).toBeUndefined();
        });

        it('shows the ops numbers: orders never checked, scheduled looks that are overdue, and the time since the service was last read', async () => {
          const { orderId } = await longWaitOrder();
          // Never asked about by a sweep (no schedule) and never once read
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: null, lastReadAt: null } });
          expect((await pagePaymentLoad()).unconfirmed).toMatchObject({ count: 1, neverChecked: 1, neverRead: 1, overdue: 1 });
          expect((await pagePaymentLoad()).sinceLastReadSeconds).toBeNull();
          // Looked at on time: not overdue, and the last read is now
          gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          expect((await sweepPageOrders()).looked).toBe(1);
          const after = await pagePaymentLoad();
          expect(after.unconfirmed).toMatchObject({ count: 1, neverChecked: 0, neverRead: 0, overdue: 0 });
          expect(after.sinceLastReadSeconds).toBeLessThan(60);
          // Its scheduled look is two hours late (a stopped sweep): overdue, and the read ages
          await prisma.appPageOrder.update({ where: { id: orderId }, data: { nextLookAt: new Date(Date.now() - 2 * 3_600_000), lastReadAt: new Date(Date.now() - 5 * 3_600_000) } });
          const late = await pagePaymentLoad();
          expect(late.unconfirmed.overdue).toBe(1);
          expect(late.sinceLastReadSeconds).toBeGreaterThan(4.9 * 3_600);
        });

        it('Restore prefers a paid purchase, then an open order with its link, then the long-wait order, then nothing', async () => {
          const { artifactId, code, orderId: longId } = await longWaitOrder();
          const key = buyerOf(code);
          const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
          gateway({ record: (id) => paidRecord(id, { status: 'INITIATED' }) });
          // Only the long-wait order: still checking
          expect((await ask(artifactId, { restore: true, recoveryCode: code }, '198.51.100.140')).body).toMatchObject({ status: 'checking', longWait: true, orderId: longId });
          // An open order of the same buyer for the current offer wins over it, with its own link (and is not a long-wait one)
          const open = await prisma.appPageOrder.create({
            data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'pending', providerRef: 'chg_open', checkoutUrl: 'https://checkout.examplepay.com/?token=open', visitorHash: 'v', intentId: wish(), buyerKey: key, createdAt: new Date(Date.now() - 60_000), checkedAt: new Date() },
          });
          const second = (await ask(artifactId, { restore: true, recoveryCode: code }, '198.51.100.141')).body;
          expect(second).toMatchObject({ status: 'checking', orderId: open.id, checkoutUrl: 'https://checkout.examplepay.com/?token=open' });
          expect(second.longWait).toBeUndefined();
          // A paid purchase wins over both
          const paid = await prisma.appPageOrder.create({
            data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'paid', paidAt: new Date(Date.now() - 3_600_000), visitorHash: 'v', intentId: wish(), buyerKey: key },
          });
          expect((await ask(artifactId, { restore: true, recoveryCode: code }, '198.51.100.142')).body).toMatchObject({ status: 'paid', orderId: paid.id });
        });

        it('looks at least monthly for as long as it takes: 6 hours, then daily, then weekly until 90 days past the window, then monthly, with no end', () => {
          const day = 24 * 3_600_000;
          expect(reconcileEveryMs(0)).toBe(6 * 3_600_000);
          expect(reconcileEveryMs(2 * day)).toBe(6 * 3_600_000);
          expect(reconcileEveryMs(3 * day)).toBe(day);
          expect(reconcileEveryMs(32 * day)).toBe(day);
          expect(reconcileEveryMs(33 * day)).toBe(7 * day);
          expect(reconcileEveryMs(89 * day)).toBe(7 * day);
          expect(reconcileEveryMs(90 * day)).toBe(30 * day);
          expect(reconcileEveryMs(2_000 * day)).toBe(30 * day);
        });
      });

      it('never turns a cut-off or non-object body into a checkout, nor a start that does not say which version its page shows', async () => {
        const { artifactId } = await pending();
        const sent = gateway();
        const raw = (text: string | null, address: string) => publicStart(new NextRequest(`http://localhost/api/pay/${artifactId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address }, ...(text === null ? {} : { body: text }) }), params({ artifactId }));
        for (const [n, bad] of ['{"check":true,"intentId":"i1234567', '5', '"start"', '[]', 'null', '   ', '\n'].entries()) {
          const response = await raw(bad, `203.0.113.${40 + n}`);
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ code: 'bad_request' });
        }
        expect(POSTS(sent)).toHaveLength(0);
        // No body at all is a plain start that names no version: refused as a changed page, nothing sent
        const plain = await raw(null, '203.0.113.50');
        expect(plain.status).toBe(409);
        expect(await plain.json()).toMatchObject({ code: 'page_changed' });
        expect(POSTS(sent)).toHaveLength(0);
        expect((await raw('{"shownVersion":1}', '203.0.113.51')).status).toBe(200);
        expect(POSTS(sent)).toHaveLength(1);
      });

      it('counts only the looks that asked the service', async () => {
        const { artifactId } = await pending();
        const code = word();
        gateway();
        const made = await begin(artifactId, wish(), code);
        if (made.status !== 'ok') throw new Error('expected ok');
        // Quiet for the sweep, but asked about inside the order's own spacing: the verifier answers without asking the service
        await prisma.appPageOrder.update({ where: { id: made.orderId }, data: { checkedAt: new Date(Date.now() - 6 * 60_000), createdAt: new Date(Date.now() - 1_000) } });
        const limits = await getBrickLimits();
        await prisma.appPageOrder.update({ where: { id: made.orderId }, data: { checkedAt: new Date(Date.now() - Math.min(6 * 60_000, limits.paymentCheckSeconds * 1000 + 1_000) + 0) } });
        const before = lookStats.made;
        const sweep = await sweepPageOrders();
        expect(sweep.looked).toBe(lookStats.made - before);
      });
    });

    describe('Check payment', () => {
      it('asks the service about the buyer’s own order for that wish, and nobody else’s', async () => {
        const { artifactId } = await pending();
        gateway();
        const code = word();
        const intentId = wish();
        const made = await begin(artifactId, intentId, code);
        if (made.status !== 'ok') throw new Error('expected ok');
        expect(await checkPurchase({ artifactId, buyerKeys: [buyerOf(code)], intentId })).toMatchObject({ status: 'checking', orderId: made.orderId, testPayment: true });
        // Another buyer with the same wish id, another wish, another page: nothing
        expect(await checkPurchase({ artifactId, buyerKeys: [buyerOf(word())], intentId })).toBeNull();
        expect(await checkPurchase({ artifactId, buyerKeys: [buyerOf(code)], intentId: wish() })).toBeNull();
        const other = await makeArtifact();
        expect(await checkPurchase({ artifactId: other, buyerKeys: [buyerOf(code)], intentId })).toBeNull();
        // The payment is made at the service, the page never hears of it, and Check payment finds it
        gateway({ record: (order) => paidRecord(order) });
        await old(made.orderId);
        expect(await checkPurchase({ artifactId, buyerKeys: [buyerOf(code)], intentId })).toMatchObject({ status: 'paid', orderId: made.orderId, testPayment: true });
      });

      it('carries on an order whose start was lost before asking about it', async () => {
        const { artifactId } = await pending();
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        const code = word();
        const intentId = wish();
        await prisma.appPageOrder.create({
          data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'creating', visitorHash: 'v', intentId, buyerKey: buyerOf(code), createdAt: new Date(Date.now() - 120_000) },
        });
        gateway();
        expect(await checkPurchase({ artifactId, buyerKeys: [buyerOf(code)], intentId })).toMatchObject({ status: 'checking', checkoutUrl: 'https://checkout.examplepay.com/?mode=page&token=abc' });
      });
    });

    describe('Restore purchase', () => {
      it('finds this buyer’s paid order, finds a payment made late, and finds nobody else’s', async () => {
        const { artifactId } = await pending();
        gateway();
        const code = word();
        const made = await begin(artifactId, wish(), code);
        if (made.status !== 'ok') throw new Error('expected ok');
        // An order of theirs that is still open comes with its own link, so a reload or a lost pop-up goes on with the same order
        expect(await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] })).toMatchObject({ status: 'checking', orderId: made.orderId, checkoutUrl: made.checkoutUrl });
        // Paid at the service while nobody was watching: Restore asks about the open order first
        gateway({ record: (order) => paidRecord(order) });
        await old(made.orderId);
        const restored = await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] });
        expect(restored).toMatchObject({ status: 'paid', orderId: made.orderId, testPayment: true });
        // When it was paid, so the host can say "your purchase from 19 Nov is back"
        expect(Math.abs(new Date(restored.paidAt as string).getTime() - Date.now())).toBeLessThan(60_000);
        expect(await restorePurchase({ artifactId, buyerKeys: [buyerOf(word())] })).toMatchObject({ status: 'none', orderId: null });
        expect(await restorePurchase({ artifactId: await makeArtifact(), buyerKeys: [buyerOf(code)] })).toMatchObject({ status: 'none' });
      });

      it('prefers a live purchase and never gives a test one as live', async () => {
        const { artifactId } = await pending();
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        const code = word();
        const row = (mode: string, paidAt: Date) =>
          prisma.appPageOrder.create({
            data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode, status: 'paid', paidAt, visitorHash: 'v', intentId: wish(), buyerKey: buyerOf(code) },
          });
        const live = await row('live', new Date(Date.now() - 3_600_000));
        await row('test', new Date());
        expect(await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] })).toMatchObject({ status: 'paid', orderId: live.id, testPayment: false });
        await prisma.appPageOrder.delete({ where: { id: live.id } });
        expect(await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] })).toMatchObject({ status: 'paid', testPayment: true });
      });

      it('is for what the page sells now: an order at other terms is not this offer', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const code = word();
        const made = await begin(artifactId, wish(), code);
        if (made.status !== 'ok') throw new Error('expected ok');
        await old(made.orderId);
        await verifyOrder(made.orderId);
        expect(await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] })).toMatchObject({ status: 'paid' });
        await prisma.appPageJob.update({ where: { artifactId }, data: { amountMinor: 9_000 } });
        expect(await restorePurchase({ artifactId, buyerKeys: [buyerOf(code)] })).toMatchObject({ status: 'none' });
        // The original order can always be asked about with Check payment, whatever the page sells now
        expect(await checkPurchase({ artifactId, buyerKeys: [buyerOf(code)], intentId: (await prisma.appPageOrder.findUniqueOrThrow({ where: { id: made.orderId } })).intentId as string })).toMatchObject({ status: 'paid' });
      });
    });

    describe('through the game’s route and the public link', () => {
      const viewerOf = (identifier: string | null, chat = `chat-${tag}`) => ({ person: identifier ? { signedIn: true, identifier } : { signedIn: false, name: 'Visitor' }, inChat: true, chat: { kind: 'dm', ref: chat } });
      // A start says the version its page shows (version 1, the only one these pages have)
      const game = (artifactId: string, body: Record<string, unknown>) =>
        gamePay(request(`/api/artifacts/${artifactId}/pay`, { method: 'POST', token: ADMIN_TOKEN, body: body.start ? { shownVersion: 1, ...body } : body }), params({ id: artifactId }));
      const web = (artifactId: string, body: Record<string, unknown>, address = '203.0.113.9') =>
        publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: body.check || body.restore ? body : { shownVersion: 1, ...body }, headers: { 'x-forwarded-for': address } }), params({ artifactId }));

      it('binds a signed-in buyer to their account and a guest to their code', async () => {
        const { artifactId } = await pending();
        gateway();
        const intentId = wish();
        const code = word();
        const account = await game(artifactId, { viewer: viewerOf(`sara-${tag}`), start: true, intentId });
        expect(account.status).toBe(200);
        const guest = await game(artifactId, { viewer: viewerOf(null), start: true, intentId: wish(), recoveryCode: code });
        expect(guest.status).toBe(200);
        const rows = await orders(artifactId);
        expect(rows.map((row) => row.buyerKey)).toEqual([`acct:${sara}`, buyerOf(code)]);
      });

      it('tells the game who Orbit used as the buyer on every answer: a real account is "account"; a guest account or an anonymous guest is "guest"', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const guestAccount = await prisma.user.create({ data: { uuid: `guestacct-${tag}`, email: `guestacct-${tag}@example.test`, name: 'Guest', isGuest: true } });
        try {
          const code = word();
          // A real account: start, order view, check, restore
          const intentId = wish();
          const real = await (await game(artifactId, { viewer: viewerOf(`sara-${tag}`), start: true, intentId })).json();
          expect(real).toMatchObject({ buyer: 'account', reused: false });
          expect(real.orderId).toBeDefined();
          expect(await (await game(artifactId, { viewer: viewerOf(`sara-${tag}`), order: real.orderId })).json()).toMatchObject({ buyer: 'account', orderId: real.orderId });
          expect(await (await game(artifactId, { viewer: viewerOf(`sara-${tag}`), check: true, intentId })).json()).toMatchObject({ buyer: 'account', orderId: real.orderId });
          expect(await (await game(artifactId, { viewer: viewerOf(`sara-${tag}`), restore: true })).json()).toMatchObject({ buyer: 'account', orderId: real.orderId });
          // A signed-in person whose Orbit account is a guest account is a guest to Orbit, bound to the recovery code
          const gIntent = wish();
          const guestStart = await (await game(artifactId, { viewer: viewerOf(`guestacct-${tag}`), start: true, intentId: gIntent, recoveryCode: code })).json();
          expect(guestStart).toMatchObject({ buyer: 'guest' });
          expect((await orders(artifactId)).find((row) => row.id === guestStart.orderId)?.buyerKey).toBe(buyerOf(code));
          expect(await (await game(artifactId, { viewer: viewerOf(`guestacct-${tag}`), order: guestStart.orderId })).json()).toMatchObject({ buyer: 'guest' });
          expect(await (await game(artifactId, { viewer: viewerOf(`guestacct-${tag}`), check: true, intentId: gIntent, recoveryCode: code })).json()).toMatchObject({ buyer: 'guest', orderId: guestStart.orderId });
          expect(await (await game(artifactId, { viewer: viewerOf(`guestacct-${tag}`), restore: true, recoveryCode: code })).json()).toMatchObject({ buyer: 'guest', orderId: guestStart.orderId });
          // An anonymous guest with a recovery code, and one nobody can find (an identifier that is no account)
          expect(await (await game(artifactId, { viewer: viewerOf(null), start: true, intentId: wish(), recoveryCode: word() })).json()).toMatchObject({ buyer: 'guest' });
          expect(await (await game(artifactId, { viewer: viewerOf(null), restore: true, recoveryCode: word() })).json()).toMatchObject({ buyer: 'guest', status: 'none' });
          expect(await (await game(artifactId, { viewer: viewerOf(`nobody-${tag}`), restore: true, recoveryCode: word() })).json()).toMatchObject({ buyer: 'guest', status: 'none' });
          // The fields that were there are unchanged
          expect(Object.keys(real).sort()).toEqual(['amount', 'app', 'buyer', 'checkoutUrl', 'currency', 'orderId', 'reused']);
        } finally {
          await prisma.user.delete({ where: { id: guestAccount.id } }).catch(() => undefined);
        }
      });

      it('restores for the same account from the game, but not for another account or for a guest without the code', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const first = await (await game(artifactId, { viewer: viewerOf(`sara-${tag}`), start: true, intentId: wish() })).json();
        await old(first.orderId);
        const body = await (await game(artifactId, { viewer: viewerOf(`sara-${tag}`), restore: true })).json();
        expect(body).toMatchObject({ status: 'paid', orderId: first.orderId, testPayment: true });
        expect(await (await game(artifactId, { viewer: viewerOf(`omar-${tag}`), restore: true })).json()).toMatchObject({ status: 'none' });
        expect((await game(artifactId, { viewer: viewerOf(null), restore: true })).status).toBe(400);
        expect(await (await game(artifactId, { viewer: viewerOf(null), restore: true, recoveryCode: word() })).json()).toMatchObject({ status: 'none' });
      });

      it('answers Check payment for the buyer’s wish, 404 for another’s, and 400 for a guest with no code', async () => {
        const { artifactId } = await pending();
        gateway();
        const intentId = wish();
        const code = word();
        const made = await (await game(artifactId, { viewer: viewerOf(null), start: true, intentId, recoveryCode: code })).json();
        const mine = await game(artifactId, { viewer: viewerOf(null), check: true, intentId, recoveryCode: code });
        expect(mine.status).toBe(200);
        expect(await mine.json()).toMatchObject({ status: 'checking', orderId: made.orderId });
        expect((await game(artifactId, { viewer: viewerOf(null), check: true, intentId, recoveryCode: word() })).status).toBe(404);
        expect((await game(artifactId, { viewer: viewerOf(null), check: true, intentId })).status).toBe(400);
        expect((await game(artifactId, { viewer: viewerOf(null), start: true, intentId: wish() })).status).toBe(400);
        // A start that names no wish is made as before, with nothing to find it by
        const plain = await game(artifactId, { viewer: viewerOf(null), start: true });
        expect(plain.status).toBe(200);
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: (await plain.json()).orderId } })).toMatchObject({ intentId: null, buyerKey: null });
      });

      it('does the same on the public link, and never takes a start with a wish but no buyer', async () => {
        const { artifactId } = await pending();
        gateway();
        const intentId = wish();
        const code = word();
        const one = await (await web(artifactId, { intentId, recoveryCode: code })).json();
        const two = await (await web(artifactId, { intentId, recoveryCode: code }, '203.0.113.10')).json();
        expect(two.orderId).toBe(one.orderId);
        expect(two.reused).toBe(true);
        expect((await web(artifactId, { intentId: wish() })).status).toBe(400);
        expect((await web(artifactId, { intentId: 'no spaces allowed here', recoveryCode: code })).status).toBe(400);
        const check = await web(artifactId, { check: true, intentId, recoveryCode: code });
        expect(await check.json()).toMatchObject({ status: 'checking', orderId: one.orderId });
        expect((await web(artifactId, { check: true, intentId, recoveryCode: word() })).status).toBe(404);
        expect(await (await web(artifactId, { restore: true, recoveryCode: code })).json()).toMatchObject({ status: 'checking', orderId: one.orderId });
        expect((await web(artifactId, { restore: true })).status).toBe(400);
      });

      it('keeps a guest’s purchase after the same browser signs in: Restore, Check payment and the receipt link find it under the code, and a retried wish is not made twice', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const code = word();
        const intentId = wish();
        // A guest pays
        const made = await (await web(artifactId, { intentId, recoveryCode: code })).json();
        await old(made.orderId);
        expect(await (await web(artifactId, { restore: true, recoveryCode: code })).json()).toMatchObject({ status: 'paid', orderId: made.orderId, buyer: 'guest' });
        // The same browser signs in to Orbit: the same code still finds it, on the page and on the saved receipt link
        mockUser.current = { id: sara };
        expect(await (await web(artifactId, { restore: true, recoveryCode: code })).json()).toMatchObject({ status: 'paid', orderId: made.orderId, buyer: 'account' });
        expect(await (await web(artifactId, { check: true, intentId, recoveryCode: code })).json()).toMatchObject({ status: 'paid', orderId: made.orderId });
        // The wish started as a guest and retried signed in is the same order, never a second
        const again = await (await web(artifactId, { intentId, recoveryCode: code }, '203.0.113.11')).json();
        expect(again).toMatchObject({ orderId: made.orderId, reused: true });
        expect(await orders(artifactId)).toHaveLength(1);
        // Signed in WITHOUT the code, or with another browser's code, finds nothing: the code is the proof
        expect(await (await web(artifactId, { restore: true })).json()).toMatchObject({ status: 'none' });
        expect(await (await web(artifactId, { restore: true, recoveryCode: word() })).json()).toMatchObject({ status: 'none' });
        // The game's window, with the person signed in and the code its own window holds, finds it too
        expect(await (await game(artifactId, { viewer: viewerOf(`sara-${tag}`), restore: true, recoveryCode: code })).json()).toMatchObject({ status: 'paid', orderId: made.orderId });
        expect(await (await game(artifactId, { viewer: viewerOf(`omar-${tag}`), restore: true, recoveryCode: code })).json()).toMatchObject({ status: 'paid', orderId: made.orderId });
      });

      it('makes new orders under the account when signed in, and still finds the earlier guest ones', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const code = word();
        const guestOrder = await (await web(artifactId, { intentId: wish(), recoveryCode: code })).json();
        mockUser.current = { id: sara };
        const accountOrder = await (await web(artifactId, { intentId: wish(), recoveryCode: code }, '203.0.113.12')).json();
        expect(accountOrder.orderId).not.toBe(guestOrder.orderId);
        expect((await orders(artifactId)).map((row) => row.buyerKey)).toEqual([buyerOf(code), `acct:${sara}`]);
        await old(accountOrder.orderId);
        expect(await (await web(artifactId, { restore: true, recoveryCode: code })).json()).toMatchObject({ status: 'paid' });
      });

      it('answers an order made under an account only to that account: another account, or nobody, signed in on the same device is told nothing of it, while a guest’s own order stays reachable', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
        mockUser.current = { id: sara };
        const made = await (await web(artifactId, { intentId: wish() })).json();
        expect(made).toMatchObject({ buyer: 'account' });
        const poll = () => publicGet(request(`/api/pay/${artifactId}?order=${made.orderId}`), params({ artifactId }));
        const asGame = (identifier: string | null) => game(artifactId, { viewer: viewerOf(identifier), order: made.orderId });
        expect((await poll()).status).toBe(200);
        expect((await asGame(`sara-${tag}`)).status).toBe(200);
        // Another account signs in on this device while the checkout is on its way: it is answered like an order that is not there
        mockUser.current = { id: omar };
        expect((await poll()).status).toBe(404);
        expect((await asGame(`omar-${tag}`)).status).toBe(404);
        // So is nobody signed in (the account signed out)
        mockUser.current = null;
        expect((await poll()).status).toBe(404);
        expect((await asGame(null)).status).toBe(404);
        // The account that started it is told as before
        mockUser.current = { id: sara };
        expect((await poll()).status).toBe(200);
        // A guest's order is the browser's own: someone who signs in on the same browser can still be told its state (deliberate guest recovery)
        mockUser.current = null;
        const guest = await (await web(artifactId, { intentId: wish(), recoveryCode: word() }, '203.0.113.31')).json();
        mockUser.current = { id: omar };
        expect((await publicGet(request(`/api/pay/${artifactId}?order=${guest.orderId}`), params({ artifactId }))).status).toBe(200);
      });

      it('keeps a test payment a test payment through status, Check payment and Restore, and never gives it as a live purchase (nor lets it hide a live one)', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const code = word();
        const intentId = wish();
        const made = await (await web(artifactId, { intentId, recoveryCode: code })).json();
        await old(made.orderId);
        const status = await (await publicGet(request(`/api/pay/${artifactId}?order=${made.orderId}`), params({ artifactId }))).json();
        expect(status).toMatchObject({ status: 'paid', testPayment: true });
        expect(await (await web(artifactId, { check: true, intentId, recoveryCode: code })).json()).toMatchObject({ status: 'paid', testPayment: true });
        // A reload, a second Restore, a Restore from another device by the receipt link: always a test one
        for (const body of [{ restore: true, recoveryCode: code }, { restore: true, recoveryCode: code }, { restore: true, recoveryCode: word(), receiptCode: code }]) {
          expect(await (await web(artifactId, body, '203.0.113.32')).json()).toMatchObject({ status: 'paid', orderId: made.orderId, testPayment: true });
        }
        // A live purchase of the same buyer, made later, is the one a Restore gives (and says live); the test one never stands in for it
        const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
        const live = await prisma.appPageOrder.create({
          data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'live', status: 'paid', paidAt: new Date(Date.now() - 86_400_000), providerRef: 'chg_live', visitorHash: 'v', intentId: wish(), buyerKey: buyerOf(code) },
        });
        expect(await (await web(artifactId, { restore: true, recoveryCode: code }, '203.0.113.32')).json()).toMatchObject({ status: 'paid', orderId: live.id, testPayment: false });
        // And with only the test one left, it is a test one again (never promoted)
        await prisma.appPageOrder.delete({ where: { id: live.id } });
        expect(await (await web(artifactId, { restore: true, recoveryCode: code }, '203.0.113.32')).json()).toMatchObject({ status: 'paid', orderId: made.orderId, testPayment: true });
      });

      it('a receipt link’s code only finds the purchases made under it: a new purchase is never made under it, and it cannot find the browser’s own purchases for anyone else', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        const sender = word();
        const mine = word();
        // The sender paid; this browser has its own code and opens the sender's receipt link
        const theirs = await (await web(artifactId, { intentId: wish(), recoveryCode: sender })).json();
        await old(theirs.orderId);
        expect(await (await web(artifactId, { restore: true, recoveryCode: mine })).json()).toMatchObject({ status: 'none' });
        expect(await (await web(artifactId, { restore: true, recoveryCode: mine, receiptCode: sender }, '203.0.113.20')).json()).toMatchObject({ status: 'paid', orderId: theirs.orderId });
        // A start carrying the link's code is made under the browser's own code only
        const intentId = wish();
        const started = await (await web(artifactId, { intentId, recoveryCode: mine, receiptCode: sender }, '203.0.113.21')).json();
        expect(started.orderId).not.toBe(theirs.orderId);
        expect((await orders(artifactId)).find((row) => row.id === started.orderId)?.buyerKey).toBe(buyerOf(mine));
        // The sender, holding only the code they sent, finds nothing of this browser's purchase (and not its open checkout link)
        expect(await (await web(artifactId, { restore: true, recoveryCode: sender }, '203.0.113.22')).json()).toMatchObject({ status: 'paid', orderId: theirs.orderId });
        expect((await (await web(artifactId, { check: true, intentId, recoveryCode: sender }, '203.0.113.23')).json()).orderId).toBeUndefined();
        // This browser finds both of its purchases by asking under its own code and the link's
        await old(started.orderId);
        expect((await (await web(artifactId, { check: true, intentId, recoveryCode: mine, receiptCode: sender }, '203.0.113.24')).json())).toMatchObject({ status: 'paid', orderId: started.orderId });
      });

      it('binds an Orbit session on the public link to the account, and restores it for the same account in the game', async () => {
        const { artifactId } = await pending();
        gateway({ record: (order) => paidRecord(order) });
        mockUser.current = { id: sara };
        const made = await (await web(artifactId, { intentId: wish() })).json();
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: made.orderId } })).toMatchObject({ buyerKey: `acct:${sara}` });
        await old(made.orderId);
        expect(await (await game(artifactId, { viewer: viewerOf(`sara-${tag}`), restore: true })).json()).toMatchObject({ status: 'paid', orderId: made.orderId });
      });
    });
  });

  /* ------------------ orders nobody is watching (O3.4) and how loaded it is (O5) ------------------ */

  describe('orders nobody is watching', () => {
    it('asks about an abandoned order at the service and finds the payment, leaves a quiet one alone, and ends a start that never finished', async () => {
      const { artifactId } = await pending();
      const jobRow = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      gateway();
      const watched = await checkout(artifactId, '198.51.100.71');
      // (the stand-in service answers for the newest order, so the one to be found paid is made last)
      const abandoned = await checkout(artifactId, '198.51.100.70');
      await prisma.appPageOrder.update({ where: { id: abandoned.orderId }, data: { checkedAt: new Date(Date.now() - 3_600_000) } });
      await prisma.appPageOrder.update({ where: { id: watched.orderId }, data: { checkedAt: new Date() } });
      const never = await prisma.appPageOrder.create({
        data: { jobId: jobRow.id, ownerId: sara, connectionId: jobRow.connectionId, artifactId, definitionHash: jobRow.definitionHash, amountMinor: jobRow.amountMinor, currency: jobRow.currency, mode: 'test', status: 'creating', visitorHash: 'v', createdAt: new Date(Date.now() - 30 * 3_600_000) },
      });
      const sent = gateway({ record: (order) => paidRecord(order) });
      const swept = await sweepPageOrders();
      expect(swept).toMatchObject({ looked: 1, ended: 1, moved: 1 });
      expect(sent).toHaveLength(1);
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: abandoned.orderId } })).status).toBe('paid');
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: watched.orderId } })).status).toBe('pending');
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: never.id } })).toMatchObject({ status: 'not_paid' });
      expect(await notices()).toHaveLength(1);
    });

    it('is run by the service route, and shows the load', async () => {
      const { artifactId } = await pending();
      gateway();
      const made = await checkout(artifactId, '198.51.100.72');
      await prisma.appPageOrder.update({ where: { id: made.orderId }, data: { createdAt: new Date(Date.now() - 600_000), checkedAt: new Date(Date.now() - 3_600_000) } });
      expect((await sweepRoute(request('/api/app-pay/sweep', { method: 'POST' }))).status).toBe(401);
      const answer = await (await sweepRoute(request('/api/app-pay/sweep', { method: 'POST', token: SERVICE_TOKEN }))).json();
      expect(answer.sweep).toMatchObject({ looked: 1 });
      expect(answer.load).toMatchObject({ pending: 1, starting: 0 });
      expect(answer.load.oldestPendingSeconds).toBeGreaterThanOrEqual(600);
      const load = await (await sweepLoad(request('/api/app-pay/sweep', { token: SERVICE_TOKEN }))).json();
      expect(load.load.looks.made).toBeGreaterThanOrEqual(1);
    });

    it('the sweep tells Sentry only when the looks are STALLED (looks made and not read), never because an order is old', async () => {
      const sentry = Sentry.captureMessage as jest.Mock;
      sentry.mockClear();
      try {
        const { artifactId } = await pending();
        await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
        const DAY = 24 * 3_600_000;
        gateway();
        const made = await checkout(artifactId, '198.51.100.74');
        const calm = await prisma.appPageOrder.update({ where: { id: made.orderId }, data: { status: 'not_paid', providerRef: 'chg_AL01', reconciled: false, createdAt: new Date(Date.now() - 203 * DAY), closedAt: new Date(Date.now() - 202 * DAY), checkedAt: new Date(Date.now() - 3_600_000), lastReadAt: new Date(Date.now() - 3_600_000), nextLookAt: new Date(Date.now() + 20 * DAY) } });
        const quiet = await (await sweepRoute(request('/api/app-pay/sweep', { method: 'POST', token: SERVICE_TOKEN }))).json();
        expect(quiet.load.unconfirmed).toMatchObject({ count: 1, stalled: [] });
        expect(sentry).not.toHaveBeenCalled();
        // Its look is due and the service cannot be read, again and again: stalled
        await prisma.appPageOrder.update({ where: { id: calm.id }, data: { checks: 5, lastReadAt: null, nextLookAt: new Date(Date.now() - 1_000) } });
        await prisma.appKeyCall.deleteMany({ where: { ownerId: 'page-payments' } });
        mockSend.current = () => ({ status: 503, body: {} });
        const stalled = await (await sweepRoute(request('/api/app-pay/sweep', { method: 'POST', token: SERVICE_TOKEN }))).json();
        expect(stalled.load.unconfirmed.stalled).toEqual(['unreadable']);
        expect(sentry).toHaveBeenCalledTimes(1);
        expect(sentry.mock.calls[0][0]).toContain('stalled: unreadable');
      } finally {
        sentry.mockClear();
      }
    });

    it('measures how long orders took to be found paid', async () => {
      const { artifactId } = await pending();
      gateway({ record: (order) => paidRecord(order) });
      const made = await checkout(artifactId, '198.51.100.73');
      await prisma.appPageOrder.update({ where: { id: made.orderId }, data: { createdAt: new Date(Date.now() - 120_000) } });
      await settle(made.orderId);
      const load = await pagePaymentLoad();
      expect(load.recoveryLastDay.paid).toBe(1);
      expect(load.recoveryLastDay.p50Seconds).toBeGreaterThanOrEqual(119);
      expect(load.pending).toBe(0);
    });

    it('tells a host to wait longer between questions the longer an order has waited', () => {
      const now = new Date();
      const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
      expect([0, 0.5, 1, 4, 5, 9, 10, 600].map((minutes) => pollAfterMs(ago(minutes), now))).toEqual([3_000, 3_000, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000]);
    });

    it('puts the wait in what an order’s status says, for either host', async () => {
      const { artifactId } = await pending();
      gateway();
      const made = await checkout(artifactId, '198.51.100.74');
      const body = await (await publicGet(request(`/api/pay/${artifactId}?order=${made.orderId}`), params({ artifactId }))).json();
      expect(body).toMatchObject({ status: 'checking', pollAfterMs: 3_000, orderId: made.orderId });
    });
  });

  /* ------------------ the saved job, read back (O4) ------------------ */

  describe('the saved job, in canonical form', () => {
    const readBack = (serverId: string, artifactId: string, token: string | null = SERVICE_TOKEN, bot = brick) =>
      readJob(request(`/api/bots/${bot}/key-apps/${serverId}/page-jobs?artifactId=${artifactId}`, { token: token ?? undefined }), params({ id: bot, serverId }));

    it('answers a write with the saved job as whole minor units, an upper-case currency and the currency’s decimals', async () => {
      const { serverId, id } = await connectGateway();
      const artifactId = await makeArtifact();
      const written = await (await job(serverId, artifactId, { amount: '4.5' })).json();
      expect(written.job).toMatchObject({ artifactId, connectionId: id, amount: '4.500', amountMinor: 4500, currency: 'KWD', exponent: 3, active: true, status: 'active' });
      const lower = await (await job(serverId, artifactId, { amount: 4.5, currency: 'kwd' })).json();
      expect(lower.job).toMatchObject({ amountMinor: 4500, currency: 'KWD' });
    });

    it('reads the job back without writing, and the same as the write said', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      const written = await (await job(serverId, artifactId)).json();
      const before = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      const answer = await readBack(serverId, artifactId);
      expect(answer.status).toBe(200);
      expect((await answer.json()).job).toEqual(written.job);
      expect(await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } })).toEqual(before);
      expect(await prisma.appKeyCall.count({ where: { ownerId: sara } })).toBe(0);
    });

    it('reads a stopped job as not active, and says not found for a page with no job, another page, another app or no token', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      expect((await readBack(serverId, artifactId)).status).toBe(404);
      await job(serverId, artifactId);
      const row = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      await prisma.appPageJob.update({ where: { id: row.id }, data: { status: 'stopped' } });
      expect((await (await readBack(serverId, artifactId)).json()).job).toMatchObject({ active: false, status: 'stopped' });
      expect((await readBack(serverId, await makeArtifact())).status).toBe(404);
      expect((await readBack(serverId, artifactId, null)).status).toBe(401);
      expect((await readBack(serverId, 'x'.repeat(101))).status).toBe(400);
      // Another Brick's grant of the same app does not reach this page's job
      const other = (await createBrick({ ownerId: omar, name: 'Other' })).id;
      expect((await readBack(serverId, artifactId, SERVICE_TOKEN, other)).status).toBe(404);
    });

    it('gives the exponent of a zero-decimal and a two-decimal currency too', async () => {
      const { serverId } = await connectGateway();
      const artifactId = await makeArtifact();
      expect((await (await job(serverId, artifactId, { amount: '1500', currency: 'JPY' })).json()).job).toMatchObject({ amountMinor: 1500, exponent: 0, currency: 'JPY' });
      expect((await (await job(serverId, artifactId, { amount: '12.5', currency: 'USD' })).json()).job).toMatchObject({ amountMinor: 1250, exponent: 2, currency: 'USD' });
    });
  });

  describe('which pages still speak the old page protocol', () => {
    it('classifies a page’s source: no pay button, a current one (request id and session) and a legacy one (neither, or one of the two)', () => {
      expect(classifyPageContract('<h1>Shop</h1>')).toBe('no_call');
      expect(classifyPageContract(`const request = rid(); const session = sid(); parent.postMessage({ universe: 'use-app', app: 'shop', request, session }, '*')`)).toBe('current');
      expect(classifyPageContract(`parent.postMessage({ universe: 'use-app', app: 'shop' }, '*')`)).toBe('legacy');
      expect(classifyPageContract(`parent.postMessage({ universe: 'use-app', app: 'shop', request: id }, '*')`)).toBe('legacy');
    });

    it('lists the pages with a payment job by contract, says which legacy ones are active or have orders, prints ids only, and needs the service token', async () => {
      const { serverId } = await connectGateway();
      const make = async (source: string | null, active = true) => {
        const artifactId = await makeArtifact();
        await job(serverId, artifactId);
        if (!active) await prisma.appPageJob.update({ where: { artifactId }, data: { status: 'stopped' } });
        if (source !== null) await prisma.artifactVersion.create({ data: { artifactId, number: 1, fileKey: `inventory/${artifactId}.html`, sizeBytes: source.length } });
        return { artifactId, source };
      };
      const current = await make(`const request = 'a'; const session = 'b'; postMessage({ universe: 'use-app', request, session })`);
      const legacy = await make(`postMessage({ universe: 'use-app', app: 'shop' })`);
      const legacyStopped = await make(`postMessage({ universe: 'use-app', app: 'shop' })`, false);
      const none = await make('<p>no button</p>');
      const missing = await make(null);
      const files = { get: async (key: string) => [current, legacy, legacyStopped, none].find((entry) => key === `inventory/${entry.artifactId}.html`)!.source! };
      // The legacy page has a paid order already: it is the one to upgrade first
      gateway({ record: (order) => paidRecord(order) });
      const made = await checkout(legacy.artifactId, '198.51.100.60');
      await settle(made.orderId);
      const mine = new Set([current, legacy, legacyStopped, none, missing].map((entry) => entry.artifactId));
      const all = await inventoryPaymentPages({ take: 500 }, files);
      const rows = all.rows.filter((row) => mine.has(row.artifactId));
      const by = (entry: { artifactId: string }) => rows.find((row) => row.artifactId === entry.artifactId)!;
      expect(by(current)).toMatchObject({ contract: 'current', jobActive: true });
      expect(by(legacy)).toMatchObject({ contract: 'legacy', jobActive: true, orders: { paid: 1, open: 0 } });
      expect(by(legacyStopped)).toMatchObject({ contract: 'legacy', jobActive: false });
      expect(by(none)).toMatchObject({ contract: 'no_call' });
      expect(by(missing)).toMatchObject({ contract: 'unreadable' });
      expect(all.legacy.active).toBeGreaterThanOrEqual(1);
      expect(all.legacy.withOrders).toBeGreaterThanOrEqual(1);
      // A page of rows at a time, with a cursor
      const first = await inventoryPaymentPages({ take: 1 }, files);
      expect(first.rows).toHaveLength(1);
      expect(first.nextCursor).toBe(first.rows[0].jobId);
      // Ids only (no names, accounts or addresses), and only with the service token
      expect(Object.keys(rows[0]).sort()).toEqual(['artifactId', 'contract', 'jobActive', 'jobId', 'openScope', 'orders']);
      expect((await pagesInventory(request('/api/app-pay/pages'))).status).toBe(401);
      expect((await pagesInventory(request('/api/app-pay/pages?take=1', { token: SERVICE_TOKEN }))).status).toBe(200);
      // The page size is read as it always was: a number above 0 is used and the inventory caps it at 500, anything else is ignored (the default size). Only a fraction is
      // the caller's mistake (400), answered before the inventory is asked and never an error inside it (500)
      const asked = jest.mocked(inventoryPaymentPages);
      try {
        for (const bad of ['1.5', '0.5', '2.5e0']) {
          asked.mockClear();
          expect((await pagesInventory(request(`/api/app-pay/pages?take=${bad}`, { token: SERVICE_TOKEN }))).status).toBe(400);
          expect(asked).not.toHaveBeenCalled();
        }
        for (const good of ['', '1', '25', '01', '1000000000', '2e3', '0', '-1', 'abc', '1,5', '1e400']) expect((await pagesInventory(request(`/api/app-pay/pages?take=${good}`, { token: SERVICE_TOKEN }))).status).toBe(200);
        // A huge size reaches the inventory as given and is capped there; a number that is not above 0 is not passed on at all
        asked.mockClear();
        const huge = await pagesInventory(request('/api/app-pay/pages?take=1000000000', { token: SERVICE_TOKEN }));
        expect(asked).toHaveBeenCalledWith({ take: 1_000_000_000, cursor: null });
        expect(((await huge.json()) as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(500);
        for (const ignored of ['0', '-1', 'abc', '1,5', '1e400', '']) {
          asked.mockClear();
          await pagesInventory(request(`/api/app-pay/pages?take=${ignored}`, { token: SERVICE_TOKEN }));
          expect(asked).toHaveBeenCalledWith({ cursor: null });
        }
        asked.mockClear();
        await pagesInventory(request('/api/app-pay/pages?take=01', { token: SERVICE_TOKEN }));
        expect(asked).toHaveBeenCalledWith({ take: 1, cursor: null });
      } finally {
        asked.mockClear();
      }
    });
  });
});
