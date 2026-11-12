/**
 * Apps a person connects once, and the Bricks that may use them (game #2001), against a real database: what only the database
 * can show. One connection used by two Bricks; an app taken from one Brick in the middle of a chat; one disconnected in the
 * middle of a chat; a person's app never used for anyone else's request; two renewals at once; a stale or replayed return from
 * a sign-in page; and a grant that no code, and no direct write, can hand to a room bot or to someone else's Brick. Runs only
 * with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/app-connections-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/mcp/outbound-guard', () => ({
  ...jest.requireActual('@/lib/mcp/outbound-guard'),
  checkOutboundUrl: jest.fn(async () => ({ allowed: true })),
}));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { encryptApiKey, decryptApiKey } from '@/lib/encryption';
import {
  checkAppUse,
  createConnection,
  disconnect,
  effectiveServer,
  grantToBrick,
  listConnections,
  markConnectionReconnected,
  newSignInNonce,
  removeGrant,
  takeSignInNonce,
  WITH_CONNECTION,
} from '@/lib/app-connections';
import { ensureFreshOAuthConfig, LEASE_MS } from '@/lib/mcp/oauth-refresh';
import { reportToolSignIn } from '@/lib/tool-signin';
import { GET as listApps, POST as addApp } from '@/app/api/me/apps/route';
import { DELETE as disconnectApp } from '@/app/api/me/apps/[connectionId]/route';
import { POST as letUse } from '@/app/api/me/apps/[connectionId]/bricks/route';
import { DELETE as removeApp } from '@/app/api/me/apps/[connectionId]/bricks/[botId]/route';
import { GET as signInStart } from '@/app/api/me/apps/[connectionId]/sign-in/route';
import { GET as listServers } from '@/app/api/bots/[id]/mcp-servers/route';
import { PATCH as patchServer, DELETE as deleteServer } from '@/app/api/bots/[id]/mcp-servers/[serverId]/route';
import { POST as useCheck } from '@/app/api/bots/[id]/mcp-servers/[serverId]/use/route';
import { GET as signInReturn } from '@/app/api/oauth/mcp-callback/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const SERVICE_TOKEN = `service-${tag}`;
const ADMIN_TOKEN = `admin-${tag}`;
const LINK = 'https://mcp.example.com/mcp';
const TOKEN_URL = 'https://auth.example.com/oauth2/token';
const nowSeconds = () => Math.floor(Date.now() / 1000);

let sara = '';
let omar = '';
let saraBrick = '';
let saraStudio = '';
let omarBrick = '';
let roomBot = '';
let universeId = '';
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN, adminUrl: process.env.ADMIN_API_URL, key: process.env.ENCRYPTION_KEY };
const fetchBefore = global.fetch;

const oauthConfig = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ clientId: 'client-abc', authorizeUrl: 'https://auth.example.com/oauth2/authorize', tokenUrl: TOKEN_URL, ...extra });

const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const newOAuthApp = (ownerId: string, config: Record<string, unknown> = {}) =>
  createConnection(ownerId, { name: 'Calendar', serverUrl: LINK, authType: 'oauth', authConfig: oauthConfig(config), source: 'link' });

/** An approval the person said yes to for an app, and a card for it that still waits, both named by the Brick's row. */
async function approvalsFor(botId: string, serverId: string) {
  const base = { botId, requesterKey: `sara-${tag}`, conversationKey: 'dm', connectionRef: serverId, toolName: 'create_event', heading: 'changesThings', toolFingerprint: 'fp', policyRevision: 1 };
  const grant = await prisma.botActionGrant.create({
    data: { ...base, scope: { fixed: {}, varies: [] }, idleMinutes: 60, idleExpiresAt: new Date(Date.now() + 3_600_000), absoluteExpiresAt: new Date(Date.now() + 8 * 3_600_000) },
  });
  const card = await prisma.botActionRequest.create({
    data: { ...base, proposalKey: `p-${randomUUID()}`, arguments: encryptApiKey('{}'), argumentsDigest: 'd', reviewExpiresAt: new Date(Date.now() + 600_000) },
  });
  return { grantId: grant.id, cardId: card.id };
}

