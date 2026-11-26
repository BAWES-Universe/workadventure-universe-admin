/**
 * Using a key app (game #2044, step 2) against a real database: default access for the owner's Bricks, what the bot server is told,
 * and the call route with everything Orbit holds on every use. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated
 * throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/app-direct-use-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
// The real guard, except when a test says what the service answers
type Answer = { status: number; body?: string; redirected?: boolean; truncated?: boolean };
const mockSend: { current: ((target: { host: string; path: string; method: string; headers: Record<string, string>; body?: string }) => Answer | Promise<Answer>) | null } = { current: null };
const mockDown = { current: false };
// An error the guard throws before anything is asked (Orbit busy, or no answer in time)
const mockThrow: { current: Error | null } = { current: null };
// A change that commits right after the admission check, to see what the call does about it
const mockAfterCheck: { current: (() => Promise<void>) | null } = { current: null };
jest.mock('@/lib/app-connections', () => {
  const actual = jest.requireActual('@/lib/app-connections');
  return {
    ...actual,
    checkAppUse: jest.fn(async (...args: Parameters<typeof actual.checkAppUse>) => {
      const verdict = await actual.checkAppUse(...args);
      const hook = mockAfterCheck.current;
      mockAfterCheck.current = null;
      if (hook) await hook();
      return verdict;
    }),
  };
});
jest.mock('@/lib/app-direct/guard', () => {
  const actual = jest.requireActual('@/lib/app-direct/guard');
  return {
    ...actual,
    guardedRequest: jest.fn((request: Parameters<typeof actual.guardedRequest>[0], deps?: Parameters<typeof actual.guardedRequest>[1]) =>
      mockThrow.current
        ? Promise.reject(mockThrow.current)
        : mockSend.current
        ? actual.guardedRequest(request, {
            // A name that resolves nowhere is a service that cannot be reached
            resolve: async () => (mockDown.current ? [] : [{ address: '93.184.216.34', family: 4 }]),
            send: async (target: { host: string; path: string; method: string; headers: Record<string, string>; body?: string }) => {
              const answer = await mockSend.current!(target);
              return { status: answer.status, redirected: answer.redirected ?? false, body: answer.body ?? '{}', truncated: answer.truncated ?? false, contentType: 'application/json' };
            },
          })
        : actual.guardedRequest(request, deps),
    ),
  };
});

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { checkAppUse, disconnect, removeGrant, grantToBrick } from '@/lib/app-connections';
import { GuardError } from '@/lib/app-direct/guard';
import { KEY_NO_ANSWER_HOLDS_MS } from '@/lib/app-same';
import { openKeyForm, submitKey, readKeyForm } from '@/lib/app-direct/connect';
import { runKeyApp, keyAppsOf } from '@/lib/app-direct/use';
import { ensureKeyAppTools } from '@/lib/app-direct/policy';
import { GET as listKeyApps } from '@/app/api/bots/[id]/key-apps/route';
import { POST as callKeyApp } from '@/app/api/bots/[id]/key-apps/[serverId]/call/route';
import { POST as askForKey } from '@/app/api/bots/[id]/app-key-forms/route';
import { GET as listServers } from '@/app/api/bots/[id]/mcp-servers/route';
import { GET as readTools } from '@/app/api/bots/[id]/mcp-servers/[serverId]/tools/route';
import { confirmTools } from '@/lib/mcp-tool-policy';
import { saveServerLimits } from '@/lib/bot-limits';
jest.mock('@/lib/app-direct/catalog', () => jest.requireActual('../helpers/example-gateway').catalogWithExample());

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const ADMIN_TOKEN = `admin-${tag}`;
const KEY = `sk_test_${randomUUID().replace(/-/g, '')}`;
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN, key: process.env.ENCRYPTION_KEY };

let sara = '';
let omar = '';
let saraBrick = '';
let saraStudio = '';
let omarBrick = '';
let roomBot = '';
let universeId = '';
let limitsBefore: { value: unknown } | null = null;

const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const okCheck = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async () => ({ status: 404, redirected: false, body: '{}', truncated: false, contentType: null }) };

async function connectGateway(ownerId = sara): Promise<string> {
  const form = await openKeyForm({ ownerId, service: 'examplepay' });
  return (await submitKey({ requestId: form.id, ownerId, key: KEY }, okCheck)).id;
}
const grantOf = (botId: string, connectionId: string) => prisma.botMcpServer.findFirst({ where: { botId, connectionId } });

let n = 0;
const call = (botId: string, serverId: string, hash: string, body: Record<string, unknown> = {}) =>
  callKeyApp(request(`/api/bots/${botId}/key-apps/${serverId}/call`, { method: 'POST', token: SERVICE_TOKEN, body: { requesterKey: `sara-${tag}`, callId: `c-${tag}-${(n += 1)}`, operation: 'lookUpPayment', arguments: { chargeId: 'chg_1' }, definitionHash: hash, ...body } }), params({ id: botId, serverId }));

run('using a key app, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    limitsBefore = await prisma.appSetting.findUnique({ where: { key: 'bot-limits' } });
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
    saraStudio = (await createBrick({ ownerId: sara, name: 'Studio Brick' })).id;
    omarBrick = (await createBrick({ ownerId: omar, name: 'Omar Brick' })).id;
    const universe = await prisma.universe.create({ data: { slug: `acme-${tag}`, name: 'Acme', ownerId: omar } });
    universeId = universe.id;
    const world = await prisma.world.create({ data: { universeId, slug: 'hq', name: 'HQ' } });
    const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
    roomBot = (await prisma.bot.create({ data: { roomId: room.id, name: 'Nora', createdById: sara, aiProviderRef: `key-${tag}`, aiModel: 'm', behaviorConfig: {} } })).id;
  });

  afterEach(async () => {
    mockSend.current = null;
    mockThrow.current = null;
    mockDown.current = false;
    mockAfterCheck.current = null;
    mockUser.current = null;
    // The rows that count uses of a key stay when an app is disconnected, so they are cleared here
    await prisma.appKeyCall.deleteMany({ where: { ownerId: { in: [sara, omar, 'page-payments'] } } });
    await prisma.appKeyRequest.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.botMcpServer.deleteMany({ where: { botId: { in: [saraBrick, saraStudio, omarBrick, roomBot] } } });
    await prisma.userNotice.deleteMany({ where: { userId: { in: [sara, omar] } } });
    await prisma.meterEvent.deleteMany({ where: { botId: { in: [saraBrick, saraStudio, omarBrick] } } });
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    if (limitsBefore) await prisma.appSetting.create({ data: { key: 'bot-limits', value: limitsBefore.value as object } });
    for (const [key, value] of [['BOT_SERVICE_TOKEN', envBefore.service], ['ADMIN_API_TOKEN', envBefore.admin], ['ENCRYPTION_KEY', envBefore.key]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect();
  });

  /* ------------------------- default access ------------------------- */

  it('is available to all the owner’s Bricks the moment it is connected, and to no one else’s and no room bot', async () => {
    const id = await connectGateway();
    expect(await grantOf(saraBrick, id)).not.toBeNull();
    expect(await grantOf(saraStudio, id)).not.toBeNull();
    expect(await grantOf(omarBrick, id)).toBeNull();
    expect(await grantOf(roomBot, id)).toBeNull();
    const grant = (await grantOf(saraBrick, id))!;
    expect(grant).toMatchObject({ enabled: true, authType: 'none', authConfig: null, serverUrl: '' });
  });

  it('gives a Brick made later every key app its owner has, and a Brick of someone else none', async () => {
    const id = await connectGateway();
    const later = await createBrick({ ownerId: sara, name: 'Later Brick' });
    expect(await grantOf(later.id, id)).not.toBeNull();
    const omars = await createBrick({ ownerId: omar, name: 'Omar again' });
    expect(await prisma.botMcpServer.count({ where: { botId: omars.id } })).toBe(0);
    await prisma.bot.deleteMany({ where: { id: { in: [later.id, omars.id] } } });
  });

  it('keeps an explicit Off and a removed grant through a replaced key, and lets a removed one be given back', async () => {
    const id = await connectGateway();
    await prisma.botMcpServer.updateMany({ where: { botId: saraBrick, connectionId: id }, data: { enabled: false } });
    expect(await removeGrant(sara, id, saraStudio)).toBe(true);
    const replace = await openKeyForm({ ownerId: sara, service: 'examplepay' });
    await submitKey({ requestId: replace.id, ownerId: sara, key: `sk_test_${randomUUID().replace(/-/g, '')}` }, okCheck);
    expect((await grantOf(saraBrick, id))?.enabled).toBe(false);
    expect(await grantOf(saraStudio, id)).toBeNull();
    // "Let it use" gives it back, as for any app
    expect(await grantToBrick(sara, id, saraStudio)).not.toBeNull();
    expect(await grantOf(saraStudio, id)).not.toBeNull();
  });

  it('skips a Brick that is full of Apps and says nothing is dropped to make room', async () => {
    await saveServerLimits({ bricks: { appsPerBot: 1 } }, sara);
    const other = await prisma.appConnection.create({ data: { ownerId: sara, name: 'Other', serverUrl: 'https://mcp.example.com/mcp', authType: 'none', source: 'link' } });
    await prisma.botMcpServer.create({ data: { botId: saraStudio, connectionId: other.id, name: 'Other', serverUrl: '', authType: 'none', connectedById: sara } });
    const id = await connectGateway();
    expect(await grantOf(saraBrick, id)).not.toBeNull();
    expect(await grantOf(saraStudio, id)).toBeNull();
    expect(await prisma.botMcpServer.count({ where: { botId: saraStudio } })).toBe(1);
  });

  /* ------------------------- what the bot server is told ------------------------- */

  it('lists a Brick’s key apps with operations and headings, and never the key, its end or an address', async () => {
    const id = await connectGateway();
    const response = await listKeyApps(request(`/api/bots/${saraBrick}/key-apps`, { token: SERVICE_TOKEN }), params({ id: saraBrick }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.apps).toHaveLength(1);
    const [app] = body.apps;
    expect(body.services).toEqual([{ service: 'examplepay', name: 'Example Pay', short: 'Example' }]);
    expect(app).toMatchObject({ connectionId: id, name: 'Example Pay', short: 'Example', enabled: true, payments: true, working: true, settings: { looksUp: 'rightAway', makesNew: 'rightAway', changesThings: 'asksFirst', deletesOrSends: 'asksFirst' } });
    expect(app.definitionHash).toHaveLength(64);
    expect(app.operations.map((operation: { id: string; heading: string; verified: boolean }) => [operation.id, operation.heading, operation.verified])).toEqual([
      ['lookUpPayment', 'looksUp', true],
      ['makePaymentLink', 'makesNew', true],
    ]);
    expect(app.operations[0].inputSchema).toEqual({ type: 'object', properties: { chargeId: { type: 'string', description: 'The payment id, like chg_TS01...', maxLength: 80 } }, required: ['chargeId'], additionalProperties: false });
    const text = JSON.stringify(body);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(-4));
    expect(text).not.toContain('api.examplepay.com');
    expect(text).not.toContain('keyCipher');
    expect(await keyAppsOf(omarBrick)).toEqual([]);
    expect((await listKeyApps(request(`/api/bots/${saraBrick}/key-apps`), params({ id: saraBrick }))).status).toBe(401);
  });

  /* ------------------------- its operations are the grant's tools ------------------------- */

  const toolsOf = async (botId: string, serverId: string) => (await (await readTools(request(`/api/bots/${botId}/mcp-servers/${serverId}/tools`, { token: ADMIN_TOKEN }), params({ id: botId, serverId }))).json()) as { state: string; policyRevision: number; settings: Record<string, string>; tools: { name: string; fingerprint: string; heading: string | null; state: string }[] };

  it('gives a tested app’s operations as confirmed tools under their headings, with the names and fingerprints the list carries', async () => {
    const id = await connectGateway();
    const grant = (await grantOf(saraBrick, id))!;
    const policy = await toolsOf(saraBrick, grant.id);
    expect(policy.state).toBe('confirmed');
    expect(policy.settings).toMatchObject({ looksUp: 'rightAway', makesNew: 'rightAway', changesThings: 'asksFirst', deletesOrSends: 'asksFirst' });
    expect(policy.tools.map((tool) => [tool.name, tool.heading, tool.state])).toEqual([
      ['example_lookuppayment', 'looksUp', 'confirmed'],
      ['example_makepaymentlink', 'makesNew', 'confirmed'],
    ]);
    const [app] = await keyAppsOf(saraBrick);
    expect(app.operations.map((operation) => [operation.tool, operation.fingerprint])).toEqual(policy.tools.map((tool) => [tool.name, tool.fingerprint]));
    // Reading again, and replacing the key, change nothing
    const again = await toolsOf(saraBrick, grant.id);
    expect(again.policyRevision).toBe(policy.policyRevision);
    const replace = await openKeyForm({ ownerId: sara, service: 'examplepay' });
    await submitKey({ requestId: replace.id, ownerId: sara, key: `sk_test_${randomUUID().replace(/-/g, '')}` }, okCheck);
    expect((await toolsOf(saraBrick, grant.id)).policyRevision).toBe(policy.policyRevision);
  });

  it('makes the tools once when two calls ask at the same moment, and neither fails', async () => {
    const id = await connectGateway();
    const grant = (await grantOf(saraBrick, id))!;
    await prisma.botMcpTool.deleteMany({ where: { serverId: grant.id } });
    const [first, second, third] = await Promise.all([ensureKeyAppTools(grant.id), ensureKeyAppTools(grant.id), ensureKeyAppTools(grant.id)]);
    expect([first, second, third].some(Boolean)).toBe(true);
    expect((await prisma.botMcpTool.findMany({ where: { serverId: grant.id } })).map((tool) => tool.name).sort()).toEqual(['example_lookuppayment', 'example_makepaymentlink']);
  });

  it('a call that read the tools before another one brought them up to date does not overwrite what that one wrote or what the owner decided since', async () => {
    const id = await connectGateway();
    const grant = (await grantOf(saraBrick, id))!;
    await toolsOf(saraBrick, grant.id);
    const rows = await prisma.botMcpTool.findMany({ where: { serverId: grant.id }, orderBy: { name: 'asc' } });
    // The rows are of an older version when the stale call reads them...
    await prisma.botMcpTool.updateMany({ where: { serverId: grant.id }, data: { fingerprint: 'old-version' } });
    const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (...args: unknown[]) => {
      // ...and by the time it writes, the other call has made them current and the owner has moved one
      await prisma.botMcpTool.updateMany({ where: { id: rows[0].id }, data: { fingerprint: rows[0].fingerprint, heading: 'changesThings', movedById: sara } });
      await prisma.botMcpTool.updateMany({ where: { id: rows[1].id }, data: { fingerprint: rows[1].fingerprint } });
      return real(...args);
    }) as never);
    try {
      await ensureKeyAppTools(grant.id);
    } finally {
      spy.mockRestore();
    }
    const after = await prisma.botMcpTool.findMany({ where: { serverId: grant.id }, orderBy: { name: 'asc' } });
    expect(after[0]).toMatchObject({ fingerprint: rows[0].fingerprint, heading: 'changesThings', movedById: sara });
  });

  it('keeps a custom app’s operations waiting to be confirmed, and forgets a confirmation when the definition changes', async () => {
    const draft = (extra = {}) => ({
      version: 1, service: 'custom', name: 'ShipLink', short: 'ShipLink', origin: 'https://api.shiplink.com', placement: { in: 'header', name: 'X-Api-Key', scheme: 'none' },
      operations: [
        { id: 'track', label: 'Track a parcel', method: 'GET', path: '/v1/parcels/{id}', params: [{ name: 'id', type: 'string', in: 'path' }], returns: ['status'], category: 'lookUp', ...extra },
        { id: 'remove', label: 'Remove a parcel', method: 'DELETE', path: '/v1/parcels/{id}', params: [{ name: 'id', type: 'string', in: 'path' }], returns: ['ok'], category: 'deleteSend' },
      ],
      check: { operation: 'track', arguments: { id: 'check' } },
    });
    const connect = async (definition: object) => {
      const form = await openKeyForm({ ownerId: sara, draft: definition, source: 'https://docs.shiplink.com/api' });
      return (await submitKey({ requestId: form.id, ownerId: sara, key: 'shiplink-secret-123456' }, okCheck)).id;
    };
    const id = await connect(draft());
    const grant = (await grantOf(saraBrick, id))!;
    const before = await toolsOf(saraBrick, grant.id);
    expect(before.state).toBe('notConfirmedYet');
    expect(before.tools.every((tool) => tool.state === 'notConfirmedYet' && tool.heading === null)).toBe(true);
    // Its owner confirms them, and they hold through a replaced key
    await confirmTools(saraBrick, grant.id, sara);
    expect((await toolsOf(saraBrick, grant.id)).state).toBe('confirmed');
    await connect(draft());
    expect((await toolsOf(saraBrick, grant.id)).state).toBe('confirmed');
    // A different definition (an operation reworded) is a different version: nothing it was confirmed for carries over
    await connect(draft({ label: 'Track a parcel now' }));
    const changed = await toolsOf(saraBrick, grant.id);
    expect(changed.tools.map((tool) => tool.state)).toEqual(['notConfirmedYet', 'notConfirmedYet']);
  });

  it('does not list a key app among the servers the bot server connects to', async () => {
    await connectGateway();
    const response = await listServers(request(`/api/bots/${saraBrick}/mcp-servers`, { token: ADMIN_TOKEN }), params({ id: saraBrick }));
    const body = await response.json();
    expect({ status: response.status, servers: body }).toEqual({ status: 200, servers: [] });
  });

  it('never classifies a custom operation as a look-up that runs unasked, and marks it unverified', async () => {
    const draft = {
      version: 1, service: 'custom', name: 'ShipLink', short: 'ShipLink', origin: 'https://api.shiplink.com', placement: { in: 'header', name: 'X-Api-Key', scheme: 'none' },
      operations: [
        { id: 'track', label: 'Track a parcel', method: 'GET', path: '/v1/parcels/{id}', params: [{ name: 'id', type: 'string', in: 'path' }], returns: ['status'], category: 'lookUp', verified: true },
        { id: 'remove', label: 'Remove a parcel', method: 'DELETE', path: '/v1/parcels/{id}', params: [{ name: 'id', type: 'string', in: 'path' }], returns: ['ok'], category: 'deleteSend' },
      ],
      check: { operation: 'track', arguments: { id: 'check' } },
    };
    mockUser.current = null;
    const opened = await askForKey(request(`/api/bots/${saraBrick}/app-key-forms`, { method: 'POST', token: SERVICE_TOKEN, body: { requesterKey: `sara-${tag}`, draft, source: 'https://docs.shiplink.com/api' } }), params({ id: saraBrick }));
    expect(opened.status).toBe(201);
    const view = await readKeyForm((await opened.json()).id, sara);
    expect(view).toMatchObject({ mode: 'custom', name: 'ShipLink', host: 'api.shiplink.com', source: 'docs.shiplink.com', differentSite: false, check: 'Track a parcel' });
    const done = await submitKey({ requestId: (await prisma.appKeyRequest.findFirstOrThrow({ where: { ownerId: sara } })).id, ownerId: sara, key: 'shiplink-secret-123456' }, okCheck);
    const apps = await keyAppsOf(saraBrick);
    const ship = apps.find((app) => app.connectionId === done.id)!;
    expect(ship.operations.map((operation) => [operation.id, operation.heading, operation.verified])).toEqual([
      ['track', 'changesThings', false],
      ['remove', 'deletesOrSends', false],
    ]);
  });

  /* ------------------------- Brick-started forms ------------------------- */

  it('opens a form for a Brick’s owner only, for a service or a draft with its source, and for nobody else', async () => {
    const ask = (botId: string, body: Record<string, unknown>) => askForKey(request(`/api/bots/${botId}/app-key-forms`, { method: 'POST', token: SERVICE_TOKEN, body }), params({ id: botId }));
    expect((await ask(saraBrick, { requesterKey: `sara-${tag}`, service: 'examplepay' })).status).toBe(201);
    // Someone who is not the Brick's owner, a Brick of someone else, a room bot, and a person who is not there: the same answer
    expect((await ask(saraBrick, { requesterKey: `omar-${tag}`, service: 'examplepay' })).status).toBe(404);
    expect((await ask(omarBrick, { requesterKey: `sara-${tag}`, service: 'examplepay' })).status).toBe(404);
    expect((await ask(roomBot, { requesterKey: `sara-${tag}`, service: 'examplepay' })).status).toBe(404);
    expect((await ask(saraBrick, { requesterKey: `nobody-${tag}`, service: 'examplepay' })).status).toBe(404);
    await prisma.user.update({ where: { id: sara }, data: { isGuest: true } });
    expect((await ask(saraBrick, { requesterKey: `sara-${tag}`, service: 'examplepay' })).status).toBe(404);
    await prisma.user.update({ where: { id: sara }, data: { isGuest: false } });
    // The shape: a service or a draft with where it came from, nothing else
    expect((await ask(saraBrick, { requesterKey: `sara-${tag}` })).status).toBe(400);
    expect((await ask(saraBrick, { requesterKey: `sara-${tag}`, draft: { nonsense: true } })).status).toBe(400);
    expect((await ask(saraBrick, { requesterKey: `sara-${tag}`, draft: { nonsense: true }, source: 'https://docs.example.com' })).status).toBe(400);
    expect((await ask(saraBrick, { requesterKey: `sara-${tag}`, service: 'examplepay', origin: 'https://evil.example' })).status).toBe(400);
    expect((await ask(saraBrick, { service: 'examplepay' })).status).toBe(400);
    expect((await askForKey(request(`/api/bots/${saraBrick}/app-key-forms`, { method: 'POST', body: { requesterKey: `sara-${tag}`, service: 'examplepay' } }), params({ id: saraBrick }))).status).toBe(401);
  });

  /* ------------------------- the call ------------------------- */

  it('runs one operation for the owner: the key only in the header, to the origin, and only the listed fields come back', async () => {
    const id = await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    const seen: { host: string; path: string; method: string; headers: Record<string, string> }[] = [];
    mockSend.current = (target) => {
      seen.push(target);
      return { status: 200, body: JSON.stringify({ id: 'chg_1', status: 'CAPTURED', amount: 4.5, currency: 'KWD', card: { number: '4111' }, echo: KEY, customer: { email: 'x@y.z' }, reference: { order: 'o-1', secret: 's' } }) };
    };
    const response = await call(saraBrick, app.serverId, app.definitionHash);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, httpStatus: 200, data: { id: 'chg_1', status: 'CAPTURED', amount: 4.5, currency: 'KWD', reference: { order: 'o-1' } }, truncated: false });
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ host: 'api.examplepay.com', path: '/v2/charges/chg_1', method: 'GET' });
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(id).toBe(app.connectionId);
  });

  it('writes the use to the books once, paid by the person, with no arguments in it', async () => {
    await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    mockSend.current = () => ({ status: 200, body: '{"id":"chg_1"}' });
    const callId = `books-${tag}`;
    await call(saraBrick, app.serverId, app.definitionHash, { callId });
    const events = await prisma.meterEvent.findMany({ where: { eventId: `app:${saraBrick}:${callId}` } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'app_use', payerKind: 'person', payerPersonId: sara, basis: 'paid_by_other', unit: 'use', route: 'key-app' });
    expect(Number(events[0].quantity)).toBe(1);
    expect(events[0].costMicros).toBeNull();
    expect(JSON.stringify(events[0].detail)).not.toContain('chg_1');
    expect(events[0].detail).toMatchObject({ app: 'Example Pay', operation: 'lookUpPayment', heading: 'looksUp', verified: true });
  });

  it('is only ever for the owner: not another person asking, not another Brick, not a Brick that is switched off', async () => {
    await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    mockSend.current = () => ({ status: 200 });
    const other = await call(saraBrick, app.serverId, app.definitionHash, { requesterKey: `omar-${tag}` });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ allowed: false, reason: 'not_owner' });
    // No asker at all is not the owner either; the bot server says forOwner only for a goal the owner set
    expect((await call(saraBrick, app.serverId, app.definitionHash, { requesterKey: undefined })).status).toBe(403);
    expect((await call(saraBrick, app.serverId, app.definitionHash, { requesterKey: undefined, forOwner: true })).status).toBe(200);
    // Someone else's Brick has no such app, and a Brick cannot use another Brick's grant
    expect((await call(omarBrick, app.serverId, app.definitionHash, { requesterKey: `omar-${tag}` })).status).toBe(404);
    expect((await call(saraStudio, app.serverId, app.definitionHash)).status).toBe(404);
    await prisma.botMcpServer.update({ where: { id: app.serverId }, data: { enabled: false } });
    const off = await call(saraBrick, app.serverId, app.definitionHash);
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ allowed: false, reason: 'off' });
  });

  it('refuses a definition that is not the version approved, an unknown operation, and arguments that are not the operation’s', async () => {
    await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    let sent = 0;
    mockSend.current = () => ((sent += 1), { status: 200 });
    const stale = await call(saraBrick, app.serverId, 'f'.repeat(64));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('changed');
    expect((await call(saraBrick, app.serverId, app.definitionHash, { operation: 'dropEverything' })).status).toBe(404);
    for (const args of [{}, { chargeId: 5 }, { chargeId: 'x', host: 'evil.example' }, { chargeId: 'x', headers: { a: 'b' } }, { chargeId: '..' }]) {
      const bad = await call(saraBrick, app.serverId, app.definitionHash, { arguments: args });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(await bad.json())).not.toContain(KEY);
    }
    // A body with anything else in it is refused whole
    expect((await call(saraBrick, app.serverId, app.definitionHash, { url: 'https://evil.example' })).status).toBe(400);
    expect(sent).toBe(0);
  });

  it('sends one call id once: a retry is refused before anything is sent', async () => {
    await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    let sent = 0;
    mockSend.current = () => ((sent += 1), { status: 200, body: '{"id":"a"}' });
    const callId = `once-${tag}`;
    expect((await call(saraBrick, app.serverId, app.definitionHash, { callId })).status).toBe(200);
    const again = await call(saraBrick, app.serverId, app.definitionHash, { callId });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('already_asked');
    const both = await Promise.all([call(saraBrick, app.serverId, app.definitionHash, { callId: `race-${tag}` }), call(saraBrick, app.serverId, app.definitionHash, { callId: `race-${tag}` })]);
    expect(both.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(sent).toBe(2);
  });

  it('never limits the person\'s own key: no hourly allowance for the person, none for everyone, and page orders take no room from it', async () => {
    // The smallest ceiling Limits can hold, a busy hour already behind the person (more than the old 300 an hour), other people's calls and a
    // page order of this hour: none of it stops a Brick using its owner's own key (Khalid, 26 Nov 2026: own keys are never limited by us)
    await saveServerLimits({ bricks: { keyCallsPlatform: 1 } }, sara);
    await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    const connection = await prisma.appConnection.findFirstOrThrow({ where: { ownerId: sara, kind: 'direct' }, select: { id: true } });
    await prisma.appKeyCall.createMany({
      data: Array.from({ length: 400 }, (_, index) => ({ connectionId: connection.id, ownerId: sara, botId: saraBrick, callId: `busy-${tag}-${index}`, operation: 'x', state: 'done', outcome: 'ok' })),
    });
    await prisma.appKeyCall.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({ connectionId: connection.id, ownerId: omar, botId: omarBrick, callId: `omar-${tag}-${index}`, operation: 'x', state: 'done', outcome: 'ok' })),
    });
    const order = await prisma.appPageOrder.create({ data: { ownerId: sara, artifactId: `art-${randomUUID()}`, definitionHash: 'h'.repeat(64), amountMinor: 100, currency: 'USD', visitorHash: 'v' } });
    let sent = 0;
    mockSend.current = () => ((sent += 1), { status: 200 });
    try {
      for (let index = 0; index < 3; index += 1) {
        const used = await call(saraBrick, app.serverId, app.definitionHash);
        expect(used.status).toBe(200);
        expect((await used.json()).ok).toBe(true);
      }
      expect(sent).toBe(3);
    } finally {
      await prisma.appPageOrder.delete({ where: { id: order.id } }).catch(() => undefined);
    }
  });

  it('never hands the model a raw error answer, a redirect, or a service that is down', async () => {
    await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    mockSend.current = () => ({ status: 422, body: JSON.stringify({ errors: [{ code: 1, description: `bad request with ${KEY} in it` }] }) });
    const failed = await call(saraBrick, app.serverId, app.definitionHash);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ ok: false, httpStatus: 422, data: null, truncated: false });
    mockSend.current = () => ({ status: 302, redirected: true });
    const redirected = await call(saraBrick, app.serverId, app.definitionHash);
    expect(redirected.status).toBe(502);
    expect((await redirected.json()).code).toBe('unavailable');
    // A service that cannot be reached: said as unavailable, never a raw error
    mockSend.current = () => ({ status: 200 });
    mockDown.current = true;
    try {
      const unreachable = await call(saraBrick, app.serverId, app.definitionHash);
      expect(unreachable.status).toBe(502);
      expect((await unreachable.json()).code).toBe('unavailable');
    } finally {
      mockDown.current = false;
      mockSend.current = null;
    }
  });

  it('counts an own key App whose service does not answer as not working, so the ready-made copy of it is the way until a good call, and never for Orbit being busy', async () => {
    const id = await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    // Sara's ready-made copy of the same App on the same Brick (the rows only: no provider is asked)
    const readyConnection = await prisma.appConnection.create({ data: { ownerId: sara, name: 'Example Pay', serverUrl: `https://ready.example/${tag}/examplepay`, source: 'ready_made', providerToolkit: 'examplepay', providerAccountId: 'ca_examplepay', providerConfirmedAt: new Date() } });
    const ready = (await prisma.botMcpServer.create({ data: { botId: saraBrick, name: 'Example Pay', serverUrl: '', authType: 'none', connectionId: readyConnection.id } })).id;
    const ownCopy = async () => {
      const response = await listServers(request(`/api/bots/${saraBrick}/mcp-servers`, { token: ADMIN_TOKEN }), params({ id: saraBrick }));
      return ((await response.json()) as { id: string; ownCopyServerId: string | null }[]).find((row) => row.id === ready)?.ownCopyServerId;
    };
    let use = 0;
    const readyUse = () => checkAppUse(saraBrick, ready, { forOwner: true, callId: `c-${tag}-ready-${use++}` });
    const noAnswerAt = async () => (await prisma.appConnection.findUniqueOrThrow({ where: { id } })).noAnswerAt;
    expect(await ownCopy()).toBe(app.serverId);
    expect(await readyUse()).toMatchObject({ allowed: false, reason: 'off' });

    // Orbit itself had no room to try: says nothing about the service, so the own copy stays the way
    mockThrow.current = new GuardError('unreachable', 'Too many name lookups are waiting', true);
    expect((await (await call(saraBrick, app.serverId, app.definitionHash)).json()).code).toBe('unavailable');
    expect(await noAnswerAt()).toBeNull();
    expect(await ownCopy()).toBe(app.serverId);
    mockThrow.current = null;

    // The service cannot be reached: the own copy no longer counts as working, and the ready-made copy is allowed meanwhile
    mockSend.current = () => ({ status: 200 });
    mockDown.current = true;
    expect((await (await call(saraBrick, app.serverId, app.definitionHash)).json()).code).toBe('unavailable');
    mockDown.current = false;
    expect(await noAnswerAt()).not.toBeNull();
    expect(await ownCopy()).toBeNull();
    expect(await readyUse()).toMatchObject({ allowed: true });

    // A good call clears it: the own copy is the way again
    expect((await call(saraBrick, app.serverId, app.definitionHash)).status).toBe(200);
    expect(await noAnswerAt()).toBeNull();
    expect(await ownCopy()).toBe(app.serverId);
    expect(await readyUse()).toMatchObject({ allowed: false, reason: 'off' });

    // No answer in time counts the same
    await new Promise((resolve) => setTimeout(resolve, 5));
    mockThrow.current = new GuardError('timeout', 'No answer in time');
    expect((await (await call(saraBrick, app.serverId, app.definitionHash)).json()).code).toBe('unavailable');
    const first = await noAnswerAt();
    expect(first).not.toBeNull();
    expect(await ownCopy()).toBeNull();
    // Another failure inside the while keeps when it started
    expect((await (await call(saraBrick, app.serverId, app.definitionHash)).json()).code).toBe('unavailable');
    expect(await noAnswerAt()).toEqual(first);

    // The while is over: nothing but a call can tell it answers again, so the own copy is the way again and is tried
    await prisma.appConnection.update({ where: { id }, data: { noAnswerAt: new Date(Date.now() - KEY_NO_ANSWER_HOLDS_MS - 60_000), lastWorkedAt: new Date(Date.now() - KEY_NO_ANSWER_HOLDS_MS - 120_000) } });
    expect(await ownCopy()).toBe(app.serverId);
    expect(await readyUse()).toMatchObject({ allowed: false, reason: 'off' });
    // Still down: written again, and the ready-made copy is the way for another while
    expect((await (await call(saraBrick, app.serverId, app.definitionHash)).json()).code).toBe('unavailable');
    expect(Date.now() - (await noAnswerAt())!.getTime()).toBeLessThan(60_000);
    expect(await ownCopy()).toBeNull();
    expect(await readyUse()).toMatchObject({ allowed: true });
  });

  it('cuts a long answer and gives back nothing from it, rather than half of it', async () => {
    await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    mockSend.current = () => ({ status: 200, body: '{"id":"cut', truncated: true });
    const response = await call(saraBrick, app.serverId, app.definitionHash);
    expect(await response.json()).toEqual({ ok: true, httpStatus: 200, data: null, truncated: true });
  });

  it('marks the key stopped working when the service refuses it, for every Brick at once, tells the owner once, and a good call or a new key ends it', async () => {
    const id = await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    mockSend.current = () => ({ status: 401 });
    const refused = await call(saraBrick, app.serverId, app.definitionHash);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ code: 'key_rejected', httpStatus: 401 });
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id } });
    expect(row.signInLostAt).not.toBeNull();
    expect(row.signInLostStatus).toBe(401);
    expect((await keyAppsOf(saraStudio))[0].working).toBe(false);
    const notices = await prisma.userNotice.findMany({ where: { userId: sara, kind: 'tool-signin', dismissedAt: null } });
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0].badge).toBe('Key stopped working');
    expect(notices[0].body).toContain('Replace key');
    expect(`${notices[0].title} ${notices[0].body}`).not.toMatch(/API|bot['’]s|MCP/);
    // A call that works again clears it
    mockSend.current = () => ({ status: 200 });
    expect((await call(saraBrick, app.serverId, app.definitionHash)).status).toBe(200);
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
    // Or a new key does, whatever else happened
    mockSend.current = () => ({ status: 403 });
    // (The good call was a minute ago or more: a refusal right behind a recorded good call is not read as a loss)
    await prisma.appConnection.update({ where: { id }, data: { lastWorkedAt: new Date(Date.now() - 2 * 60_000) } });
    await call(saraBrick, app.serverId, app.definitionHash);
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).not.toBeNull();
    mockSend.current = () => ({ status: 404 });
    const replace = await openKeyForm({ ownerId: sara, connectionId: id });
    await submitKey({ requestId: replace.id, ownerId: sara, key: `sk_test_${randomUUID().replace(/-/g, '')}` });
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
  });

  it('stops at once when it is taken away or disconnected, also for a chat that is already open', async () => {
    const id = await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    mockSend.current = () => ({ status: 200 });
    expect((await call(saraBrick, app.serverId, app.definitionHash)).status).toBe(200);
    expect(await removeGrant(sara, id, saraBrick)).toBe(true);
    expect((await call(saraBrick, app.serverId, app.definitionHash)).status).toBe(404);
    const [studio] = await keyAppsOf(saraStudio);
    expect((await call(saraStudio, studio.serverId, studio.definitionHash)).status).toBe(200);
    expect(await disconnect(sara, id)).toBe(true);
    expect((await call(saraStudio, studio.serverId, studio.definitionHash)).status).toBe(404);
    expect(await keyAppsOf(saraStudio)).toEqual([]);
  });

  it('is never written to a room bot, even by a direct write', async () => {
    const id = await connectGateway();
    await expect(prisma.botMcpServer.create({ data: { botId: roomBot, connectionId: id, name: 'Tap', serverUrl: '', authType: 'none', connectedById: sara } })).rejects.toThrow();
    await expect(prisma.botMcpServer.create({ data: { botId: omarBrick, connectionId: id, name: 'Tap', serverUrl: '', authType: 'none', connectedById: sara } })).rejects.toThrow();
  });

  it('calls straight through the library the same way, with no network in the check', async () => {
    await connectGateway();
    const [app] = await keyAppsOf(saraBrick);
    const outcome = await runKeyApp({ botId: saraBrick, serverId: app.serverId, requesterKey: `sara-${tag}`, callId: `lib-${tag}`, operation: 'lookUpPayment', arguments: { chargeId: 'chg_9' }, definitionHash: app.definitionHash }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async () => ({ status: 200, redirected: false, body: '{"id":"chg_9","status":"INITIATED"}', truncated: false, contentType: null }) });
    expect(outcome).toEqual({ status: 'done', ok: true, httpStatus: 200, data: { id: 'chg_9', status: 'INITIATED' }, truncated: false });
  });

  describe('after the review of the first version', () => {
    it('sends nothing when the owner switches the app off right after it was admitted', async () => {
      await connectGateway();
      const [app] = await keyAppsOf(saraBrick);
      let sent = 0;
      mockSend.current = () => ((sent += 1), { status: 200 });
      mockAfterCheck.current = async () => {
        await prisma.botMcpServer.update({ where: { id: app.serverId }, data: { enabled: false } });
      };
      const response = await call(saraBrick, app.serverId, app.definitionHash);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(sent).toBe(0);
      expect(await prisma.appKeyCall.count({ where: { ownerId: sara } })).toBe(0);
    });

    it('builds the request again with the new key when the key was replaced after it was admitted, never sending the old one', async () => {
      const id = await connectGateway();
      const [app] = await keyAppsOf(saraBrick);
      const fresh = `sk_test_${randomUUID().replace(/-/g, '')}`;
      const seen: string[] = [];
      mockAfterCheck.current = async () => {
        mockSend.current = () => ({ status: 404 });
        const form = await openKeyForm({ ownerId: sara, connectionId: id });
        await submitKey({ requestId: form.id, ownerId: sara, key: fresh });
      };
      mockSend.current = () => ({ status: 404 });
      // The check inside the replacement is the first thing sent; then this call's own request
      const sendSpy = (target: { headers: Record<string, string> }) => (seen.push(target.headers.Authorization ?? target.headers.authorization ?? ''), { status: 200 });
      const hookBefore = mockAfterCheck.current;
      mockAfterCheck.current = async () => {
        await hookBefore();
        mockSend.current = sendSpy;
      };
      const response = await call(saraBrick, app.serverId, app.definitionHash);
      expect(response.status).toBe(200);
      expect(seen).toEqual([`Bearer ${fresh}`]);
    });

    it('ignores a refusal that comes back from a key that was replaced while the request was out', async () => {
      const id = await connectGateway();
      const [app] = await keyAppsOf(saraBrick);
      let swapped = false;
      mockSend.current = async () => {
        if (swapped) return { status: 404 };
        swapped = true;
        const form = await openKeyForm({ ownerId: sara, connectionId: id });
        await submitKey({ requestId: form.id, ownerId: sara, key: `sk_test_${randomUUID().replace(/-/g, '')}` });
        // The old key's answer arrives after the new key was saved
        return { status: 401 };
      };
      const response = await call(saraBrick, app.serverId, app.definitionHash);
      expect(response.status).toBe(502);
      const row = await prisma.appConnection.findUniqueOrThrow({ where: { id } });
      expect(row.signInLostAt).toBeNull();
      expect((await keyAppsOf(saraBrick))[0].working).toBe(true);
    });

    it('clears a refusal another call reported while this one was out, and never one for a key that was replaced', async () => {
      const id = await connectGateway();
      const [app] = await keyAppsOf(saraBrick);
      // Two calls at once: one refused, one accepted (the accepted one began when nothing was marked)
      let order = 0;
      mockSend.current = async () => {
        order += 1;
        if (order === 1) return { status: 401 };
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: 200 };
      };
      const [first, second] = await Promise.all([call(saraBrick, app.serverId, app.definitionHash), call(saraBrick, app.serverId, app.definitionHash)]);
      expect([first.status, second.status].sort()).toEqual([200, 502]);
      expect((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).signInLostAt).toBeNull();
    });

    it('keeps working with no allowance after the app is disconnected and connected again', async () => {
      await saveServerLimits({ bricks: { keyCallsPlatform: 1 } }, sara);
      const first = await connectGateway();
      const [app] = await keyAppsOf(saraBrick);
      mockSend.current = () => ({ status: 200 });
      expect((await call(saraBrick, app.serverId, app.definitionHash)).status).toBe(200);
      expect((await call(saraBrick, app.serverId, app.definitionHash)).status).toBe(200);
      expect(await disconnect(sara, first)).toBe(true);
      expect(await prisma.appKeyCall.count({ where: { ownerId: sara } })).toBe(2);
      await connectGateway();
      const [again] = await keyAppsOf(saraBrick);
      expect((await call(saraBrick, again.serverId, again.definitionHash)).status).toBe(200);
    });

    it('leaves no Brick behind when its starting access cannot be written', async () => {
      await connectGateway();
      const before = await prisma.bot.count({ where: { ownerId: sara } });
      // The write of the grant fails inside the transaction that makes the Brick
      const real = prisma.$transaction.bind(prisma);
      const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
        (real as (...args: unknown[]) => Promise<unknown>)(
          (tx: Record<string, unknown>) =>
            fn(
              new Proxy(tx, {
                get: (target, prop) => {
                  if (prop !== 'botMcpServer') return Reflect.get(target, prop);
                  const model = target.botMcpServer as Record<string, unknown>;
                  return new Proxy(model, {
                    get: (m, name) => (name === 'create' ? () => Promise.reject(new Error('grant failed')) : typeof m[name as string] === 'function' ? (m[name as string] as (...args: unknown[]) => unknown).bind(m) : m[name as string]),
                  });
                },
              }),
            ),
          ...rest,
        )) as never);
      try {
        await expect(createBrick({ ownerId: sara, name: 'Half made' })).rejects.toThrow('grant failed');
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.bot.count({ where: { ownerId: sara } })).toBe(before);
    });
  });
});
