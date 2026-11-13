/**
 * Ready-made apps through the adapter (game #2001, step 8), against a real database and a FAKE adapter. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database. The real adapter is never called.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));

import { prisma } from '@/lib/db';
import { setAdapterForTests, type LinkAnswer, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { confirmReadyMade } from '@/lib/app-adapter/confirm';
import { saveReadyMadeApps } from '@/lib/app-adapter/settings';
import { GET as listReadyMade, POST as connectReadyMadeApp } from '@/app/api/me/apps/ready-made/route';
import { GET as adminGet, PUT as adminPut } from '@/app/api/admin/ready-made-apps/route';
import { GET as listServers } from '@/app/api/bots/[id]/mcp-servers/route';
import { POST as useApp } from '@/app/api/ready-made/use/route';
import { POST as linkApp } from '@/app/api/ready-made/link/route';
import { POST as testServer } from '@/app/api/bots/[id]/mcp-servers/[serverId]/test/route';
import { POST as useCheck } from '@/app/api/bots/[id]/mcp-servers/[serverId]/use/route';
import { POST as connectApp } from '@/app/api/me/apps/route';
import { grantToBrick, createConnection, readConnection, listConnections } from '@/lib/app-connections';
import { saveMeterSettings } from '@/lib/meter';
import { createBrick } from '@/lib/brick-create';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const KEY = `gmail-${tag}`;
const SERVICE_TOKEN = `service-${tag}`;
const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let sara = '';
let omar = '';
let boss = '';
let saraBrick = '';
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, key: process.env.ENCRYPTION_KEY };

const fake = () => {
  const adapter = {
    startConnect: jest.fn(async () => ({ redirectUrl: 'https://connect.example/sign-in', providerAccountId: `ca_${tag}`, expiresAt: null })),
    connectionStatus: jest.fn(async (): Promise<'active' | 'pending' | 'failed'> => 'active'),
    appLink: jest.fn(async () => ({ url: `https://mcp.example/${tag}/mcp` })),
    callLink: jest.fn(async (_input: { url: string; message: Record<string, unknown>; sessionId: string | null }): Promise<LinkAnswer> => ({ status: 200, contentType: 'application/json', sessionId: 'mcp-1', body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' })),
    use: jest.fn(async () => ({ ok: true, data: { free: ['10:00'] }, error: null, providerCallId: 'log_1' })),
  } satisfies ReadyMadeAdapter;
  return adapter;
};

run('ready-made apps through the adapter, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string, email?: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: email ?? `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    boss = (await person('boss', 'boss@example.test')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
  });
  afterEach(async () => {
    setAdapterForTests(undefined);
    mockUser.current = null;
    await prisma.meterEvent.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appSetting.deleteMany({ where: { key: 'ready-made-apps' } });
  });
  afterAll(async () => {
    if (envBefore.service === undefined) delete process.env.BOT_SERVICE_TOKEN; else process.env.BOT_SERVICE_TOKEN = envBefore.service;
    if (envBefore.key === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = envBefore.key;
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, boss] } } });
    await prisma.$disconnect();
  });

  const list = () => saveReadyMadeApps({ apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1', enabled: true } } }, boss);
  const asSara = () => (mockUser.current = { id: sara, email: `sara-${tag}@example.test` });
  const connect = () => connectReadyMadeApp(request('/api/me/apps/ready-made', { method: 'POST', body: { key: KEY } }));
  const useIt = (extra: Record<string, unknown> = {}) =>
    useApp(request('/api/ready-made/use', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId: 'whatever', requesterKey: `sara-${tag}`, tool: 'GMAIL_FETCH_EMAILS', arguments: { n: 1 }, callId: `call-${randomUUID()}`, ...extra } }));

  async function connectedAndGranted() {
    const adapter = fake();
    setAdapterForTests(adapter);
    await list();
    asSara();
    const made = await (await connect()).json();
    const grant = await grantToBrick(sara, made.id, saraBrick);
    return { adapter, connectionId: made.id as string, serverId: (grant as { id: string }).id };
  }

  it('is not there at all while the adapter is off: the same answer as a route that does not exist', async () => {
    setAdapterForTests(null);
    await list();
    asSara();
    const response = await connect();
    expect(response.status).toBe(404);
    expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(0);
    mockUser.current = { id: boss, email: 'boss@example.test' };
    expect((await adminGet(request('/api/admin/ready-made-apps'))).status).toBe(404);
    expect((await adminPut(request('/api/admin/ready-made-apps', { method: 'PUT', body: { apps: {} } }))).status).toBe(404);
    expect((await useIt()).status).toBe(404);
  });

  it('opens one account at the provider when the same person taps connect twice at the same moment', async () => {
    const adapter = fake();
    // A slow provider, so both taps are in flight at once
    adapter.startConnect.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { redirectUrl: 'https://connect.example/sign-in', providerAccountId: `ca_${tag}`, expiresAt: null };
    });
    setAdapterForTests(adapter);
    await list();
    asSara();
    const [one, two] = await Promise.all([connect(), connect()]);
    const bodies = [await one.json(), await two.json()];
    expect([one.status, two.status].sort()).toEqual([200, 201]);
    expect(bodies[0].id).toBe(bodies[1].id);
    expect(adapter.startConnect).toHaveBeenCalledTimes(1);
    expect(await prisma.appConnection.count({ where: { ownerId: sara, providerToolkit: KEY } })).toBe(1);
  });

  it('keeps its list for a super admin only, when on', async () => {
    setAdapterForTests(fake());
    asSara();
    expect((await adminGet(request('/api/admin/ready-made-apps'))).status).toBe(403);
    mockUser.current = { id: boss, email: 'boss@example.test' };
    const put = await adminPut(request('/api/admin/ready-made-apps', { method: 'PUT', body: { apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1' } } } }));
    expect(put.status).toBe(200);
    const apps = (await (await adminGet(request('/api/admin/ready-made-apps'))).json()).apps as { key: string }[];
    expect(apps.find((app) => app.key === KEY)).toEqual({ key: KEY, name: 'Gmail', authConfigId: 'ac_1', enabled: true });
    // The built-in apps are there with nothing set, each on and with the provider's own sign-in setup
    expect(apps.find((app) => app.key === 'gmail')).toEqual({ key: 'gmail', name: 'Gmail', authConfigId: null, enabled: true });
    const bad = await adminPut(request('/api/admin/ready-made-apps', { method: 'PUT', body: { apps: { 'Not A Key': { name: 'x', authConfigId: 'y' } } } }));
    expect(bad.status).toBe(400);
  });

  it('connects once, as the person’s own connection with their own link, and shows the provider’s sign-in page', async () => {
    const adapter = fake();
    setAdapterForTests(adapter);
    await list();
    asSara();
    const first = await connect();
    const body = await first.json();
    expect(first.status).toBe(201);
    expect(body.redirectUrl).toBe('https://connect.example/sign-in');
    expect(adapter.startConnect).toHaveBeenCalledWith({ person: sara, toolkit: KEY, returnUrl: expect.stringContaining('/admin/apps') });
    // The link is pinned to the account the person is signing in with
    expect(adapter.appLink).toHaveBeenCalledWith({ person: sara, toolkits: [KEY], accounts: { [KEY]: `ca_${tag}` } });
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({ ownerId: sara, source: 'ready_made', providerToolkit: KEY, serverUrl: `https://mcp.example/${tag}/mcp`, authConfig: null, authType: 'none', headers: null });

    const again = await connect();
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(body.id);
    expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(1);
    expect(adapter.startConnect).toHaveBeenCalledTimes(1);
  });

  it('does not read as connected until the provider says the sign-in finished, and a repeat tap starts it again', async () => {
    const adapter = fake();
    adapter.connectionStatus.mockResolvedValue('pending');
    adapter.startConnect
      .mockResolvedValueOnce({ redirectUrl: 'https://connect.example/first', providerAccountId: `ca_first_${tag}`, expiresAt: null })
      .mockResolvedValueOnce({ redirectUrl: 'https://connect.example/second', providerAccountId: `ca_second_${tag}`, expiresAt: null });
    adapter.appLink
      .mockResolvedValueOnce({ url: `https://mcp.example/${tag}/first` })
      .mockResolvedValueOnce({ url: `https://mcp.example/${tag}/second` });
    setAdapterForTests(adapter);
    await list();
    asSara();
    const first = await (await connect()).json();
    expect(first.redirectUrl).toBe('https://connect.example/first');
    expect((await readConnection(first.id, sara))?.connected).toBe(false);

    // The person closed the provider's page: tapping Connect again gives a page that works, for the same connection
    const again = await connect();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: first.id, redirectUrl: 'https://connect.example/second' });
    expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(1);
    const replaced = await prisma.appConnection.findUniqueOrThrow({ where: { id: first.id } });
    expect(replaced.providerAccountId).toBe(`ca_second_${tag}`);
    // The link is made again for the new account, never left reaching the older one, and the replaced sign-in cannot be marked lost by an earlier report
    expect(adapter.appLink).toHaveBeenCalledTimes(2);
    expect(adapter.appLink).toHaveBeenLastCalledWith({ person: sara, toolkits: [KEY], accounts: { [KEY]: `ca_second_${tag}` } });
    expect(replaced.serverUrl).toBe(`https://mcp.example/${tag}/second`);
    expect(replaced.reconnectedAt).not.toBeNull();

    // They finished it this time: it reads connected, once and for good, and a tap no longer starts a sign-in
    adapter.connectionStatus.mockResolvedValue('active');
    expect((await listConnections(sara))[0].connected).toBe(true);
    expect(adapter.connectionStatus).toHaveBeenLastCalledWith({ providerAccountId: `ca_second_${tag}` });
    const after = await connect();
    expect(await after.json()).toEqual({ id: first.id });
    expect(adapter.startConnect).toHaveBeenCalledTimes(2);
  });

  it('two overlapping confirmations of one sign-in both read connected, and one for a replaced sign-in does not', async () => {
    const adapter = fake();
    setAdapterForTests(adapter);
    await list();
    asSara();
    const made = await (await connect()).json();
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: made.id } });
    await prisma.appConnection.update({ where: { id: made.id }, data: { providerConfirmedAt: null } });
    const stale = { id: row.id, source: row.source, providerAccountId: row.providerAccountId, providerConfirmedAt: null };
    const [a, b] = await Promise.all([confirmReadyMade(stale), confirmReadyMade(stale)]);
    expect(a).toBeInstanceOf(Date);
    expect(b).toBeInstanceOf(Date);

    // A newer sign-in replaced the account in the meantime: the old answer is not about it
    await prisma.appConnection.update({ where: { id: made.id }, data: { providerConfirmedAt: null, providerAccountId: `ca_newer_${tag}` } });
    expect(await confirmReadyMade(stale)).toBeNull();
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: made.id } })).providerConfirmedAt).toBeNull();
  });

  it('is not used, and nothing is counted, while the sign-in is not finished or the provider cannot be asked', async () => {
    const adapter = fake();
    adapter.connectionStatus.mockResolvedValue('pending');
    setAdapterForTests(adapter);
    await list();
    asSara();
    const made = await (await connect()).json();
    const grant = (await grantToBrick(sara, made.id, saraBrick)) as { id: string };
    expect((await useIt({ serverId: grant.id })).status).toBe(502);
    adapter.connectionStatus.mockRejectedValue(new Error('down'));
    expect((await useIt({ serverId: grant.id })).status).toBe(502);
    expect(adapter.use).not.toHaveBeenCalled();
    expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(0);
    expect((await readConnection(made.id, sara))?.connected).toBe(false);
  });

  it('works with nothing saved: a built-in app connects, and the person sees the list with their own connection marked', async () => {
    const adapter = fake();
    setAdapterForTests(adapter);
    asSara();
    const before = (await (await listReadyMade(request('/api/me/apps/ready-made'))).json()).apps as { key: string; name: string; connectionId: string | null }[];
    expect(before.find((app) => app.key === 'gmail')).toEqual({ key: 'gmail', name: 'Gmail', connectionId: null });
    expect(Object.keys(before[0]).sort()).toEqual(['connectionId', 'key', 'name']);
    const made = await (await connectReadyMadeApp(request('/api/me/apps/ready-made', { method: 'POST', body: { key: 'gmail' } }))).json();
    expect(made.redirectUrl).toBeDefined();
    const after = (await (await listReadyMade(request('/api/me/apps/ready-made'))).json()).apps as { key: string; connectionId: string | null }[];
    expect(after.find((app) => app.key === 'gmail')?.connectionId).toBe(made.id);
    // Off with no key: the list is not there either
    setAdapterForTests(null);
    expect((await listReadyMade(request('/api/me/apps/ready-made'))).status).toBe(404);
  });

  it('a super admin can turn a built-in app off and back to its built-in form, never has to', async () => {
    setAdapterForTests(fake());
    await saveReadyMadeApps({ apps: { gmail: { enabled: false } } }, boss);
    asSara();
    expect((await connectReadyMadeApp(request('/api/me/apps/ready-made', { method: 'POST', body: { key: 'gmail' } }))).status).toBe(404);
    await saveReadyMadeApps({ apps: { gmail: null } }, boss);
    expect((await connectReadyMadeApp(request('/api/me/apps/ready-made', { method: 'POST', body: { key: 'gmail' } }))).status).toBe(201);
  });

  it('restarts a sign-in that was lost after it had been confirmed, and reads connected again only when the provider confirms the new one', async () => {
    const adapter = fake();
    adapter.startConnect
      .mockResolvedValueOnce({ redirectUrl: 'https://connect.example/one', providerAccountId: `ca_one_${tag}`, expiresAt: null })
      .mockResolvedValueOnce({ redirectUrl: 'https://connect.example/two', providerAccountId: `ca_two_${tag}`, expiresAt: null });
    setAdapterForTests(adapter);
    await list();
    asSara();
    const first = await (await connect()).json();
    expect((await listConnections(sara))[0].connected).toBe(true);
    await prisma.appConnection.update({ where: { id: first.id }, data: { signInLostAt: new Date(), signInLostStatus: 401 } });
    expect((await readConnection(first.id, sara))?.connected).toBe(false);
    adapter.connectionStatus.mockResolvedValue('pending');
    const again = await (await connect()).json();
    expect(again).toEqual({ id: first.id, redirectUrl: 'https://connect.example/two' });
    expect(await prisma.appConnection.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ providerAccountId: `ca_two_${tag}`, providerConfirmedAt: null, signInLostAt: null, signInLostStatus: null });
    expect((await readConnection(first.id, sara))?.connected).toBe(false);
    adapter.connectionStatus.mockResolvedValue('active');
    expect((await readConnection(first.id, sara))?.connected).toBe(true);
  });

  it('never stores the provider key, even when the provider’s session answer carries headers, and shows it nowhere', async () => {
    const adapter = fake();
    // A provider that sends the key back in the link's headers (the adapter drops them; a fake that returned them would still be ignored)
    adapter.appLink.mockResolvedValue({ url: `https://mcp.example/${tag}/mcp`, headers: { 'x-api-key': 'the-provider-key' } } as never);
    setAdapterForTests(adapter);
    await list();
    asSara();
    const made = await (await connect()).json();
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.headers).toBeNull();
    expect(row.authType).toBe('none');
    expect(JSON.stringify(row)).not.toContain('the-provider-key');
    const grant = (await grantToBrick(sara, made.id, saraBrick)) as { id: string };
    expect(JSON.stringify(await prisma.botMcpServer.findUniqueOrThrow({ where: { id: grant.id } }))).not.toContain('the-provider-key');
    expect(JSON.stringify(await listConnections(sara))).not.toContain('the-provider-key');
  });

  it('refuses an app that is not on the list or is turned off', async () => {
    setAdapterForTests(fake());
    asSara();
    expect((await connect()).status).toBe(404);
    await saveReadyMadeApps({ apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1', enabled: false } } }, boss);
    expect((await connect()).status).toBe(404);
  });

  it('never lets a person make a ready-made connection by themselves through the link route', async () => {
    asSara();
    const response = await connectApp(request('/api/me/apps', { method: 'POST', body: { name: 'Mine', serverUrl: 'https://apps.example.com/mcp', authType: 'none', source: 'ready_made' } }));
    expect(response.status).toBeLessThan(500);
    expect(await prisma.appConnection.count({ where: { ownerId: sara, source: 'ready_made' } })).toBe(0);
  });

  it('says on the use check that the universe pays for a ready-made app, and not for a person’s own', async () => {
    const { serverId } = await connectedAndGranted();
    const verdict = await (await useCheck(request(`/api/bots/${saraBrick}/mcp-servers/${serverId}/use`, { method: 'POST', token: SERVICE_TOKEN, body: { requesterKey: `sara-${tag}` } }), params({ id: saraBrick, serverId }))).json();
    expect(verdict).toMatchObject({ allowed: true, readyMade: true });
    const own = await createConnection(sara, { name: 'Own', serverUrl: 'https://own.example.com/mcp', authType: 'none', source: 'link' });
    const ownGrant = await grantToBrick(sara, own.id, saraBrick);
    const ownVerdict = await (await useCheck(request(`/api/bots/${saraBrick}/mcp-servers/${(ownGrant as { id: string }).id}/use`, { method: 'POST', token: SERVICE_TOKEN, body: { requesterKey: `sara-${tag}` } }), params({ id: saraBrick, serverId: (ownGrant as { id: string }).id }))).json();
    expect(ownVerdict.allowed).toBe(true);
    expect(ownVerdict.readyMade).toBeUndefined();
  });

  it('writes the meter before the provider is called, once for each call id, paid by the universe, at the built-in estimate while no price is saved', async () => {
    const { adapter, serverId } = await connectedAndGranted();
    let writtenWhenCalled = 0;
    adapter.use.mockImplementationOnce(async () => {
      writtenWhenCalled = await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } });
      return { ok: true, data: { free: ['10:00'] }, error: null, providerCallId: 'log_1' };
    });
    const callId = `call-${randomUUID()}`;
    const response = await useIt({ serverId, callId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { free: ['10:00'] } });
    expect(writtenWhenCalled).toBe(1);
    const events = await prisma.meterEvent.findMany({ where: { personId: sara, kind: 'app_use' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: `app:${saraBrick}:${callId}`, payerKind: 'universe', route: 'app', unit: 'use', basis: 'estimated', costMicros: BigInt(5000), botId: saraBrick });
    expect(events[0].detail).toEqual({ toolkit: KEY, tool: 'GMAIL_FETCH_EMAILS' });
  });

  it('writes an estimate from the super admin’s own price once there is one', async () => {
    const { serverId } = await connectedAndGranted();
    // The meter setting is shared with other suites: put back what was there, never delete it
    const before = await prisma.appSetting.findUnique({ where: { key: 'meter' } });
    try {
      await saveMeterSettings({ appUseMicros: 2500 }, boss);
      expect((await useIt({ serverId })).status).toBe(200);
      const event = await prisma.meterEvent.findFirstOrThrow({ where: { personId: sara, kind: 'app_use' } });
      expect(event).toMatchObject({ basis: 'estimated', costMicros: BigInt(2500) });
    } finally {
      if (before) await prisma.appSetting.update({ where: { key: 'meter' }, data: { value: before.value as never } });
      else await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
    }
  });


  it('never runs one call id twice: a retry is told it was already asked, and the meter has one event', async () => {
    const { adapter, serverId } = await connectedAndGranted();
    const callId = `call-${randomUUID()}`;
    expect((await useIt({ serverId, callId })).status).toBe(200);
    const retry = await useIt({ serverId, callId });
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe('already_asked');
    expect(adapter.use).toHaveBeenCalledTimes(1);
    expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(1);
  });

  it('counts the same call id from two different Bricks as two calls', async () => {
    const { adapter, serverId } = await connectedAndGranted();
    const other = (await createBrick({ ownerId: sara, name: 'Second Brick' })).id;
    await grantToBrick(sara, (await prisma.appConnection.findFirstOrThrow({ where: { ownerId: sara } })).id, other);
    const otherServer = (await prisma.botMcpServer.findFirstOrThrow({ where: { botId: other } })).id;
    expect((await useIt({ serverId, callId: 'shared-id' })).status).toBe(200);
    expect((await useIt({ botId: other, serverId: otherServer, callId: 'shared-id' })).status).toBe(200);
    expect(adapter.use).toHaveBeenCalledTimes(2);
    expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(2);
    // And a retry from the same Brick is still the same call
    expect((await useIt({ serverId, callId: 'shared-id' })).status).toBe(409);
    expect(adapter.use).toHaveBeenCalledTimes(2);
  });

  it('a provider that is down is "could not be reached", the use is still on the books, and nothing is hidden as free', async () => {
    const { adapter, serverId } = await connectedAndGranted();
    adapter.use.mockRejectedValueOnce(new Error('down'));
    const response = await useIt({ serverId });
    expect(response.status).toBe(502);
    expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(1);
  });

  it('is only for the person whose app it is', async () => {
    const { adapter, serverId } = await connectedAndGranted();
    const stranger = await useIt({ serverId, requesterKey: `omar-${tag}` });
    expect(stranger.status).toBe(403);
    expect((await useIt({ serverId, requesterKey: undefined })).status).toBe(403);
    expect(adapter.use).not.toHaveBeenCalled();
    expect(await prisma.meterEvent.count({ where: { personId: { in: [sara, omar] }, kind: 'app_use' } })).toBe(0);
  });

  it('stops at once when the Brick no longer has it or the person disconnected it', async () => {
    const { adapter, connectionId, serverId } = await connectedAndGranted();
    await prisma.appConnection.delete({ where: { id: connectionId } });
    expect((await useIt({ serverId })).status).toBe(404);
    expect(adapter.use).not.toHaveBeenCalled();
  });

  it('turning an app off stops every use of it at once, connections and Bricks that already have it included, and nothing is counted', async () => {
    const { adapter, serverId } = await connectedAndGranted();
    const metered = () => prisma.meterEvent.count({ where: { personId: sara } });
    const link = () => linkApp(request('/api/ready-made/link', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } }));
    const test = () => { asSara(); return testServer(request(`/api/bots/${saraBrick}/mcp-servers/${serverId}/test`, { method: 'POST' }), params({ id: saraBrick, serverId })); };
    expect((await useIt({ serverId })).status).toBe(200);
    const before = await metered();

    await saveReadyMadeApps({ apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1', enabled: false } } }, boss);
    adapter.use.mockClear();
    adapter.callLink.mockClear();
    expect((await useIt({ serverId })).status).toBe(404);
    expect((await link()).status).toBe(404);
    const tested = await (await test()).json();
    expect(tested.success).toBe(false);
    expect(adapter.use).not.toHaveBeenCalled();
    expect(adapter.callLink).not.toHaveBeenCalled();
    expect(await metered()).toBe(before);

    // Turned on again, the same connection works as before
    await saveReadyMadeApps({ apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1', enabled: true } } }, boss);
    expect((await useIt({ serverId })).status).toBe(200);
    expect((await link()).status).toBe(200);
  });

  describe('the app link, which only Orbit may call because it needs the provider key', () => {
    const link = (serverId: string, extra: Record<string, unknown> = {}) =>
      linkApp(request('/api/ready-made/link', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ...extra } }));

    it('sends a listing through, with the link’s own address, and hands back what it said and its session id', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      const response = await link(serverId, { sessionId: 'earlier' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 200, contentType: 'application/json', sessionId: 'mcp-1', body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' });
      expect(adapter.callLink).toHaveBeenCalledWith({ url: `https://mcp.example/${tag}/mcp`, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, sessionId: 'earlier' });
      // A listing is not a use
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(0);
    });

    it('counts a tool run through the link like a use, once for each call id, and needs a call id', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      const message = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'COMPOSIO_REMOTE_WORKBENCH', arguments: { code: 'secret code' } } };
      expect((await link(serverId, { message })).status).toBe(400);
      expect(adapter.callLink).not.toHaveBeenCalled();
      const callId = `call-${randomUUID()}`;
      expect((await link(serverId, { message, callId })).status).toBe(200);
      const retry = await link(serverId, { message, callId });
      expect(retry.status).toBe(409);
      expect(adapter.callLink).toHaveBeenCalledTimes(1);
      const events = await prisma.meterEvent.findMany({ where: { personId: sara, kind: 'app_use' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventId: `app:${saraBrick}:${callId}`, basis: 'estimated', payerKind: 'universe' });
      // What was asked is not written down: only which app and which tool
      expect(JSON.stringify(events[0].detail)).not.toContain('secret code');
    });

    it('passes on nothing but the messages of a session, listing and running', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      for (const method of ['resources/read', 'prompts/get', 'sampling/createMessage', '']) {
        expect((await link(serverId, { message: { jsonrpc: '2.0', id: 3, method } })).status).toBe(400);
      }
      expect(adapter.callLink).not.toHaveBeenCalled();
    });

    it('is only for the person whose app it is, and only once they are signed in, and not at all while the adapter is off', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      expect((await link(serverId, { requesterKey: `omar-${tag}` })).status).toBe(403);
      expect((await link(serverId, { requesterKey: undefined })).status).toBe(403);
      adapter.connectionStatus.mockResolvedValue('pending');
      await prisma.appConnection.updateMany({ where: { ownerId: sara }, data: { providerConfirmedAt: null } });
      expect((await link(serverId)).status).toBe(502);
      expect(adapter.callLink).not.toHaveBeenCalled();
      setAdapterForTests(null);
      expect((await link(serverId)).status).toBe(404);
    });

    it('is a 502 and not a leak when the link cannot be reached', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      adapter.callLink.mockRejectedValueOnce(new Error('down'));
      expect((await link(serverId)).status).toBe(502);
    });
  });

  describe('"Test" on a ready-made app, which has to go through Orbit because the link needs the provider key', () => {
    const test = (serverId: string) => {
      asSara();
      return testServer(request(`/api/bots/${saraBrick}/mcp-servers/${serverId}/test`, { method: 'POST' }), params({ id: saraBrick, serverId }));
    };
    const answerOf = (status: number, body: string, sessionId: string | null = null) => ({ status, contentType: 'text/event-stream', sessionId, body });

    it('opens a session and lists the tools through the adapter, not with a plain request that would be turned away', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      adapter.callLink
        .mockResolvedValueOnce(answerOf(200, 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n', 's1'))
        .mockResolvedValueOnce(answerOf(202, ''))
        .mockResolvedValueOnce(answerOf(200, 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"GMAIL_FETCH_EMAILS"},{"name":"GMAIL_SEND_EMAIL"}]}}\n', 's1'));
      const response = await test(serverId);
      expect(await response.json()).toMatchObject({ success: true, toolCount: 2, toolNames: ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'] });
      expect(adapter.callLink.mock.calls.map(([call]) => [call.message.method, call.sessionId])).toEqual([['initialize', null], ['notifications/initialized', 's1'], ['tools/list', 's1']]);
      expect((await prisma.botMcpServer.findUniqueOrThrow({ where: { id: serverId } })).lastTestResult).toMatchObject({ success: true, toolCount: 2 });
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(0);
    });

    it('picks the answer to the question out of an event stream that sends a notification first', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      adapter.callLink
        .mockResolvedValueOnce(answerOf(200, 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n', 's1'))
        .mockResolvedValueOnce(answerOf(202, ''))
        .mockResolvedValueOnce(answerOf(200, 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"GMAIL_FETCH_EMAILS"}]}}\n', 's1'));
      expect(await (await test(serverId)).json()).toMatchObject({ success: true, toolCount: 1, toolNames: ['GMAIL_FETCH_EMAILS'] });
    });

    it('reports a refusal by the link as a failed test with its status, and an unfinished sign-in as one to reconnect', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      adapter.callLink.mockResolvedValueOnce(answerOf(401, 'nope'));
      expect(await (await test(serverId)).json()).toMatchObject({ success: false, status: 401 });
      adapter.callLink.mockClear();
      adapter.connectionStatus.mockResolvedValue('pending');
      await prisma.appConnection.updateMany({ where: { ownerId: sara }, data: { providerConfirmedAt: null } });
      const pending = await (await test(serverId)).json();
      expect(pending).toMatchObject({ success: false });
      expect(pending.error).toContain('Reconnect required');
      expect(adapter.callLink).not.toHaveBeenCalled();
    });

    it('reports an error the link carries inside a 200 answer as a failed test, never as a working app with no tools', async () => {
      const { adapter, serverId } = await connectedAndGranted();
      adapter.callLink.mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"no session"}}'));
      const opening = await (await test(serverId)).json();
      expect(opening).toMatchObject({ success: false, toolCount: 0 });
      expect(opening.error).toContain('Initialize error: no session');

      adapter.callLink
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":1,"result":{}}', 's1'))
        .mockResolvedValueOnce(answerOf(202, ''))
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"sign-in expired"}}', 's1'));
      const listing = await (await test(serverId)).json();
      expect(listing).toMatchObject({ success: false, toolCount: 0 });
      expect(listing.error).toContain('MCP error: sign-in expired');

      // An answer with no list of tools is not an app with no tools, while an empty list is
      adapter.callLink
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":1,"result":{}}', 's1'))
        .mockResolvedValueOnce(answerOf(202, ''))
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":2,"result":{}}', 's1'));
      expect(await (await test(serverId)).json()).toMatchObject({ success: false, toolCount: 0 });
      adapter.callLink
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":1,"result":{}}', 's1'))
        .mockResolvedValueOnce(answerOf(202, ''))
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"nope":1}]}}', 's1'));
      expect(await (await test(serverId)).json()).toMatchObject({ success: false, toolCount: 0 });
      adapter.callLink
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":1,"result":{}}', 's1'))
        .mockResolvedValueOnce(answerOf(202, ''))
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}', 's1'));
      expect(await (await test(serverId)).json()).toMatchObject({ success: true, toolCount: 0 });

      // A 200 that is not an answer at all is not an app with no tools either
      adapter.callLink
        .mockResolvedValueOnce(answerOf(200, '{"jsonrpc":"2.0","id":1,"result":{}}', 's1'))
        .mockResolvedValueOnce(answerOf(202, ''))
        .mockResolvedValueOnce(answerOf(200, '<html>maintenance</html>', 's1'));
      expect(await (await test(serverId)).json()).toMatchObject({ success: false, toolCount: 0 });
      // The last stored result is the failure, so the screen does not show a green one
      expect((await prisma.botMcpServer.findUniqueOrThrow({ where: { id: serverId } })).lastTestResult).toMatchObject({ success: false });
    });
  });

  it('refuses a person’s own app by link on this route: it only serves ready-made apps', async () => {
    setAdapterForTests(fake());
    asSara();
    const own = await createConnection(sara, { name: 'Own', serverUrl: 'https://own.example.com/mcp', authType: 'none', source: 'link' });
    const grant = await grantToBrick(sara, own.id, saraBrick);
    expect((await useIt({ serverId: (grant as { id: string }).id })).status).toBe(404);
  });

  it('tells the bot server which of a bot’s Apps are ready-made, so it goes through Orbit for them and for no other', async () => {
    const { serverId } = await connectedAndGranted();
    const own = await createConnection(sara, { name: 'Own', serverUrl: 'https://own.example.com/mcp', authType: 'none', source: 'link' });
    const ownGrant = (await grantToBrick(sara, own.id, saraBrick)) as { id: string };
    const ownServer = await prisma.botMcpServer.create({ data: { botId: saraBrick, name: 'Plain', serverUrl: 'https://plain.example.com/mcp', authType: 'none' } });
    asSara();
    const servers = (await (await listServers(request(`/api/bots/${saraBrick}/mcp-servers`), params({ id: saraBrick }))).json()) as { id: string; readyMade: boolean }[];
    expect(servers.find((s) => s.id === serverId)?.readyMade).toBe(true);
    expect(servers.find((s) => s.id === ownGrant.id)?.readyMade).toBe(false);
    expect(servers.find((s) => s.id === ownServer.id)?.readyMade).toBe(false);
  });
});
