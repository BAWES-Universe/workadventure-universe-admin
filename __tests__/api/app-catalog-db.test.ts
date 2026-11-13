/**
 * The list of apps a person can connect with one tap (game #2001), against a real database: a super admin keeps it, a person
 * connects from it once, and nothing of its sign-in ever reaches a person. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a
 * migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/app-catalog-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));
jest.mock('@/lib/mcp/outbound-guard', () => ({
  ...jest.requireActual('@/lib/mcp/outbound-guard'),
  checkOutboundUrl: jest.fn(async () => ({ allowed: true })),
}));

import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { GET as adminList, POST as adminAdd } from '@/app/api/admin/app-catalog/route';
import { PATCH as adminChange, DELETE as adminRemove } from '@/app/api/admin/app-catalog/[id]/route';
import { GET as offerable } from '@/app/api/bots/[id]/apps/offerable/route';
import { encryptApiKey } from '@/lib/encryption';
import { GET as catalog } from '@/app/api/me/apps/catalog/route';
import { GET as myApps, POST as connectApp } from '@/app/api/me/apps/route';
import { DELETE as disconnectApp } from '@/app/api/me/apps/[connectionId]/route';
import { grantToBrick, disconnect } from '@/lib/app-connections';
import { createBrick } from '@/lib/brick-create';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const key = (name: string) => `${name}-${tag}`;
const SIGN_IN = JSON.stringify({ clientId: 'platform-client', clientSecret: 'platform-secret', authorizeUrl: 'https://accounts.example.com/auth', tokenUrl: 'https://accounts.example.com/token', scopes: 'mail' });
const entry = (name: string, extra: Record<string, unknown> = {}) => ({ key: key(name), name: name.toUpperCase(), blurb: `${name} things`, icon: 'plug', serverUrl: `https://${name}.example.com/mcp`, authType: 'oauth', authConfig: SIGN_IN, ...extra });
const request = (path: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${path}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let sara = '';
let omar = '';
let boss = '';
let saraBrick = '';

const keyBefore = process.env.ENCRYPTION_KEY;

run('the list of apps to connect, in a real database', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string, email?: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: email ?? `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    boss = (await person('boss', 'boss@example.test')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
  });
  afterEach(async () => {
    mockUser.current = null;
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appCatalogEntry.deleteMany({ where: { key: { endsWith: tag } } });
  });
  afterAll(async () => {
    if (keyBefore === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = keyBefore;
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, boss] } } });
    await prisma.$disconnect();
  });

  const asBoss = () => { mockUser.current = { id: boss, email: 'boss@example.test' }; };
  const add = async (body: Record<string, unknown>) => { asBoss(); return adminAdd(request('/api/admin/app-catalog', { method: 'POST', body })); };

  it('is kept only by a super admin', async () => {
    mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
    expect((await adminAdd(request('/api/admin/app-catalog', { method: 'POST', body: entry('gmail') }))).status).toBe(403);
    expect((await adminList(request('/api/admin/app-catalog'))).status).toBe(403);
    mockUser.current = null;
    expect((await adminList(request('/api/admin/app-catalog'))).status).toBe(403);
    expect(await prisma.appCatalogEntry.count({ where: { key: key('gmail') } })).toBe(0);
  });

  it('takes only apps that sign in on their own page or need none, with the same checks as any link, and never a shared key', async () => {
    expect((await add(entry('gmail', { authType: 'bearer', authConfig: 'one-key-for-everyone' }))).status).toBe(400);
    expect((await add(entry('gmail', { serverUrl: 'http://127.0.0.1/mcp' }))).status).toBe(400);
    expect((await add(entry('gmail', { key: 'Bad Key!' }))).status).toBe(400);
    expect((await add(entry('gmail', { authConfig: JSON.stringify({ clientId: 'x' }) }))).status).toBe(400);
    expect((await add(entry('gmail', { authConfig: JSON.stringify({ clientId: 'x', authorizeUrl: 'https://a.example.com/a', tokenUrl: 'https://a.example.com/t', revocationUrl: 'http://10.0.0.1/revoke' }) }))).status).toBe(400);
    // The sign-in and the client secret go to the revocation address: never over plain http, even to a public host
    const withSetup = (extra: Record<string, unknown>) => entry('gmail', { authConfig: JSON.stringify({ clientId: 'x', authorizeUrl: 'https://a.example.com/a', tokenUrl: 'https://a.example.com/t', ...extra }) });
    expect((await add(withSetup({ revocationUrl: 'http://a.example.com/revoke' }))).status).toBe(400);
    // A wrong type in the setup would break the sign-in for everyone who taps Connect
    expect((await add(withSetup({ scopes: ['mail'] }))).status).toBe(400);
    expect((await add(withSetup({ scopes: 5 }))).status).toBe(400);
    expect((await add(withSetup({ scopesSupported: 'mail' }))).status).toBe(400);
    expect((await add(withSetup({ scopesSupported: ['mail', 3] }))).status).toBe(400);
    // A token in the sign-in setup would be copied into every person's connection: only setup names are taken
    const setup = { clientId: 'x', authorizeUrl: 'https://a.example.com/a', tokenUrl: 'https://a.example.com/t' };
    for (const extra of [{ accessToken: 'shared' }, { refreshToken: 'shared' }, { expiresAt: 1 }, { reconnectRequired: true }, { anything: 'else' }]) {
      expect((await add(entry('gmail', { authConfig: JSON.stringify({ ...setup, ...extra }) }))).status).toBe(400);
    }
    expect((await add(entry('gmail', { authType: 'none', authConfig: JSON.stringify(setup) }))).status).toBe(400);
    // Nor a header, which would be copied into every connection as a token would
    for (const headers of [{ Authorization: 'Bearer shared' }, { 'x-api-key': 'shared' }, { 'X-Anything': 'x' }]) {
      expect((await add(entry('gmail', { headers }))).status).toBe(400);
      expect((await add(entry('gmail', { authType: 'none', authConfig: undefined, headers }))).status).toBe(400);
    }
    expect((await add(entry('gmail'))).status).toBe(201);
    expect((await add(entry('gmail'))).status).toBe(409);
    expect((await add(entry('weather', { authType: 'none', authConfig: null }))).status).toBe(201);
  });

  it('shows a super admin the list without any sign-in, and stores the sign-in encrypted', async () => {
    await add(entry('gmail'));
    asBoss();
    const listed = await (await adminList(request('/api/admin/app-catalog'))).json();
    expect(JSON.stringify(listed)).not.toMatch(/platform-secret|platform-client|authConfig/);
    expect(listed.apps.find((app: { key: string }) => app.key === key('gmail'))).toMatchObject({ name: 'GMAIL', enabled: true });
    const stored = await prisma.appCatalogEntry.findUniqueOrThrow({ where: { key: key('gmail') } });
    expect(stored.authConfig).not.toContain('platform-secret');
    expect(JSON.parse(decryptApiKey(stored.authConfig!))).toMatchObject({ clientSecret: 'platform-secret' });
  });

  it('shows a person only what they may know, narrowed by what they type, and not the apps that are off', async () => {
    await add(entry('gmail', { blurb: 'Read, draft and send email' }));
    await add(entry('notion', { blurb: 'Notes and docs' }));
    await add(entry('slack', { enabled: false }));
    mockUser.current = { id: sara };
    const all = await (await catalog(request('/api/me/apps/catalog'))).json();
    const mine = (apps: { key: string }[]) => apps.filter((app) => app.key.endsWith(tag)).map((app) => app.key).sort();
    expect(mine(all.apps)).toEqual([key('gmail'), key('notion')].sort());
    expect(JSON.stringify(all)).not.toMatch(/platform|authConfig|serverUrl|example\.com/);
    // Only the name, what it does, its icon and whether they have it: nothing else of an entry ever reaches a person
    for (const app of all.apps) expect(Object.keys(app).sort()).toEqual(['blurb', 'connectionId', 'icon', 'key', 'name']);
    const found = await (await catalog(request('/api/me/apps/catalog?q=DOCS'))).json();
    expect(mine(found.apps)).toEqual([key('notion')]);
    const byLine = await (await catalog(request('/api/me/apps/catalog?q=send%20email'))).json();
    expect(mine(byLine.apps)).toEqual([key('gmail')]);
    mockUser.current = null;
    expect((await catalog(request('/api/me/apps/catalog'))).status).toBe(401);
  });

  it('connects a listed app for the person only, once, with no Brick using it yet', async () => {
    await add(entry('gmail'));
    mockUser.current = { id: sara };
    const first = await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }));
    expect(first.status).toBe(201);
    const { id } = await first.json();
    const connection = await prisma.appConnection.findUniqueOrThrow({ where: { id } });
    expect(connection).toMatchObject({ ownerId: sara, name: 'GMAIL', source: 'listed', catalogKey: key('gmail'), authType: 'oauth', serverUrl: 'https://gmail.example.com/mcp' });
    expect(JSON.parse(decryptApiKey(connection.authConfig!))).toMatchObject({ clientId: 'platform-client' });
    expect(await prisma.botMcpServer.count({ where: { connectionId: id } })).toBe(0);
    // twice is the same connection; both at once too
    const again = await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }));
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(id);
    expect(await prisma.appConnection.count({ where: { ownerId: sara, catalogKey: key('gmail') } })).toBe(1);
    // the list now says Connected for them, and not for anyone else
    const mine = await (await catalog(request('/api/me/apps/catalog'))).json();
    expect(mine.apps.find((app: { key: string }) => app.key === key('gmail')).connectionId).toBe(id);
    mockUser.current = { id: omar };
    const theirs = await (await catalog(request('/api/me/apps/catalog'))).json();
    expect(theirs.apps.find((app: { key: string }) => app.key === key('gmail')).connectionId).toBeNull();
    expect(JSON.stringify(await (await myApps(request('/api/me/apps'))).json())).not.toContain(id);
  });

  it('makes one connection when two taps come at once', async () => {
    await add(entry('gmail'));
    mockUser.current = { id: sara };
    const taps = await Promise.all([1, 2, 3].map(() => connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }))));
    expect(taps.map((tap) => tap.status).sort()).toEqual([200, 200, 201]);
    expect(await prisma.appConnection.count({ where: { ownerId: sara, catalogKey: key('gmail') } })).toBe(1);
  });

  it('answers an app that is not on the list, or is off, like one that does not exist', async () => {
    await add(entry('slack', { enabled: false }));
    mockUser.current = { id: sara };
    const off = await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('slack') } }));
    const nothing = await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('nothing') } }));
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual(await nothing.json());
    expect((await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: 5 } }))).status).toBe(400);
  });

  it('turns an app off for new taps without taking it from people who have it, and removing it from the list keeps their connections', async () => {
    const created = await (await add(entry('gmail'))).json();
    mockUser.current = { id: sara };
    const { id } = await (await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }))).json();
    asBoss();
    const off = await adminChange(request(`/api/admin/app-catalog/${created.app.id}`, { method: 'PATCH', body: { enabled: false } }), params({ id: created.app.id }));
    expect((await off.json()).app.enabled).toBe(false);
    expect(await prisma.appConnection.count({ where: { id } })).toBe(1);
    mockUser.current = { id: omar };
    expect((await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }))).status).toBe(404);
    asBoss();
    expect((await adminChange(request(`/api/admin/app-catalog/${created.app.id}`, { method: 'PATCH', body: { serverUrl: 'https://evil.example.com' } }), params({ id: created.app.id }))).status).toBe(400);
    expect((await adminRemove(request(`/api/admin/app-catalog/${created.app.id}`, { method: 'DELETE' }), params({ id: created.app.id }))).status).toBe(204);
    expect((await adminRemove(request(`/api/admin/app-catalog/${created.app.id}`, { method: 'DELETE' }), params({ id: created.app.id }))).status).toBe(404);
    expect(await prisma.appConnection.count({ where: { id } })).toBe(1);
  });

  it('lets go of the key when an entry is removed, so a new entry with the same key is a different app for everyone', async () => {
    const first = await (await add(entry('gmail'))).json();
    mockUser.current = { id: sara };
    const { id } = await (await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }))).json();
    asBoss();
    expect((await adminRemove(request(`/api/admin/app-catalog/${first.app.id}`, { method: 'DELETE' }), params({ id: first.app.id }))).status).toBe(204);
    // Theirs, still working, no longer tied to the entry
    expect(await prisma.appConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({ ownerId: sara, catalogKey: null, source: 'listed' });
    // A new entry with the same key: not connected yet, and Connect makes a second, new connection
    expect((await add(entry('gmail', { serverUrl: 'https://gmail-new.example.com/mcp' }))).status).toBe(201);
    mockUser.current = { id: sara };
    const rows = (await (await catalog(request(`/api/me/apps/catalog?q=${key('gmail')}`))).json()).apps as { key: string; connectionId: string | null }[];
    expect(rows.find((row) => row.key === key('gmail'))?.connectionId).toBeNull();
    const second = await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }));
    expect(second.status).toBe(201);
    const secondId = (await second.json()).id as string;
    expect(secondId).not.toBe(id);
    expect(await prisma.appConnection.findUniqueOrThrow({ where: { id: secondId } })).toMatchObject({ catalogKey: key('gmail'), serverUrl: 'https://gmail-new.example.com/mcp' });
    expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(2);
  });

  it('never leaves a connection holding the key of an entry that was removed at the same moment', async () => {
    for (let round = 0; round < 6; round += 1) {
      const name = `race${round}`;
      const created = await (await add(entry(name))).json();
      const taps = [sara, omar].map((id) => {
        mockUser.current = { id };
        return connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key(name) } }));
      });
      asBoss();
      const removing = adminRemove(request(`/api/admin/app-catalog/${created.app.id}`, { method: 'DELETE' }), params({ id: created.app.id }));
      await Promise.all([...taps, removing]);
      expect(await prisma.appConnection.count({ where: { catalogKey: key(name) } })).toBe(0);
      expect(await prisma.appCatalogEntry.count({ where: { key: key(name) } })).toBe(0);
    }
  });

  it('lets a person disconnect a listed app, which then shows as not connected and can be connected again', async () => {
    await add(entry('gmail'));
    mockUser.current = { id: sara };
    const { id } = await (await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }))).json();
    expect(await grantToBrick(sara, id, saraBrick)).not.toBeNull();
    expect((await disconnectApp(request(`/api/me/apps/${id}`, { method: 'DELETE' }), params({ connectionId: id }))).status).toBe(204);
    const list = await (await catalog(request('/api/me/apps/catalog'))).json();
    expect(list.apps.find((app: { key: string }) => app.key === key('gmail')).connectionId).toBeNull();
    expect((await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }))).status).toBe(201);
  });

  it('asks the app to take the sign-in back when it said where, after the Bricks have stopped, and never fails the disconnect', async () => {
    await add(entry('gmail', { authConfig: JSON.stringify({ clientId: 'platform-client', authorizeUrl: 'https://accounts.example.com/auth', tokenUrl: 'https://accounts.example.com/token', revocationUrl: 'https://accounts.example.com/revoke' }) }));
    mockUser.current = { id: sara };
    const { id } = await (await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }))).json();
    // the person signed in: tokens are stored with the sign-in
    const stored = JSON.parse(decryptApiKey((await prisma.appConnection.findUniqueOrThrow({ where: { id } })).authConfig!));
    const { encryptApiKey } = await import('@/lib/encryption');
    await prisma.appConnection.update({ where: { id }, data: { authConfig: encryptApiKey(JSON.stringify({ ...stored, accessToken: 'a', refreshToken: 'r' })) } });
    const seen: string[] = [];
    const before = global.fetch;
    global.fetch = jest.fn(async (address: string | URL | Request) => { seen.push(String(address)); throw new Error('the app is down'); }) as unknown as typeof fetch;
    try {
      expect(await disconnect(sara, id)).toBe(true);
    } finally {
      global.fetch = before;
    }
    expect(seen).toEqual(['https://accounts.example.com/revoke']);
    expect(await prisma.appConnection.count({ where: { id } })).toBe(0);
  });

  describe('what a Brick may offer its owner (GET /api/bots/:id/apps/offerable)', () => {
    const SERVICE = `service-${tag}`;
    const serviceBefore = process.env.BOT_SERVICE_TOKEN;
    beforeAll(() => { process.env.BOT_SERVICE_TOKEN = SERVICE; });
    afterAll(() => { if (serviceBefore === undefined) delete process.env.BOT_SERVICE_TOKEN; else process.env.BOT_SERVICE_TOKEN = serviceBefore; });
    const ask = (botId: string, userId: string | null, token: string | null = SERVICE) =>
      offerable(new NextRequest(`http://localhost/api/bots/${botId}/apps/offerable${userId === null ? '' : `?userId=${encodeURIComponent(userId)}`}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), params({ id: botId }));
    const mine = (apps: { key: string }[]) => apps.filter((app) => app.key.endsWith(tag));

    it('lists every app that is on, with the owner’s own connection, whether it works and whether this Brick uses it, and nothing of the link or sign-in', async () => {
      await add(entry('gmail'));
      await add(entry('notion'));
      await add(entry('weather', { authType: 'none', authConfig: null }));
      await add(entry('slack', { enabled: false }));
      mockUser.current = { id: sara };
      const gmail = await (await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('gmail') } }))).json();
      await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: key('weather') } }));
      mockUser.current = null;

      const first = await (await ask(saraBrick, `sara-${tag}`)).json();
      expect(mine(first.apps).map((app: { key: string }) => app.key).sort()).toEqual([key('gmail'), key('notion'), key('weather')].sort());
      const row = (apps: { key: string }[], name: string) => apps.find((app) => app.key === key(name));
      // Connected from the list but the sign-in not done: it is there, and it does not work yet
      expect(row(first.apps, 'gmail')).toMatchObject({ connectionId: gmail.id, connected: false, usable: false });
      expect(row(first.apps, 'notion')).toMatchObject({ connectionId: null, connected: false, usable: false });
      // An app that needs no sign-in works as soon as it is connected
      expect(row(first.apps, 'weather')).toMatchObject({ connected: true, usable: false });
      expect(JSON.stringify(first)).not.toMatch(/platform|authConfig|serverUrl|example\.com/);
      for (const app of first.apps) expect(Object.keys(app).sort()).toEqual(['blurb', 'connected', 'connectionId', 'key', 'name', 'usable']);

      // They signed in, and the Brick was let use it
      const signedIn = JSON.parse(decryptApiKey((await prisma.appConnection.findUniqueOrThrow({ where: { id: gmail.id } })).authConfig!));
      await prisma.appConnection.update({ where: { id: gmail.id }, data: { authConfig: encryptApiKey(JSON.stringify({ ...signedIn, accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor(Date.now() / 1000) + 3600 })) } });
      expect(row((await (await ask(saraBrick, `sara-${tag}`)).json()).apps, 'gmail')).toMatchObject({ connected: true, usable: false });
      await grantToBrick(sara, gmail.id, saraBrick);
      expect(row((await (await ask(saraBrick, `sara-${tag}`)).json()).apps, 'gmail')).toMatchObject({ connected: true, usable: true });
    });

    it('is for the service token and the Brick’s owner only: anyone else, and a room bot, is told it does not exist', async () => {
      await add(entry('gmail'));
      expect((await ask(saraBrick, `sara-${tag}`, null)).status).toBe(401);
      expect((await ask(saraBrick, `sara-${tag}`, 'wrong')).status).toBe(401);
      expect((await ask(saraBrick, null)).status).toBe(400);
      expect((await ask(saraBrick, `omar-${tag}`)).status).toBe(404);
      expect((await ask(saraBrick, 'nobody-at-all')).status).toBe(404);
      expect((await ask('no-such-brick', `sara-${tag}`)).status).toBe(404);
      const universe = await prisma.universe.create({ data: { slug: `o-${tag}`, name: 'Offer test', ownerId: sara } });
      try {
        const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
        const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
        const roomBot = await prisma.bot.create({ data: { roomId: room.id, name: 'Room bot', createdById: sara, behaviorConfig: {} } });
        expect((await ask(roomBot.id, `sara-${tag}`)).status).toBe(404);
      } finally {
        await prisma.universe.delete({ where: { id: universe.id } });
      }
    });
  });
});
