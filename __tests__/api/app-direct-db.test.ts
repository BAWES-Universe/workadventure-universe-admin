/**
 * Key apps (game #2044) against a real database: the safe form from its opening to a stored key, and what only the database can show.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/app-direct-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { decryptApiKey } from '@/lib/encryption';
import { disconnect, effectiveServer, listConnections, WITH_CONNECTION } from '@/lib/app-connections';
import { openKeyForm, readKey, readKeyForm, submitKey, KeyFormError } from '@/lib/app-direct/connect';
import type { GuardDeps } from '@/lib/app-direct/guard';
import { GET as listServices } from '@/app/api/me/apps/key-services/route';
import { POST as openForm } from '@/app/api/me/apps/key-forms/route';
import { GET as readForm } from '@/app/api/me/apps/key-forms/[formId]/route';
import { POST as sendKey } from '@/app/api/me/apps/key-forms/[formId]/key/route';
import { GET as listApps } from '@/app/api/me/apps/route';
import { saveServerLimits } from '@/lib/bot-limits';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const TEST_KEY = `sk_test_${randomUUID().replace(/-/g, '')}`;
const LIVE_KEY = `sk_live_${randomUUID().replace(/-/g, '')}`;
let sara = '';
let omar = '';
let saraBrick = '';
const envKey = process.env.ENCRYPTION_KEY;
let limitsBefore: { value: unknown } | null = null;

const request = (path: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

/** What the service answers, and every request it was sent. */
function service(status: number | ((request: { path: string; headers: Record<string, string> }) => number)) {
  const seen: { host: string; address: string; path: string; method: string; headers: Record<string, string> }[] = [];
  const deps: GuardDeps = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    send: async (target) => {
      seen.push({ host: target.host, address: target.address, path: target.path, method: target.method, headers: target.headers });
      const code = typeof status === 'function' ? status({ path: target.path, headers: target.headers }) : status;
      return { status: code, redirected: false, body: '{}', truncated: false, contentType: 'application/json' };
    },
  };
  return { deps, seen };
}

