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
type Sent = { host: string; path: string; method: string; headers: Record<string, string>; body?: string };
const mockSend: { current: ((target: Sent) => { status: number; body?: unknown; redirected?: boolean }) | null } = { current: null };
jest.mock('@/lib/app-direct/guard', () => {
  const actual = jest.requireActual('@/lib/app-direct/guard');
  return {
    ...actual,
    guardedRequest: jest.fn((request: Parameters<typeof actual.guardedRequest>[0], deps?: Parameters<typeof actual.guardedRequest>[1]) =>
      mockSend.current
        ? actual.guardedRequest(request, {
            resolve: async () => [{ address: '93.184.216.34', family: 4 }],
            send: async (target: Sent) => {
              const answer = mockSend.current!(target);
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
import { saveServerLimits } from '@/lib/bot-limits';
import { orderForArtifact, startCheckout, verifyOrder } from '@/lib/app-direct/pay';
import { POST as makeJob } from '@/app/api/bots/[id]/key-apps/[serverId]/page-jobs/route';
import { GET as listPages } from '@/app/api/me/apps/pages/route';
import { DELETE as stopPage } from '@/app/api/me/apps/pages/[jobId]/route';
import { GET as publicGet, POST as publicStart } from '@/app/api/pay/[artifactId]/route';
import { POST as gamePay } from '@/app/api/artifacts/[id]/pay/route';
import { POST as notice } from '@/app/api/app-pay/notice/[orderId]/route';

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

async function connectTap(ownerId = sara): Promise<{ id: string; serverId: string }> {
  const form = await openKeyForm({ ownerId, service: 'tap' });
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

/** What Tap answers: a charge made, then its record. */
let lastOrder = '';
function tap(over: { create?: Record<string, unknown>; record?: (order: string) => Record<string, unknown>; createStatus?: number } = {}) {
  const sent: Sent[] = [];
  mockSend.current = (target) => {
    sent.push(target);
    if (target.method === 'POST') {
      lastOrder = JSON.parse(target.body ?? '{}').reference?.order ?? lastOrder;
      return { status: over.createStatus ?? 200, body: { id: 'chg_TS01', status: 'INITIATED', amount: 4.5, currency: 'KWD', transaction: { url: 'https://checkout.tap.company/?mode=page&token=abc' }, reference: { order: JSON.parse(target.body ?? '{}').reference?.order }, ...over.create } };
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
const settle = async (orderId: string) => {
  // The check is rate limited per order: let the last look be old enough
  await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 60_000) } });
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
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      const response = await job(serverId, artifactId);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.job).toMatchObject({ artifactId, amount: '4.500', currency: 'KWD', app: 'Tap Payments', status: 'active' });
      const row = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      expect(row).toMatchObject({ amountMinor: 4500, currency: 'KWD', ownerId: sara });
    });

    it('replaces the terms for new checkouts only when asked again', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      tap();
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
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      const response = await job(serverId, artifactId, change);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('bad_terms');
      expect(await prisma.appPageJob.count({ where: { artifactId } })).toBe(0);
    });

    it('is only for the owner’s own page, and a document cannot take a payment', async () => {
      const { serverId } = await connectTap();
      const others = await makeArtifact({ ownerId: omar });
      expect((await job(serverId, others)).status).toBe(404);
      expect((await job(serverId, randomUUID())).status).toBe(404);
      const document = await makeArtifact({ kind: 'markdown' });
      expect((await job(serverId, document)).status).toBe(400);
      expect(await prisma.appPageJob.count()).toBe(0);
    });

    it('is only for the owner asking', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      expect((await job(serverId, artifactId, { requesterKey: `omar-${tag}` })).status).toBe(403);
      expect((await job(serverId, artifactId, { requesterKey: undefined })).status).toBe(403);
      expect(await prisma.appPageJob.count()).toBe(0);
    });

    it('needs the service token', async () => {
      const { serverId } = await connectTap();
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
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      const sent = tap();
      const body = await checkout(artifactId);
      expect(body.checkoutUrl).toBe('https://checkout.tap.company/?mode=page&token=abc');
      const order = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: body.orderId } });
      expect(order).toMatchObject({ status: 'pending', amountMinor: 4500, currency: 'KWD', mode: 'test', providerRef: 'chg_TS01', ownerId: sara });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ host: 'api.tap.company', path: '/v2/charges', method: 'POST' });
      expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`);
      const payload = JSON.parse(sent[0].body as string);
      expect(payload).toMatchObject({ amount: 4.5, currency: 'KWD', description: 'A mug', reference: { order: order.id, idempotent: order.id }, post: { url: `https://orbit.example.org/api/app-pay/notice/${order.id}` }, redirect: { url: `https://orbit.example.org/pay/done?o=${order.id}` }, customer: { first_name: 'Customer' } });
    });

    it('takes no amount from the visitor', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      const sent = tap();
      const response = await publicStart(request(`/api/pay/${artifactId}`, { method: 'POST', body: { amount: 0.001, currency: 'USD' } }), params({ artifactId }));
      expect(response.status).toBe(200);
      expect(JSON.parse(sent[0].body as string)).toMatchObject({ amount: 4.5, currency: 'KWD' });
    });

    it('is only for a page anyone with the link may open', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact({ openScope: 'chat' });
      await job(serverId, artifactId);
      tap();
      expect((await start(artifactId)).status).toBe(404);
      expect((await publicGet(request(`/api/pay/${artifactId}`), params({ artifactId }))).status).toBe(404);
      expect(await prisma.appPageOrder.count({ where: { ownerId: sara } })).toBe(0);
    });

    it('says whether a page takes payments, and nothing more', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      expect(await (await publicGet(request(`/api/pay/${artifactId}`), params({ artifactId }))).json()).toEqual({ enabled: false });
      await job(serverId, artifactId);
      expect(await (await publicGet(request(`/api/pay/${artifactId}`), params({ artifactId }))).json()).toEqual({ enabled: true });
    });

    it('does not send a buyer to a host the definition does not name', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      tap({ create: { transaction: { url: 'https://checkout.evil.test/pay' } } });
      const response = await start(artifactId);
      expect(response.status).toBe(409);
      expect(await prisma.appPageOrder.findFirst({ where: { ownerId: sara } })).toMatchObject({ status: 'cant_confirm', checkoutUrl: null });
    });

    it('closes the order when the service does not answer well, and marks a refused key as stopped', async () => {
      const { id, serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      tap({ createStatus: 401 });
      expect((await start(artifactId)).status).toBe(409);
      expect(await prisma.appPageOrder.findFirst({ where: { ownerId: sara } })).toMatchObject({ status: 'not_paid' });
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).not.toBeNull();
      // A mark never blocks the next visitor: the service is asked again, and a good answer clears the mark
      const sent = tap();
      expect((await start(artifactId, '203.0.113.8')).status).toBe(200);
      expect(sent.length).toBeGreaterThan(0);
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
    });

    it('clears the stopped mark when a lookup is answered well', async () => {
      const { id, serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      tap();
      const { orderId } = await checkout(artifactId);
      await prisma.appConnection.update({ where: { id }, data: { signInLostAt: new Date() } });
      tap({ record: (order) => paidRecord(order) });
      expect((await settle(orderId))?.status).toBe('paid');
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
    });

    it('a refused lookup for one order does not stop other pages from taking payments', async () => {
      const { id, serverId } = await connectTap();
      const first = await makeArtifact();
      const second = await makeArtifact();
      await job(serverId, first);
      await job(serverId, second);
      tap();
      const { orderId } = await checkout(first);
      // The service refuses this one lookup (for example a charge it no longer shows this key)
      mockSend.current = () => ({ status: 403 });
      await settle(orderId);
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).not.toBeNull();
      // Another page still gets its checkout, which clears the mark
      tap();
      expect((await start(second, '203.0.113.9')).status).toBe(200);
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
    });

    it('stops when the owner stops it, at once', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      const made = await (await job(serverId, artifactId)).json();
      tap();
      mockUser.current = { id: sara };
      const stopped = await stopPage(request(`/api/me/apps/pages/${made.job.id}`, { method: 'DELETE' }), params({ jobId: made.job.id }));
      expect(stopped.status).toBe(200);
      expect((await start(artifactId)).status).toBe(409);
      expect(await prisma.appPageOrder.count({ where: { ownerId: sara } })).toBe(0);
    });

    it('lets only the owner stop it', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      const made = await (await job(serverId, artifactId)).json();
      mockUser.current = { id: omar };
      expect((await stopPage(request(`/api/me/apps/pages/${made.job.id}`, { method: 'DELETE' }), params({ jobId: made.job.id }))).status).toBe(404);
      expect((await prisma.appPageJob.findUniqueOrThrow({ where: { id: made.job.id } })).status).toBe('active');
    });

    it('does not use a definition that changed since the owner asked', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      await prisma.appPageJob.update({ where: { artifactId }, data: { definitionHash: 'f'.repeat(64) } });
      tap();
      expect((await start(artifactId)).status).toBe(409);
    });

    it('counts tries per visitor, per page and per person, all from Limits', async () => {
      await saveServerLimits({ bricks: { checkoutsPerVisitor: 2, checkoutsPerPage: 3, checkoutsPerOwner: 100 } }, sara);
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      tap();
      expect((await start(artifactId, '198.51.100.1')).status).toBe(200);
      expect((await start(artifactId, '198.51.100.1')).status).toBe(200);
      expect((await start(artifactId, '198.51.100.1')).status).toBe(429);
      expect((await start(artifactId, '198.51.100.2')).status).toBe(200);
      expect((await start(artifactId, '198.51.100.3')).status).toBe(429);
      await saveServerLimits({ bricks: { checkoutsPerPage: 100, checkoutsPerOwner: 3 } }, sara);
      expect((await start(artifactId, '198.51.100.9')).status).toBe(429);
    });

    it('never keeps who the visitor was, only a hash', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      tap();
      const { orderId } = await checkout(artifactId, '203.0.113.99');
      const order = await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } });
      expect(JSON.stringify(order)).not.toContain('203.0.113.99');
      expect(order.visitorHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('lets the game’s server start one for someone who may open the page, and no one else', async () => {
      const { serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      tap();
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
    async function pending(): Promise<{ artifactId: string; connectionId: string }> {
      const { id, serverId } = await connectTap();
      const artifactId = await makeArtifact();
      await job(serverId, artifactId);
      return { artifactId, connectionId: id };
    }

    it('writes paid only when the service’s own record says completed for this order, amount, currency and mode, and tells the owner once', async () => {
      const { artifactId } = await pending();
      tap({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'paid', testPayment: true, checkoutUrl: null });
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'paid' });
      await settle(orderId);
      await verifyOrder(orderId);
      const found = await notices();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ title: 'Test payment on Shop', badge: 'Test' });
      expect(found[0].body).toContain('4.500 KWD');
      expect(found[0].body).toContain('Tap Payments confirmed it.');
      expect(found[0].body).toContain('The first one today.');
    });

    it('asks the service with the key, for that one payment, and nothing about it comes from the visitor', async () => {
      const { artifactId } = await pending();
      const sent = tap({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      await settle(orderId);
      const look = sent[sent.length - 1];
      expect(look).toMatchObject({ method: 'GET', host: 'api.tap.company', path: '/v2/charges/chg_TS01' });
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
      tap({ record: (order) => paidRecord(order, change) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'cant_confirm' });
      expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'cant_confirm', paidAt: null });
      expect(await notices()).toHaveLength(0);
    });

    it.each(['AUTHORIZED', 'INITIATED', 'IN_PROGRESS', 'SOMETHING_NEW'])('does not count %s, and keeps the order open', async (state) => {
      const { artifactId } = await pending();
      tap({ record: (order) => paidRecord(order, { status: state }) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'checking', checkoutUrl: 'https://checkout.tap.company/?mode=page&token=abc' });
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
      expect(await notices()).toHaveLength(0);
    });

    it.each(['DECLINED', 'CANCELLED', 'FAILED', 'ABANDONED', 'TIMEDOUT'])('closes the order at %s, and counts nothing', async (state) => {
      const { artifactId } = await pending();
      tap({ record: (order) => paidRecord(order, { status: state }) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'not_paid' });
      expect(await notices()).toHaveLength(0);
    });

    it('closes an order nobody paid after the open hours from Limits, but still counts a payment that completes late', async () => {
      await saveServerLimits({ bricks: { checkoutOpenHours: 1 } }, sara);
      const { artifactId } = await pending();
      tap({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const unpaid = await checkout(artifactId, '198.51.100.20');
      await prisma.appPageOrder.update({ where: { id: unpaid.orderId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      expect(await settle(unpaid.orderId)).toMatchObject({ status: 'not_paid' });
      const late = await checkout(artifactId, '198.51.100.21');
      tap({ record: (order) => paidRecord(order) });
      await prisma.appPageOrder.update({ where: { id: late.orderId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      expect(await settle(late.orderId)).toMatchObject({ status: 'paid' });
    });

    describe('a payment that completes after the order was closed as not paid', () => {
      const closeByExpiry = async (artifactId: string, address: string) => {
        await saveServerLimits({ bricks: { checkoutOpenHours: 1, latePaymentHours: 48 } }, sara);
        tap({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
        const order = await checkout(artifactId, address);
        await prisma.appPageOrder.update({ where: { id: order.orderId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
        expect(await settle(order.orderId)).toMatchObject({ status: 'not_paid' });
        return order.orderId;
      };

      it('is counted once, with one notice that says it came in late', async () => {
        const { artifactId } = await pending();
        const before = (await notices()).length;
        const orderId = await closeByExpiry(artifactId, '198.51.100.30');
        tap({ record: (order) => paidRecord(order) });
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
        tap({ record: (order) => paidRecord(order) });
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { checkedAt: new Date(Date.now() - 60_000) } });
        await Promise.all([verifyOrder(orderId), notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body: { status: 'CAPTURED' } }), params({ orderId }))]);
        expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('paid');
        expect((await notices()).slice(before)).toHaveLength(1);
      });

      it('is never counted when the amount, currency or mode is not what was asked: it goes to cannot-confirm', async () => {
        const { artifactId } = await pending();
        const before = (await notices()).length;
        const orderId = await closeByExpiry(artifactId, '198.51.100.32');
        tap({ record: (order) => paidRecord(order, { amount: 1 }) });
        expect(await settle(orderId)).toMatchObject({ status: 'cant_confirm' });
        expect(await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'cant_confirm', paidAt: null });
        expect((await notices()).slice(before)).toHaveLength(0);
      });

      it('stays closed while the service still does not call it completed', async () => {
        const { artifactId } = await pending();
        const orderId = await closeByExpiry(artifactId, '198.51.100.33');
        tap({ record: (order) => paidRecord(order, { status: 'FAILED' }) });
        expect(await settle(orderId)).toMatchObject({ status: 'not_paid', checkoutUrl: null });
        tap({ record: (order) => paidRecord(order, { status: 'SOMETHING_NEW' }) });
        expect(await settle(orderId)).toMatchObject({ status: 'not_paid' });
      });

      it('is not asked about again once it is older than the late-payment hours from Limits', async () => {
        const { artifactId } = await pending();
        const orderId = await closeByExpiry(artifactId, '198.51.100.34');
        await prisma.appPageOrder.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - 60 * 3_600_000) } });
        const sent = tap({ record: (order) => paidRecord(order) });
        expect(await settle(orderId)).toMatchObject({ status: 'not_paid' });
        expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(0);
        expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('not_paid');
      });
    });

    it('asks the service at most once in the seconds from Limits, however often it is asked', async () => {
      const { artifactId } = await pending();
      const sent = tap({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
      const { orderId } = await checkout(artifactId);
      await Promise.all(Array.from({ length: 8 }, () => verifyOrder(orderId)));
      expect(sent.filter((entry) => entry.method === 'GET')).toHaveLength(1);
    });

    it('marks it paid once and tells once when the notice and the page both ask at the same moment', async () => {
      const { artifactId } = await pending();
      tap({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      await Promise.all([verifyOrder(orderId), notice(request(`/api/app-pay/notice/${orderId}`, { method: 'POST', body: { status: 'CAPTURED' } }), params({ orderId })), orderForArtifact(orderId, artifactId)]);
      await settle(orderId);
      expect(await notices()).toHaveLength(1);
    });

    it('believes nothing in a notice: it only asks the service, and always answers 200', async () => {
      const { artifactId } = await pending();
      const sent = tap({ record: (order) => paidRecord(order, { status: 'INITIATED' }) });
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
      tap();
      const { orderId } = await checkout(artifactId);
      const other = await makeArtifact();
      expect((await publicGet(request(`/api/pay/${other}?order=${orderId}`), params({ artifactId: other }))).status).toBe(404);
      const own = await publicGet(request(`/api/pay/${artifactId}?order=${orderId}`), params({ artifactId }));
      expect(await own.json()).toEqual({ status: 'checking', checkoutUrl: 'https://checkout.tap.company/?mode=page&token=abc', testPayment: true });
    });

    it('tells a real payment from a test one in what the owner reads', async () => {
      const form = await openKeyForm({ ownerId: sara, service: 'tap' });
      const live = `sk_live_${randomUUID().replace(/-/g, '')}`;
      const { id } = await submitKey({ requestId: form.id, ownerId: sara, key: live }, okCheck);
      const grant = await prisma.botMcpServer.findFirstOrThrow({ where: { botId: brick, connectionId: id } });
      const artifactId = await makeArtifact();
      await job(grant.id, artifactId);
      tap({ record: (order) => paidRecord(order, { live_mode: true }) });
      const { orderId } = await checkout(artifactId);
      expect(await settle(orderId)).toMatchObject({ status: 'paid', testPayment: false });
      const [found] = await notices();
      expect(found.title).toBe('Someone just paid on Shop');
      expect(found.body).not.toContain('test');
    });

    it('does not trust a payment whose app was disconnected: the order can no longer be confirmed', async () => {
      const { artifactId, connectionId } = await pending();
      tap({ record: (order) => paidRecord(order) });
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
      tap({ record: (order) => paidRecord(order) });
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
      tap({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      const row = await prisma.appPageJob.findUniqueOrThrow({ where: { artifactId } });
      mockUser.current = { id: sara };
      await stopPage(request(`/api/me/apps/pages/${row.id}`, { method: 'DELETE' }), params({ jobId: row.id }));
      expect(await settle(orderId)).toMatchObject({ status: 'paid' });
    });

    it('treats a key the service refuses as "still checking", never as paid or unpaid', async () => {
      const { artifactId, connectionId } = await pending();
      tap();
      const { orderId } = await checkout(artifactId);
      mockSend.current = () => ({ status: 401, body: { errors: [{ code: '1103' }] } });
      expect(await settle(orderId)).toMatchObject({ status: 'checking' });
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: connectionId } })).signInLostAt).not.toBeNull();
      expect((await prisma.appPageOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending');
    });

    it('never puts the key in anything kept about the order', async () => {
      const { artifactId } = await pending();
      tap({ record: (order) => paidRecord(order) });
      const { orderId } = await checkout(artifactId);
      await settle(orderId);
      const everything = JSON.stringify([await prisma.appPageOrder.findMany({ where: { ownerId: sara } }), await prisma.appPageJob.findMany({ where: { ownerId: sara } }), await notices()]);
      expect(everything).not.toContain(KEY);
    });

    it('lists the owner’s pages with what each has taken, and only theirs', async () => {
      const { artifactId } = await pending();
      tap({ record: (order) => paidRecord(order) });
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
      tap();
      expect((await startCheckout({ artifactId, visitor: 'one' })).status).toBe('ok');
      expect((await startCheckout({ artifactId, visitor: 'two' })).status).toBe('limit');
    });
  });
});