run('apps a person connects once, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    process.env.ADMIN_API_URL = 'https://orbit.example.com';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
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
    global.fetch = fetchBefore;
    mockUser.current = null;
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.botMcpServer.deleteMany({ where: { botId: { in: [saraBrick, saraStudio, omarBrick, roomBot] } } });
    await prisma.botActionRequest.deleteMany({ where: { botId: { in: [saraBrick, saraStudio] } } });
    await prisma.botActionGrant.deleteMany({ where: { botId: { in: [saraBrick, saraStudio] } } });
    await prisma.userNotice.deleteMany({ where: { userId: { in: [sara, omar] } } });
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    for (const [key, value] of [['BOT_SERVICE_TOKEN', envBefore.service], ['ADMIN_API_TOKEN', envBefore.admin], ['ADMIN_API_URL', envBefore.adminUrl], ['ENCRYPTION_KEY', envBefore.key]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect();
  });

  /* ------------------------------ grants ------------------------------ */

  it('gives a new Brick no app: nothing is granted by default', async () => {
    const connection = await newOAuthApp(sara);
    expect(await prisma.botMcpServer.count({ where: { botId: { in: [saraBrick, saraStudio] } } })).toBe(0);
    const [view] = await listConnections(sara);
    expect(view).toMatchObject({ id: connection.id, bricks: [] });
    const fresh = await createBrick({ ownerId: sara, name: 'Another Brick' });
    expect(await prisma.botMcpServer.count({ where: { botId: fresh.id } })).toBe(0);
    await prisma.bot.delete({ where: { id: fresh.id } });
  });

  it('lets one Brick use it with today’s defaults for the four headings, and keeps the link and the way in on the connection only', async () => {
    const connection = await newOAuthApp(sara, { accessToken: 'token-1', refreshToken: 'refresh-1', expiresAt: nowSeconds() + 3600 });
    const grant = await grantToBrick(sara, connection.id, saraBrick);
    expect(grant).toMatchObject({ botId: saraBrick, connectionId: connection.id, lookUpSetting: 'rightAway', makeSetting: 'rightAway', changeSetting: 'asksFirst', deleteSendSetting: 'asksFirst' });
    // Nothing was copied: the row holds neither the link nor the sign-in
    const row = await prisma.botMcpServer.findUniqueOrThrow({ where: { id: grant!.id }, include: WITH_CONNECTION });
    expect(row.serverUrl).toBe('');
    expect(row.authConfig).toBeNull();
    // What is used is read from the connection
    const used = effectiveServer(row);
    expect(used).toMatchObject({ serverUrl: LINK, authType: 'oauth', name: 'Calendar' });
    expect(JSON.parse(decryptApiKey(used.authConfig!))).toMatchObject({ accessToken: 'token-1' });
  });

  it('asked twice gives the same grant', async () => {
    const connection = await newOAuthApp(sara);
    const first = await grantToBrick(sara, connection.id, saraBrick);
    const second = await grantToBrick(sara, connection.id, saraBrick);
    expect(second!.id).toBe(first!.id);
    expect(await prisma.botMcpServer.count({ where: { connectionId: connection.id } })).toBe(1);
  });

  it('never grants to a room bot, to someone else’s Brick, or an app that is not theirs', async () => {
    const mine = await newOAuthApp(sara);
    expect(await grantToBrick(sara, mine.id, roomBot)).toBeNull();
    expect(await grantToBrick(sara, mine.id, omarBrick)).toBeNull();
    const theirs = await newOAuthApp(omar);
    expect(await grantToBrick(sara, theirs.id, saraBrick)).toBeNull();
    expect(await prisma.botMcpServer.count({ where: { connectionId: { in: [mine.id, theirs.id] } } })).toBe(0);
  });

  it('refuses the same grants when written directly, so no code can hand a person’s app to a room or to someone else', async () => {
    const connection = await newOAuthApp(sara);
    const row = (botId: string) => prisma.botMcpServer.create({ data: { botId, connectionId: connection.id, name: 'x', serverUrl: '' } });
    await expect(row(roomBot)).rejects.toThrow(/own Bricks/);
    await expect(row(omarBrick)).rejects.toThrow(/own Bricks/);
    await expect(row(saraBrick)).resolves.toMatchObject({ botId: saraBrick });
    // and a row cannot be moved to another bot afterwards either
    const moved = await prisma.botMcpServer.findFirstOrThrow({ where: { connectionId: connection.id } });
    await expect(prisma.botMcpServer.update({ where: { id: moved.id }, data: { botId: omarBrick } })).rejects.toThrow(/own Bricks/);
  });

  it('leaves every app set up on a bot as before: no connection, and it is read as it is', async () => {
    const own = await prisma.botMcpServer.create({ data: { botId: saraBrick, name: 'Tavily', serverUrl: 'https://tavily.example.com/mcp', authType: 'bearer', authConfig: encryptApiKey('key') } });
    const read = effectiveServer(await prisma.botMcpServer.findUniqueOrThrow({ where: { id: own.id }, include: WITH_CONNECTION }));
    expect(read).toMatchObject({ name: 'Tavily', serverUrl: 'https://tavily.example.com/mcp', authType: 'bearer', connectionId: null });
    expect(await checkAppUse(saraBrick, own.id, {})).toEqual({ allowed: true, viaConnection: false });
  });

  /* --------------------- one connection, two Bricks --------------------- */

  it('serves one connection to two Bricks from the same sign-in, and refreshes it once for both', async () => {
    const connection = await newOAuthApp(sara, { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: nowSeconds() - 60 });
    const a = await grantToBrick(sara, connection.id, saraBrick);
    const b = await grantToBrick(sara, connection.id, saraStudio);
    const fetchMock = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'refresh-2', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    mockUser.current = null;
    const read = async (botId: string) =>
      (await listServers(request(`/api/bots/${botId}/mcp-servers`, { token: ADMIN_TOKEN }), params({ id: botId }))).json();
    const [fromA, fromB] = await Promise.all([read(saraBrick), read(saraStudio)]);
    // The token endpoint was asked ONCE for the two Bricks (a rotating refresh token is spent by the first use)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const token = (rows: { authConfig: string }[]) => JSON.parse(decryptApiKey(rows[0].authConfig));
    expect(token(fromA)).toMatchObject({ accessToken: 'new', refreshToken: 'refresh-2' });
    expect(token(fromB)).toMatchObject({ accessToken: 'new', refreshToken: 'refresh-2' });
    expect(fromA[0]).toMatchObject({ id: a!.id, connectionId: connection.id, serverUrl: LINK, name: 'Calendar' });
    expect(fromB[0]).toMatchObject({ id: b!.id, connectionId: connection.id });
    // the stored config is the connection's: one row changed, and no grant row holds a token
    expect(JSON.parse(decryptApiKey((await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } })).authConfig!))).toMatchObject({ accessToken: 'new' });
    expect(await prisma.botMcpServer.count({ where: { connectionId: connection.id, authConfig: { not: null } } })).toBe(0);
  });

  it('does not renew a second time when another request holds the renewal: it waits and uses what that one stored', async () => {
    const connection = await newOAuthApp(sara, { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: nowSeconds() - 60 });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    // Another server holds the lease and stores a fresh token a moment later
    await prisma.appConnection.update({ where: { id: connection.id }, data: { refreshLeaseUntil: new Date(Date.now() + LEASE_MS) } });
    const before = (await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } })).authConfig!;
    const waiting = ensureFreshOAuthConfig({ serverId: 'unused', connectionId: connection.id, authConfig: before });
    setTimeout(async () => {
      await prisma.appConnection.update({
        where: { id: connection.id },
        data: { authConfig: encryptApiKey(oauthConfig({ accessToken: 'theirs', refreshToken: 'refresh-2', expiresAt: nowSeconds() + 3600 })), refreshLeaseUntil: null },
      });
    }, 400);
    const outcome = await waiting;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe('fresh');
    expect(outcome.config).toMatchObject({ accessToken: 'theirs' });
  });

  it('takes the renewal over when the one that held it never finished (the lease ends by itself)', async () => {
    const connection = await newOAuthApp(sara, { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: nowSeconds() - 60 });
    await prisma.appConnection.update({ where: { id: connection.id }, data: { refreshLeaseUntil: new Date(Date.now() - 1000) } });
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 3600, refresh_token: 'r2' }), { status: 200 })) as unknown as typeof fetch;
    const stored = (await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } })).authConfig!;
    const outcome = await ensureFreshOAuthConfig({ serverId: 'unused', connectionId: connection.id, authConfig: stored });
    expect(outcome.status).toBe('refreshed');
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } })).refreshLeaseUntil).toBeNull();
  });

  /* ---------------- taking it away, in the middle of a chat ---------------- */

  it('stops one Brick at once when the app is taken from it, and leaves the other Brick using it', async () => {
    const connection = await newOAuthApp(sara);
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    const b = (await grantToBrick(sara, connection.id, saraStudio))!;
    const asSara = { requesterKey: `sara-${tag}` };
    expect(await checkAppUse(saraBrick, a.id, asSara)).toMatchObject({ allowed: true });
    const { grantId, cardId } = await approvalsFor(saraBrick, a.id);
    const { grantId: otherGrant, cardId: otherCard } = await approvalsFor(saraStudio, b.id);

    // the chat is open; the person taps Remove
    mockUser.current = { id: sara };
    const res = await removeApp(request(`/api/me/apps/${connection.id}/bricks/${saraBrick}`, { method: 'DELETE' }), params({ connectionId: connection.id, botId: saraBrick }));
    expect(res.status).toBe(204);

    // the very next use finds nothing
    expect(await checkAppUse(saraBrick, a.id, asSara)).toBeNull();
    const answer = await (await useCheck(request(`/api/bots/${saraBrick}/mcp-servers/${a.id}/use`, { method: 'POST', token: SERVICE_TOKEN, body: asSara }), params({ id: saraBrick, serverId: a.id }))).json();
    expect(answer).toMatchObject({ allowed: false, reason: 'gone' });
    // every approval for it ended and its waiting card is closed ...
    expect((await prisma.botActionGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt).not.toBeNull();
    expect(await prisma.botActionRequest.findUniqueOrThrow({ where: { id: cardId } })).toMatchObject({ status: 'closed', closedReason: 'revoked' });
    // ... and the other Brick is untouched
    expect(await checkAppUse(saraStudio, b.id, asSara)).toMatchObject({ allowed: true });
    expect((await prisma.botActionGrant.findUniqueOrThrow({ where: { id: otherGrant } })).revokedAt).toBeNull();
    expect((await prisma.botActionRequest.findUniqueOrThrow({ where: { id: otherCard } })).status).toBe('waiting');
    expect(await prisma.appConnection.count({ where: { id: connection.id } })).toBe(1);
  });

  it('stops every Brick at once when the app is disconnected, and ends every approval for it', async () => {
    const connection = await newOAuthApp(sara);
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    const b = (await grantToBrick(sara, connection.id, saraStudio))!;
    const first = await approvalsFor(saraBrick, a.id);
    const second = await approvalsFor(saraStudio, b.id);

    mockUser.current = { id: sara };
    const res = await disconnectApp(request(`/api/me/apps/${connection.id}`, { method: 'DELETE' }), params({ connectionId: connection.id }));
    expect(res.status).toBe(204);

    expect(await checkAppUse(saraBrick, a.id, { requesterKey: `sara-${tag}` })).toBeNull();
    expect(await checkAppUse(saraStudio, b.id, { forOwner: true })).toBeNull();
    expect(await prisma.botMcpServer.count({ where: { connectionId: connection.id } })).toBe(0);
    expect(await prisma.appConnection.count({ where: { id: connection.id } })).toBe(0);
    for (const { grantId, cardId } of [first, second]) {
      expect((await prisma.botActionGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt).not.toBeNull();
      expect((await prisma.botActionRequest.findUniqueOrThrow({ where: { id: cardId } })).status).toBe('closed');
    }
  });

  it('does not let a card that was open for a removed app be approved afterwards', async () => {
    const connection = await newOAuthApp(sara);
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    const { cardId } = await approvalsFor(saraBrick, a.id);
    expect(await removeGrant(sara, connection.id, saraBrick)).toBe(true);
    const card = await prisma.botActionRequest.findUniqueOrThrow({ where: { id: cardId } });
    expect(card.status).toBe('closed');
    // a second Remove for the same Brick is the same answer as for one that never was
    expect(await removeGrant(sara, connection.id, saraBrick)).toBe(false);
  });

  it('removes a grant through the Brick’s own app route too, ending its approvals, and refuses to change its link there', async () => {
    const connection = await newOAuthApp(sara);
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    const { grantId } = await approvalsFor(saraBrick, a.id);
    mockUser.current = { id: sara };
    const url = `/api/bots/${saraBrick}/mcp-servers/${a.id}`;
    // its switch is its own
    const off = await patchServer(request(url, { method: 'PATCH', body: { enabled: false } }), params({ id: saraBrick, serverId: a.id }));
    expect(off.status).toBe(200);
    expect(await checkAppUse(saraBrick, a.id, { requesterKey: `sara-${tag}` })).toMatchObject({ allowed: false, reason: 'off' });
    // its link, its way in and its name are the app's
    for (const body of [{ serverUrl: 'https://other.example.com/mcp' }, { authType: 'none' }, { authConfig: 'x' }, { name: 'Other' }, { headers: { a: 'b' } }]) {
      const refused = await patchServer(request(url, { method: 'PATCH', body }), params({ id: saraBrick, serverId: a.id }));
      expect(refused.status).toBe(409);
    }
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } })).serverUrl).toBe(LINK);
    const gone = await deleteServer(request(url, { method: 'DELETE' }), params({ id: saraBrick, serverId: a.id }));
    expect(gone.status).toBe(204);
    expect((await prisma.botActionGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt).not.toBeNull();
    expect(await prisma.appConnection.count({ where: { id: connection.id } })).toBe(1);
  });

  /* ----------------------- only for its owner ----------------------- */

  it('is used only for the person who owns it: a second account in the same chat gets nothing', async () => {
    const connection = await newOAuthApp(sara);
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    // the owner, named by uuid or by email
    expect(await checkAppUse(saraBrick, a.id, { requesterKey: `sara-${tag}` })).toEqual({ allowed: true, viaConnection: true });
    expect(await checkAppUse(saraBrick, a.id, { requesterKey: `sara-${tag}@example.test` })).toMatchObject({ allowed: true });
    // the Brick working for its owner on its own (a goal they set)
    expect(await checkAppUse(saraBrick, a.id, { forOwner: true })).toMatchObject({ allowed: true });
    // a second account, by uuid or email; a guest; nobody named; a stranger's key
    const refused = [{ requesterKey: `omar-${tag}` }, { requesterKey: `omar-${tag}@example.test` }, { requesterKey: 'a-guest-session' }, {}];
    for (const input of refused) expect(await checkAppUse(saraBrick, a.id, input)).toEqual({ allowed: false, reason: 'not_owner', viaConnection: true });
    // and the answer over the wire says nothing about the app
    const wire = await (await useCheck(request(`/api/bots/${saraBrick}/mcp-servers/${a.id}/use`, { method: 'POST', token: SERVICE_TOKEN, body: { requesterKey: `omar-${tag}` } }), params({ id: saraBrick, serverId: a.id }))).json();
    expect(wire).toEqual({ allowed: false, reason: 'not_owner', viaConnection: true });
    expect(JSON.stringify(wire)).not.toMatch(/Calendar|mcp\.example|sara/);
  });

  it('refuses a person who is a guest, even when named as the owner', async () => {
    const connection = await newOAuthApp(sara);
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    await prisma.user.update({ where: { id: sara }, data: { isGuest: true } });
    try {
      expect(await checkAppUse(saraBrick, a.id, { requesterKey: `sara-${tag}` })).toMatchObject({ allowed: false, reason: 'not_owner' });
    } finally {
      await prisma.user.update({ where: { id: sara }, data: { isGuest: false } });
    }
  });

  it('asks the bot server’s check only with the service token', async () => {
    const connection = await newOAuthApp(sara);
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    const asked = (token?: string) => useCheck(request(`/api/bots/${saraBrick}/mcp-servers/${a.id}/use`, { method: 'POST', token, body: { forOwner: true } }), params({ id: saraBrick, serverId: a.id }));
    expect((await asked()).status).toBe(401);
    expect((await asked('wrong')).status).toBe(401);
    expect((await asked(ADMIN_TOKEN)).status).toBe(401);
    expect((await asked(SERVICE_TOKEN)).status).toBe(200);
  });

  /* ------------------ a person's own pages are only theirs ------------------ */

  it('lists only the caller’s own apps, and answers someone else’s like one that does not exist', async () => {
    const mine = await newOAuthApp(sara);
    const theirs = await newOAuthApp(omar);
    await grantToBrick(sara, mine.id, saraBrick);
    mockUser.current = { id: sara };
    const listed = await (await listApps(request('/api/me/apps'))).json();
    expect(listed.apps.map((app: { id: string }) => app.id)).toEqual([mine.id]);
    expect(listed.apps[0].bricks).toEqual([expect.objectContaining({ botId: saraBrick, botName: 'Brick', headings: { lookUp: 'rightAway', make: 'rightAway', change: 'asksFirst', deleteSend: 'asksFirst' } })]);
    expect(JSON.stringify(listed)).not.toMatch(/authConfig|accessToken|clientSecret/);
    expect(listed.bricks.map((brick: { id: string }) => brick.id).sort()).toEqual([saraBrick, saraStudio].sort());
    const missing = await disconnectApp(request(`/api/me/apps/${theirs.id}`, { method: 'DELETE' }), params({ connectionId: theirs.id }));
    const nothing = await disconnectApp(request('/api/me/apps/nope', { method: 'DELETE' }), params({ connectionId: 'nope' }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await nothing.json());
    expect(await prisma.appConnection.count({ where: { id: theirs.id } })).toBe(1);
    const letOther = await letUse(request(`/api/me/apps/${theirs.id}/bricks`, { method: 'POST', body: { botId: saraBrick } }), params({ connectionId: theirs.id }));
    expect(letOther.status).toBe(404);
  });

  it('needs a signed-in person who is not a guest', async () => {
    expect((await listApps(request('/api/me/apps'))).status).toBe(401);
    mockUser.current = { id: sara, isGuest: true };
    expect((await listApps(request('/api/me/apps'))).status).toBe(403);
  });

  it('adds an app by its link with the same checks a bot’s own takes, and no Brick uses it yet', async () => {
    mockUser.current = { id: sara };
    const bad = await addApp(request('/api/me/apps', { method: 'POST', body: { name: 'x', serverUrl: 'http://127.0.0.1/mcp' } }));
    expect(bad.status).toBe(400);
    const none = await addApp(request('/api/me/apps', { method: 'POST', body: { name: 'Tavily', serverUrl: 'https://tavily.example.com/mcp', authType: 'bearer', authConfig: 'tvly-key' } }));
    expect(none.status).toBe(201);
    const [view] = await listConnections(sara);
    expect(view).toMatchObject({ name: 'Tavily', source: 'link', connected: true, bricks: [] });
    expect(await prisma.botMcpServer.count({ where: { botId: { in: [saraBrick, saraStudio] } } })).toBe(0);
  });

  /* ------------------------- signing in, and back ------------------------- */

  it('takes the sign-in ticket exactly once, and refuses a return from a sign-in a newer one replaced', async () => {
    const connection = await newOAuthApp(sara);
    const first = await newSignInNonce(connection.id);
    const second = await newSignInNonce(connection.id);
    expect(await takeSignInNonce(connection.id, first)).toBe(false);
    expect(await takeSignInNonce(connection.id, second)).toBe(true);
    expect(await takeSignInNonce(connection.id, second)).toBe(false);
    expect(await takeSignInNonce(connection.id, undefined)).toBe(false);
  });

  it('signs in through the app’s own page once for every Brick, and refuses a replayed or stale return', async () => {
    const connection = await newOAuthApp(sara);
    await grantToBrick(sara, connection.id, saraBrick);
    await grantToBrick(sara, connection.id, saraStudio);
    mockUser.current = { id: sara };
    const started = await (await signInStart(request(`/api/me/apps/${connection.id}/sign-in?redirectUrl=${encodeURIComponent('http://localhost/admin')}`), params({ connectionId: connection.id }))).json();
    const address = new URL(started.authorizeUrl);
    expect(address.origin + address.pathname).toBe('https://auth.example.com/oauth2/authorize');
    expect(address.searchParams.get('resource')).toBe(LINK);
    const state = address.searchParams.get('state')!;
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ access_token: 'signed-in', refresh_token: 'r', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;

    const back = (s: string) => signInReturn(request(`/api/oauth/mcp-callback?code=abc&state=${encodeURIComponent(s)}`));
    const ok = await back(state);
    expect(ok.headers.get('location')).toContain('oauth=success');
    expect(JSON.parse(decryptApiKey((await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } })).authConfig!))).toMatchObject({ accessToken: 'signed-in' });

    // the same return again (a replay, or a reload of the popup)
    const replay = await back(state);
    expect(replay.headers.get('location')).toContain('message=sign_in_expired');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // an older sign-in whose popup was left open, returning after a newer one started
    const older = new URL((await (await signInStart(request(`/api/me/apps/${connection.id}/sign-in?redirectUrl=${encodeURIComponent('http://localhost/admin')}`), params({ connectionId: connection.id }))).json()).authorizeUrl).searchParams.get('state')!;
    await signInStart(request(`/api/me/apps/${connection.id}/sign-in?redirectUrl=${encodeURIComponent('http://localhost/admin')}`), params({ connectionId: connection.id }));
    const stale = await back(older);
    expect(stale.headers.get('location')).toContain('message=sign_in_expired');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a return that carries someone else’s sign-in for a person’s connection', async () => {
    const connection = await newOAuthApp(sara);
    mockUser.current = { id: omar };
    // omar cannot even start it
    const refused = await signInStart(request(`/api/me/apps/${connection.id}/sign-in`), params({ connectionId: connection.id }));
    expect(refused.status).toBe(404);
    // a state made for omar naming sara’s connection is refused at the return, before any code is spent
    const nonce = await newSignInNonce(connection.id);
    const state = encryptApiKey(JSON.stringify({ botId: '', serverId: '', connectionId: connection.id, nonce, personId: omar, redirectUrl: 'http://localhost/admin', exp: Math.floor(Date.now() / 1000) + 600 }));
    global.fetch = jest.fn() as unknown as typeof fetch;
    const res = await signInReturn(request(`/api/oauth/mcp-callback?code=abc&state=${encodeURIComponent(state)}`));
    expect(res.headers.get('location')).toContain('message=server_not_found');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  /* ----------------------------- a sign-in lost ----------------------------- */

  it('shows a lost sign-in on the connection, tells its owner once for the Brick, and one reconnect clears it for every Brick', async () => {
    const connection = await newOAuthApp(sara, { accessToken: 'token', expiresAt: nowSeconds() + 3600 });
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    const b = (await grantToBrick(sara, connection.id, saraStudio))!;
    expect(await reportToolSignIn(saraBrick, a.id, { state: 'expired', status: 401 })).toEqual({ changed: true });
    const lost = await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(lost.signInLostAt).not.toBeNull();
    expect(lost.signInLostStatus).toBe(401);
    // the other Brick sees the same through the connection
    const seen = effectiveServer(await prisma.botMcpServer.findUniqueOrThrow({ where: { id: b.id }, include: WITH_CONNECTION }));
    expect(seen.signInLostAt).toEqual(lost.signInLostAt);
    // the owner is told, for each Brick that uses it
    const notices = await prisma.userNotice.findMany({ where: { userId: sara, kind: 'tool-signin', dismissedAt: null } });
    expect(notices).toHaveLength(2);
    expect(await prisma.userNotice.count({ where: { userId: omar } })).toBe(0);
    // the same report again changes nothing
    expect(await reportToolSignIn(saraStudio, b.id, { state: 'expired', status: 401 })).toEqual({ changed: false });

    await markConnectionReconnected(connection.id, sara);
    const back = await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(back).toMatchObject({ signInLostAt: null, signInLostStatus: null, connectedById: sara });
    expect(await prisma.userNotice.count({ where: { userId: sara, kind: 'tool-signin', dismissedAt: null } })).toBe(0);
  });

  it('keeps a failure seen before a reconnect from marking the app lost again', async () => {
    const connection = await newOAuthApp(sara, { accessToken: 'token', expiresAt: nowSeconds() + 3600 });
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    const seenAt = new Date(Date.now() - 5000);
    await markConnectionReconnected(connection.id, sara);
    expect(await reportToolSignIn(saraBrick, a.id, { state: 'expired', status: 401, at: seenAt })).toEqual({ changed: false });
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: connection.id } })).signInLostAt).toBeNull();
  });

  it('refuses to sign a grant in on its own: its connection does', async () => {
    const connection = await newOAuthApp(sara);
    const a = (await grantToBrick(sara, connection.id, saraBrick))!;
    // a state naming only the grant, as a forged return would, finds no bot server to sign in
    const state = encryptApiKey(JSON.stringify({ botId: saraBrick, serverId: a.id, personId: sara, redirectUrl: 'http://localhost/admin', exp: Math.floor(Date.now() / 1000) + 600 }));
    global.fetch = jest.fn() as unknown as typeof fetch;
    const res = await signInReturn(request(`/api/oauth/mcp-callback?code=abc&state=${encodeURIComponent(state)}`));
    expect(res.headers.get('location')).toContain('message=server_not_found');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
