/**
 * Payments for pages (game #2044, step 3) against a real database: the owner's job per page, the visitor's checkout, and the check that
 * decides "paid". Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/app-direct-pay-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { waitUntilBlockedOnLock } from '../helpers/db-blocked';

const mockUser: { current: { id: string; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
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

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { disconnect } from '@/lib/app-connections';
import { definitionSchema, hashDefinition } from '@/lib/app-direct/definition';
import { openKeyForm, submitKey } from '@/lib/app-direct/connect';
import { getBrickLimits, saveServerLimits } from '@/lib/bot-limits';
import { GuardError } from '@/lib/app-direct/guard';
import { checkPurchase, checksHaveEnded, guestBuyerKey, isWaiting, lookStats, orderForArtifact, pagePaymentLoad, pollAfterMs, restorePurchase, startCheckout, sweepPageOrders, verifyOrder } from '@/lib/app-direct/pay';
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

const start = (artifactId: string, address = '203.0.113.7') => publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', headers: { 'x-forwarded-for': address } }), params({ artifactId }));

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
      const response = await publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { amount: 0.001, currency: 'USD' } }), params({ artifactId }));
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
      const started = await call({ viewer, start: true });
      expect(started.status).toBe(200);
      const { orderId } = await started.json();
      expect((await (await call({ viewer, order: orderId })).json()).status).toBe('checking');
      // A person who may not open the page hears nothing about it (this one is shared with its chat, and they are not in it)
      await prisma.artifact.update({ where: { id: artifactId }, data: { openScope: 'chat' } });
      const stranger = { person: { signedIn: true, identifier: `omar-${tag}` }, inChat: false };
      expect((await call({ viewer: stranger, start: true })).status).toBe(404);
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

      it('is not asked about again once it is older than the late-payment hours from Limits', async () => {
        const { artifactId } = await pending();
        const orderId = await closeByExpiry(artifactId, '198.51.100.34');
        // The window runs from when it was closed: closed more than the late hours ago, it is not asked about again
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - 80 * 3_600_000), closedAt: new Date(Date.now() - 60 * 3_600_000) } });
        const sent = gateway({ record: (order) => paidRecord(order) });
        const answer = await settle(orderId);
        expect(answer).toMatchObject({ status: 'not_paid' });
        // The page that refreshes itself for a late payment is told no look is made any more, so it stops
        expect(checksHaveEnded(answer!)).toBe(true);
        expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(0);
        expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('not_paid');
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

    it('is rate-limited per platform together with the other uses of keys', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 1 } }, sara);
      const { artifactId } = await pending();
      gateway();
      expect((await startCheckout({ artifactId, visitor: 'one' })).status).toBe('ok');
      expect((await startCheckout({ artifactId, visitor: 'two' })).status).toBe('limit');
    });
  });

  describe('the platform’s limit', () => {
    it('is counted by one checkout at a time across every owner, under the lock ordinary uses of a key take too, so two at the same moment cannot both take the last place', async () => {
      const { artifactId } = await pending();
      gateway();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const taken = new Promise<void>((resolve) => (locked = resolve));
      // Another owner's checkout is in the middle of counting and writing its order
      const other = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('key-calls:everyone', 0))`;
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await taken;
      let finished = false;
      const mine = startCheckout({ artifactId, visitor: 'one' }).then((outcome) => ((finished = true), outcome));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
      release();
      await other;
      expect((await mine).status).toBe('ok');
    });

    it('takes its turn on the key calls\' count with every other use of a key, so a call and a checkout cannot both take the last place', async () => {
      const { artifactId } = await pending();
      gateway();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const taken = new Promise<void>((resolve) => (locked = resolve));
      // A key call (lib/app-direct/use.ts) is in the middle of counting and writing its row
      const call = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('key-calls:everyone', 0))`;
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await taken;
      let finished = false;
      const mine = startCheckout({ artifactId, visitor: 'one' }).then((outcome) => ((finished = true), outcome));
      await waitUntilBlockedOnLock();
      expect(finished).toBe(false);
      release();
      await call;
      expect((await mine).status).toBe('ok');
    });
  });

  describe('the platform’s limit, orders and uses together', () => {
    it('counts a committed order against the room an ordinary use of a key sees, and the other way round', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 1, keyCallsPerPerson: 100 } }, sara);
      const { artifactId, serverId } = await (async () => {
        const gate = await connectGateway();
        const artifact = await makeArtifact();
        await job(gate.serverId, artifact);
        return { artifactId: artifact, serverId: gate.serverId };
      })();
      gateway();
      expect((await startCheckout({ artifactId, visitor: 'one' })).status).toBe('ok');
      const [app] = await keyAppsOf(brick);
      let sent = 0;
      const deps = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async () => ((sent += 1), { status: 200, redirected: false, body: '{"id":"chg_9","status":"INITIATED"}', truncated: false, contentType: null }) };
      // The order took the platform's one place: an ordinary use is over the limit and sends nothing
      const outcome = await runKeyApp({ botId: brick, serverId, requesterKey: `sara-${tag}`, callId: `use-${tag}`, operation: 'lookUpPayment', arguments: { chargeId: 'chg_9' }, definitionHash: app.definitionHash }, deps);
      expect(outcome).toMatchObject({ status: 'limit' });
      expect(sent).toBe(0);
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
      const [one, two] = await Promise.all([startCheckout({ artifactId: first.artifactId, visitor: 'a' }), startCheckout({ artifactId: omarsArtifact, visitor: 'b' })]);
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
      await prisma.appPageOrder.update({ where: { id: stuck.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
      expect(await verifyOrder(stuck.id)).toMatchObject({ status: 'not_paid' });
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: 'not_paid', paidAt: null });
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
    const begin = (artifactId: string, intentId: string, code: string, visitor = 'visitor-1') => startCheckout({ artifactId, visitor, intentId, buyerKey: buyerOf(code) });
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
        const response = await publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { intentId: wish(), recoveryCode: word() }, headers: { 'x-forwarded-for': '203.0.113.77' } }), params({ artifactId }));
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'unavailable', unsure: true });
        const game = await gamePay(request(`/api/artifacts/${artifactId}/pay`, { method: 'POST', token: ADMIN_TOKEN, body: { viewer: { person: { signedIn: false, name: 'Visitor' }, inChat: true, chat: { kind: 'dm', ref: `chat-${tag}` } }, start: true, intentId: wish(), recoveryCode: word() } }), params({ id: artifactId }));
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

      it('never turns a cut-off or non-object body into a checkout: only no body at all is a plain start', async () => {
        const { artifactId } = await pending();
        const sent = gateway();
        const raw = (text: string | null, address: string) => publicStart(new NextRequest(`http://localhost/api/pay/${artifactId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address }, ...(text === null ? {} : { body: text }) }), params({ artifactId }));
        for (const [n, bad] of ['{"check":true,"intentId":"i1234567', '5', '"start"', '[]', 'null', '   ', '\n'].entries()) {
          const response = await raw(bad, `203.0.113.${40 + n}`);
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ code: 'bad_request' });
        }
        expect(POSTS(sent)).toHaveLength(0);
        expect((await raw(null, '203.0.113.50')).status).toBe(200);
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
      const game = (artifactId: string, body: Record<string, unknown>) => gamePay(request(`/api/artifacts/${artifactId}/pay`, { method: 'POST', token: ADMIN_TOKEN, body }), params({ id: artifactId }));
      const web = (artifactId: string, body: Record<string, unknown>, address = '203.0.113.9') => publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body, headers: { 'x-forwarded-for': address } }), params({ artifactId }));

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
});
