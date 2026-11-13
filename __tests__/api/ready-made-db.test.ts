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
import { setAdapterForTests, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { saveReadyMadeApps } from '@/lib/app-adapter/settings';
import { POST as connectReadyMadeApp } from '@/app/api/me/apps/ready-made/route';
import { GET as adminGet, PUT as adminPut } from '@/app/api/admin/ready-made-apps/route';
import { POST as useApp } from '@/app/api/ready-made/use/route';
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
    appLink: jest.fn(async () => ({ url: `https://mcp.example/${tag}/mcp`, headers: {} })),
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
    await prisma.appSetting.deleteMany({ where: { key: 'meter' } });
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

  it('keeps its list for a super admin only, when on', async () => {
    setAdapterForTests(fake());
    asSara();
    expect((await adminGet(request('/api/admin/ready-made-apps'))).status).toBe(403);
    mockUser.current = { id: boss, email: 'boss@example.test' };
    const put = await adminPut(request('/api/admin/ready-made-apps', { method: 'PUT', body: { apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1' } } } }));
    expect(put.status).toBe(200);
    expect((await (await adminGet(request('/api/admin/ready-made-apps'))).json()).apps).toEqual([{ key: KEY, name: 'Gmail', authConfigId: 'ac_1', enabled: true }]);
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
    expect(adapter.appLink).toHaveBeenCalledWith({ person: sara, toolkits: [KEY] });
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({ ownerId: sara, source: 'ready_made', providerToolkit: KEY, serverUrl: `https://mcp.example/${tag}/mcp`, authConfig: null });

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
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: first.id } })).providerAccountId).toBe(`ca_second_${tag}`);
    expect(adapter.appLink).toHaveBeenCalledTimes(1);

    // They finished it this time: it reads connected, once and for good, and a tap no longer starts a sign-in
    adapter.connectionStatus.mockResolvedValue('active');
    expect((await listConnections(sara))[0].connected).toBe(true);
    expect(adapter.connectionStatus).toHaveBeenLastCalledWith({ providerAccountId: `ca_second_${tag}` });
    const after = await connect();
    expect(await after.json()).toEqual({ id: first.id });
    expect(adapter.startConnect).toHaveBeenCalledTimes(2);
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

  it('writes the meter before the provider is called, once for each call id, paid by the universe with the price unknown while no price is set', async () => {
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
    expect(events[0]).toMatchObject({ eventId: `app:${callId}`, payerKind: 'universe', route: 'app', unit: 'use', basis: 'unknown', costMicros: null, botId: saraBrick });
    expect(events[0].detail).toEqual({ toolkit: KEY, tool: 'GMAIL_FETCH_EMAILS' });
  });

  it('writes an estimate from the super admin’s own price once there is one', async () => {
    const { serverId } = await connectedAndGranted();
    await saveMeterSettings({ appUseMicros: 2500 }, boss);
    expect((await useIt({ serverId })).status).toBe(200);
    const event = await prisma.meterEvent.findFirstOrThrow({ where: { personId: sara, kind: 'app_use' } });
    expect(event).toMatchObject({ basis: 'estimated', costMicros: BigInt(2500) });
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

  it('refuses a person’s own app by link on this route: it only serves ready-made apps', async () => {
    setAdapterForTests(fake());
    asSara();
    const own = await createConnection(sara, { name: 'Own', serverUrl: 'https://own.example.com/mcp', authType: 'none', source: 'link' });
    const grant = await grantToBrick(sara, own.id, saraBrick);
    expect((await useIt({ serverId: (grant as { id: string }).id })).status).toBe(404);
  });
});