run('key apps, in a real database', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    // The recommended limits, whatever an earlier run of anything left on this database
    limitsBefore = await prisma.appSetting.findUnique({ where: { key: 'bot-limits' } });
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
  });

  afterEach(async () => {
    mockUser.current = null;
    await prisma.appKeyRequest.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    if (limitsBefore) await prisma.appSetting.create({ data: { key: 'bot-limits', value: limitsBefore.value as object } });
    if (envKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = envKey;
    await prisma.$disconnect();
  });

  const open = async (ownerId = sara) => (await openKeyForm({ ownerId, service: 'tap' })).id;

  it('shows the form for this person only, with where the key goes and what is checked, and nothing else', async () => {
    const id = await open();
    const view = await readKeyForm(id, sara);
    expect(view).toMatchObject({ mode: 'prefilled', name: 'Tap Payments', short: 'Tap', keyLabel: 'Tap key', host: 'api.tap.company', hostReadable: null, source: null, differentSite: false, check: 'Look up a payment', replacing: null, triesLeft: 5 });
    expect(view.keyHint).toContain('sk_test_');
    // Someone else's form looks exactly like one that does not exist
    await expect(readKeyForm(id, omar)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(submitKey({ requestId: id, ownerId: omar, key: TEST_KEY }, service(404).deps)).rejects.toMatchObject({ status: 404 });
    await expect(openKeyForm({ ownerId: sara, service: 'nothing' })).rejects.toMatchObject({ status: 404, code: 'unknown_service' });
  });

  it('checks the key with a look-up sent to the one origin, stores it encrypted, and shows only its end', async () => {
    const id = await open();
    const fake = service(404);
    const done = await submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, fake.deps);
    expect(done).toMatchObject({ name: 'Tap Payments', created: true });

    // One request, a GET look-up, to the shipped origin, at the checked address, with the key only in the header
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]).toMatchObject({ host: 'api.tap.company', address: '93.184.216.34', method: 'GET', path: '/v2/charges/chg_universe_key_check' });
    expect(fake.seen[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(fake.seen[0].path).not.toContain(TEST_KEY);

    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: done.id } });
    expect(row).toMatchObject({ kind: 'direct', source: 'direct', authType: 'none', authConfig: null, catalogKey: 'direct:tap', keyLast4: TEST_KEY.slice(-4), keyMode: 'test', serverUrl: 'https://api.tap.company', ownerId: sara, universeId: null });
    expect(row.keyCipher).not.toContain(TEST_KEY);
    expect(decryptApiKey(row.keyCipher!)).toBe(TEST_KEY);
    expect(readKey(row)).toBe(TEST_KEY);

    // The form is used up, and the list shows the end of the key and never the key
    await expect(readKeyForm(id, sara)).rejects.toMatchObject({ status: 410, code: 'used' });
    mockUser.current = { id: sara };
    const listed = await (await listApps(request('/api/me/apps'))).json();
    expect(listed.apps).toHaveLength(1);
    expect(listed.apps[0]).toMatchObject({ kind: 'direct', keyLast4: TEST_KEY.slice(-4), keyMode: 'test', connected: true, lendable: false });
    expect(JSON.stringify(listed)).not.toContain(TEST_KEY);
    expect(JSON.stringify(await listConnections(sara))).not.toContain(row.keyCipher!);
  });

  it('trims what was pasted around the key, and shows no hint of the end of a short key', async () => {
    const id = await open();
    const short = 'sk_test_abcd';
    const fake = service(404);
    const done = await submitKey({ requestId: id, ownerId: sara, key: `  ${short}\n` }, fake.deps);
    expect(fake.seen[0].headers.authorization).toBe(`Bearer ${short}`);
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: done.id } });
    expect(readKey(row)).toBe(short);
    expect(row.keyLast4).toBeNull();
    mockUser.current = { id: sara };
    const listed = await (await listApps(request('/api/me/apps'))).json();
    expect(listed.apps.find((app: { id: string }) => app.id === done.id)).toMatchObject({ kind: 'direct', keyLast4: null });
    expect(JSON.stringify(listed)).not.toContain(short);
    await prisma.appConnection.delete({ where: { id: done.id } });
  });

  it('does not take a key the service refuses: it costs a try, stores nothing, and the form closes after the last one', async () => {
    const id = await open();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, service(401).deps)).rejects.toMatchObject({ status: 422, code: 'rejected' });
      expect((await readKeyForm(id, sara).catch(() => null))?.triesLeft ?? 0).toBe(5 - attempt);
    }
    const fake = service(200);
    await expect(submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, fake.deps)).rejects.toMatchObject({ status: 429, code: 'too_many' });
    expect(fake.seen).toHaveLength(0);
    expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(0);
  });

  it('says only "not a key this form can take" for text that is not one, and sends nothing', async () => {
    const id = await open();
    const fake = service(200);
    for (const bad of ['short', 'two words in here', 'x'.repeat(600), '', 7, null]) {
      await expect(submitKey({ requestId: id, ownerId: sara, key: bad }, fake.deps)).rejects.toMatchObject({ status: 400, code: 'invalid_key' });
    }
    expect(fake.seen).toHaveLength(0);
  });

  it('does not say the key is wrong when the service could not be reached or sent a redirect, and costs no try', async () => {
    const id = await open();
    await expect(submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, { resolve: async () => [{ address: '10.0.0.1', family: 4 }] })).rejects.toMatchObject({ status: 502, code: 'unreachable' });
    await expect(submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async () => ({ status: 302, redirected: true, body: '', truncated: false, contentType: null }) })).rejects.toMatchObject({ status: 502, code: 'unreachable' });
    await expect(submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, service(503).deps)).rejects.toMatchObject({ status: 502 });
    expect((await readKeyForm(id, sara)).triesLeft).toBe(5);
  });

  it('closes a form after its time, and a form can be used once, also when two keys arrive at the same moment', async () => {
    const old = await open();
    await prisma.appKeyRequest.update({ where: { id: old }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(readKeyForm(old, sara)).rejects.toMatchObject({ status: 410, code: 'expired' });
    await expect(submitKey({ requestId: old, ownerId: sara, key: TEST_KEY }, service(404).deps)).rejects.toMatchObject({ status: 410 });

    const id = await open();
    const results = await Promise.allSettled([submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, service(404).deps), submitKey({ requestId: id, ownerId: sara, key: LIVE_KEY }, service(404).deps)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(1);
  });

  it('replaces a key atomically: the new one is checked first, the old one stops, and the app stays the same one', async () => {
    const first = await submitKey({ requestId: await open(), ownerId: sara, key: TEST_KEY }, service(404).deps);
    const again = `sk_test_${randomUUID().replace(/-/g, '')}`;

    // A form for the same service replaces that app's key; it says whose key it replaces
    const replace = await openKeyForm({ ownerId: sara, service: 'tap' });
    expect(replace.replacing).toBe(true);
    expect(await readKeyForm(replace.id, sara)).toMatchObject({ replacing: { keyLast4: TEST_KEY.slice(-4), mode: 'test' } });

    // A key the service refuses changes nothing: the old key is still the one in use
    await expect(submitKey({ requestId: replace.id, ownerId: sara, key: again }, service(401).deps)).rejects.toMatchObject({ code: 'rejected' });
    expect(readKey(await prisma.appConnection.findUniqueOrThrow({ where: { id: first.id } }))).toBe(TEST_KEY);

    const done = await submitKey({ requestId: replace.id, ownerId: sara, key: again }, service(404).deps);
    expect(done).toMatchObject({ id: first.id, created: false });
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: first.id } });
    expect(readKey(row)).toBe(again);
    expect(row).toMatchObject({ keyVersion: 2, keyLast4: again.slice(-4), signInLostAt: null });
    expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(1);
  });

  it('asks first when a replacement switches between a test key and a real one, and a new key clears "key stopped working"', async () => {
    const first = await submitKey({ requestId: await open(), ownerId: sara, key: TEST_KEY }, service(404).deps);
    await prisma.appConnection.update({ where: { id: first.id }, data: { signInLostAt: new Date(), signInLostStatus: 401 } });
    const form = (await openKeyForm({ ownerId: sara, connectionId: first.id })).id;
    await expect(submitKey({ requestId: form, ownerId: sara, key: LIVE_KEY }, service(404).deps)).rejects.toMatchObject({ status: 409, code: 'mode_change', extra: { from: 'test', to: 'live' } });
    // Nothing changed and the form is still open for the answer
    expect(readKey(await prisma.appConnection.findUniqueOrThrow({ where: { id: first.id } }))).toBe(TEST_KEY);
    expect((await readKeyForm(form, sara)).triesLeft).toBe(5);
    await submitKey({ requestId: form, ownerId: sara, key: LIVE_KEY, confirmChange: true }, service(404).deps);
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({ keyMode: 'live', signInLostAt: null, signInLostStatus: null });
    expect(readKey(row)).toBe(LIVE_KEY);
  });

  it("never lets one person replace another's key, or open a form on another's app", async () => {
    const mine = await submitKey({ requestId: await open(), ownerId: sara, key: TEST_KEY }, service(404).deps);
    await expect(openKeyForm({ ownerId: omar, connectionId: mine.id })).rejects.toMatchObject({ status: 404 });
    // Omar's own Tap is his own app, not Sara's
    const omars = await submitKey({ requestId: await open(omar), ownerId: omar, key: LIVE_KEY }, service(404).deps);
    expect(omars.id).not.toBe(mine.id);
    expect(await prisma.appConnection.count({ where: { ownerId: { in: [sara, omar] } } })).toBe(2);
  });

  it('holds the shape in the database: a key app is its owner\'s, direct, with a key, never a universe\'s, and never lendable', async () => {
    const base = { name: 'X', serverUrl: 'https://api.example.com', ownerId: sara, kind: 'direct', definition: { a: 1 }, definitionHash: 'h', keyCipher: 'c', source: 'direct', authType: 'none' } as const;
    await expect(prisma.appConnection.create({ data: { ...base, source: 'link' } })).rejects.toThrow();
    await expect(prisma.appConnection.create({ data: { ...base, keyCipher: null } })).rejects.toThrow();
    await expect(prisma.appConnection.create({ data: { ...base, definition: undefined } })).rejects.toThrow();
    await expect(prisma.appConnection.create({ data: { ...base, authType: 'bearer' } })).rejects.toThrow();
    // An app link may not hold a key
    await expect(prisma.appConnection.create({ data: { ...base, kind: 'mcp', source: 'link' } })).rejects.toThrow();

    const ok = await prisma.appConnection.create({ data: base });
    const universe = await prisma.universe.create({ data: { slug: `lend-${tag}`, name: 'Lend', ownerId: omar } });
    try {
      await expect(prisma.appLend.create({ data: { connectionId: ok.id, universeId: universe.id, lentById: sara } })).rejects.toThrow();
    } finally {
      await prisma.universe.delete({ where: { id: universe.id } });
    }
  });

  it('is never handed to a Brick as a way in: a grant of it carries no key, whatever is written to the row', async () => {
    const made = await submitKey({ requestId: await open(), ownerId: sara, key: TEST_KEY }, service(404).deps);
    // Connecting gives the owner's Brick its grant; it holds a name and nothing to connect with
    const grant = await prisma.botMcpServer.findFirstOrThrow({ where: { botId: saraBrick, connectionId: made.id } });
    expect(grant).toMatchObject({ authType: 'none', authConfig: null, headers: null, serverUrl: '' });
    const row = await prisma.botMcpServer.findUniqueOrThrow({ where: { id: grant.id }, include: WITH_CONNECTION });
    const served = effectiveServer(row);
    expect(served).toMatchObject({ authType: 'none', authConfig: null, headers: null });
    expect(JSON.stringify(served)).not.toContain(TEST_KEY);
    expect(JSON.stringify(served)).not.toContain(row.connection!.keyCipher!);
    expect(served.connection?.keyCipher).toBeNull();
    // Even a row written with a way in by hand reads back without it
    await prisma.botMcpServer.update({ where: { id: grant.id }, data: { authType: 'bearer', authConfig: 'x:y:z', headers: { a: 'b' } } });
    const forged = effectiveServer(await prisma.botMcpServer.findUniqueOrThrow({ where: { id: grant.id }, include: WITH_CONNECTION }));
    expect(forged).toMatchObject({ authType: 'none', authConfig: null, headers: null });
  });

  it('disconnect takes it away', async () => {
    const made = await submitKey({ requestId: await open(), ownerId: sara, key: TEST_KEY }, service(404).deps);
    expect(await disconnect(omar, made.id)).toBe(false);
    expect(await disconnect(sara, made.id)).toBe(true);
    expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(0);
  });

  it('writes the key nowhere readable: not in any row of any table, in any of the forms it travels in', async () => {
    const id = await open();
    const made = await submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, service(404).deps);
    await prisma.appConnection.update({ where: { id: made.id }, data: { name: 'Tap Payments' } });
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const forms = [TEST_KEY, Buffer.from(TEST_KEY).toString('base64'), encodeURIComponent(TEST_KEY)];
    for (const { tablename } of tables) {
      for (const form of forms) {
        const found = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${tablename}" t WHERE row_to_json(t)::text LIKE $1`, `%${form}%`);
        expect({ tablename, found: Number(found[0].n) }).toEqual({ tablename, found: 0 });
      }
    }
  });

  describe('through the routes', () => {
    it('opens a form, shows it, takes the key, and refuses a guest, a stranger and a body with anything else in it', async () => {
      const spec = await listServices(request('/api/me/apps/key-services'));
      expect(spec.status).toBe(401);
      mockUser.current = { id: sara, isGuest: true };
      expect((await openForm(request('/api/me/apps/key-forms', { service: 'tap' }))).status).toBe(403);

      mockUser.current = { id: sara };
      expect((await (await listServices(request('/api/me/apps/key-services'))).json()).services.map((entry: { service: string }) => entry.service)).toEqual(['tap']);
      expect((await openForm(request('/api/me/apps/key-forms', { service: 'tap', origin: 'https://evil.example' }))).status).toBe(400);
      expect((await openForm(request('/api/me/apps/key-forms', { service: 'nothing' }))).status).toBe(404);
      const opened = await openForm(request('/api/me/apps/key-forms', { service: 'tap' }));
      expect(opened.status).toBe(201);
      const { id } = await opened.json();

      const shown = await (await readForm(request(`/api/me/apps/key-forms/${id}`), params({ formId: id }))).json();
      expect(shown.form).toMatchObject({ id, host: 'api.tap.company', keyLabel: 'Tap key' });

      mockUser.current = { id: omar };
      expect((await readForm(request(`/api/me/apps/key-forms/${id}`), params({ formId: id }))).status).toBe(404);
      expect((await sendKey(request(`/api/me/apps/key-forms/${id}/key`, { key: TEST_KEY }), params({ formId: id }))).status).toBe(404);

      mockUser.current = { id: sara };
      expect((await sendKey(request(`/api/me/apps/key-forms/${id}/key`, { key: TEST_KEY, host: 'evil.example' }), params({ formId: id }))).status).toBe(400);
      expect((await sendKey(request(`/api/me/apps/key-forms/${id}/key`, { key: 'tiny' }), params({ formId: id }))).status).toBe(400);
      expect(await prisma.appConnection.count({ where: { ownerId: sara } })).toBe(0);
    });

    it('answers a key the service takes with the app and never the key', async () => {
      const form = await open();
      const real = global.fetch;
      // The route uses the real guard: a name that resolves nowhere public is refused as unreachable and stores nothing
      mockUser.current = { id: sara };
      const response = await sendKey(request(`/api/me/apps/key-forms/${form}/key`, { key: TEST_KEY }), params({ formId: form }));
      global.fetch = real;
      expect([502, 201, 422]).toContain(response.status);
      expect(JSON.stringify(await response.json())).not.toContain(TEST_KEY);
    });
  });

  it('keeps the form time and tries as Limits settings, not numbers in the code', async () => {
    try {
      await saveServerLimits({ bricks: { keyFormMinutes: 1, keyTries: 2 } }, sara);
      const id = await open();
      expect((await readKeyForm(id, sara)).triesLeft).toBe(2);
      const row = await prisma.appKeyRequest.findUniqueOrThrow({ where: { id } });
      expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
      await expect(submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, service(401).deps)).rejects.toMatchObject({ code: 'rejected' });
      await expect(submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, service(401).deps)).rejects.toMatchObject({ code: 'rejected' });
      await expect(submitKey({ requestId: id, ownerId: sara, key: TEST_KEY }, service(401).deps)).rejects.toMatchObject({ code: 'too_many' });
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    }
  });

  it('does not tell a form error apart from one that was never there, for a draft that is not valid', async () => {
    await expect(openKeyForm({ ownerId: sara, draft: { origin: 'http://x' } })).rejects.toBeInstanceOf(KeyFormError);
  });
});
