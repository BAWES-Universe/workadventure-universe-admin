/**
 * Adding an app by its link is repeat-safe (game "Add your own app"), against a real database: the same request key from the same
 * person answers the first app and never makes a second, also when the repeats come at the same moment; a key never answers
 * across people, never hides a different app, and is optional, so a request without one behaves as it always did. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/app-link-request-key-db.test.ts
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
import { decryptApiKey } from '@/lib/encryption';
import { connectByLink } from '@/lib/app-connections';
import { GET as myApps, POST as addApp } from '@/app/api/me/apps/route';
import { DELETE as disconnectApp } from '@/app/api/me/apps/[connectionId]/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const LINK = 'https://firecrawl.example.com/mcp';
const body = (extra: Record<string, unknown> = {}) => ({ name: 'Firecrawl', serverUrl: LINK, authType: 'bearer', authConfig: 'fc-key', ...extra });
const post = (payload: unknown) =>
  addApp(new NextRequest('http://localhost/api/me/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
const count = (ownerId: string) => prisma.appConnection.count({ where: { ownerId } });

let sara = '';
let omar = '';
const keyBefore = process.env.ENCRYPTION_KEY;

run('adding an app by its link twice, in a real database', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
  });
  afterEach(async () => {
    mockUser.current = null;
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
  });
  afterAll(async () => {
    if (keyBefore === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = keyBefore;
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    await prisma.$disconnect();
  });

  it('makes the app on the first request (201) and answers the same app on a repeat (200)', async () => {
    mockUser.current = { id: sara };
    const first = await post(body({ requestKey: 'sheet-1' }));
    expect(first.status).toBe(201);
    const made = await first.json();
    const again = await post(body({ requestKey: 'sheet-1' }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(made);
    expect(await count(sara)).toBe(1);
    // the app the repeat answers is the first one as it was made: its sign-in is stored once, encrypted, never read back
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id: made.id } });
    expect(row).toMatchObject({ ownerId: sara, name: 'Firecrawl', source: 'link', requestKey: 'sheet-1' });
    expect(decryptApiKey(row.authConfig!)).toBe('fc-key');
    expect(JSON.stringify(await (await myApps(new NextRequest('http://localhost/api/me/apps'))).json())).not.toContain('fc-key');
  });

  it('answers the first app to a repeat that comes after the person renamed it, without touching it', async () => {
    mockUser.current = { id: sara };
    const { id } = await (await post(body({ requestKey: 'sheet-2' }))).json();
    await prisma.appConnection.update({ where: { id }, data: { name: 'Firecrawl (renamed)' } });
    // The name was changed afterwards, so a repeat that carries the name it knows is the first app; the rename stays theirs
    const again = await post(body({ requestKey: 'sheet-2', name: 'Firecrawl (renamed)' }));
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(id);
    expect(await count(sara)).toBe(1);
  });

  it('makes one app when many identical requests come at the same moment, and every one answers it', async () => {
    mockUser.current = { id: sara };
    const answers = await Promise.all(Array.from({ length: 8 }, () => post(body({ requestKey: 'sheet-race' }))));
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    const ids = new Set((await Promise.all(answers.map((answer) => answer.json()))).map((answer) => answer.id));
    expect(ids.size).toBe(1);
    expect(await count(sara)).toBe(1);
  });

  it('makes one app when the lib is called at the same moment too, whichever request wins', async () => {
    const input = { name: 'Firecrawl', serverUrl: LINK, authType: 'none' as const };
    const results = await Promise.all(Array.from({ length: 6 }, () => connectByLink(sara, input, 'lib-race')));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await count(sara)).toBe(1);
  });

  it('keeps two keys, and two people with the same key, apart', async () => {
    mockUser.current = { id: sara };
    const a = await (await post(body({ requestKey: 'a' }))).json();
    const b = await (await post(body({ requestKey: 'b' }))).json();
    expect(a.id).not.toBe(b.id);
    mockUser.current = { id: omar };
    const theirs = await post(body({ requestKey: 'a' }));
    expect(theirs.status).toBe(201);
    expect((await theirs.json()).id).not.toBe(a.id);
    expect(await count(sara)).toBe(2);
    expect(await count(omar)).toBe(1);
  });

  it('refuses a key that comes back with a different app, and makes nothing', async () => {
    mockUser.current = { id: sara };
    const first = await (await post(body({ requestKey: 'sheet-3' }))).json();
    for (const changed of [{ serverUrl: 'https://other.example.com/mcp' }, { name: 'Other' }, { authType: 'none', authConfig: null }]) {
      const refused = await post(body({ requestKey: 'sheet-3', ...changed }));
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toMatch(/requestKey/);
    }
    expect(await count(sara)).toBe(1);
    expect((await prisma.appConnection.findUniqueOrThrow({ where: { id: first.id } })).serverUrl).toBe(LINK);
  });

  it('is optional: requests without a key each make an app, as before, and no key is stored', async () => {
    mockUser.current = { id: sara };
    const one = await post(body());
    const two = await post(body());
    const three = await post(body({ requestKey: null }));
    expect([one.status, two.status, three.status]).toEqual([201, 201, 201]);
    expect(await count(sara)).toBe(3);
    expect(await prisma.appConnection.count({ where: { ownerId: sara, requestKey: null } })).toBe(3);
  });

  it('refuses a key that is empty, too long or not text, and a bad request with a key makes nothing and keeps the key free', async () => {
    mockUser.current = { id: sara };
    for (const requestKey of ['', '   ', 'k'.repeat(201), 5, { a: 1 }]) {
      expect((await post(body({ requestKey }))).status).toBe(400);
    }
    expect((await post(body({ requestKey: 'k'.repeat(200) }))).status).toBe(201);
    // a request the checks refuse (a private address) is refused again the same way and never takes the key
    const bad = await post(body({ requestKey: 'sheet-4', serverUrl: 'http://127.0.0.1/mcp' }));
    expect(bad.status).toBe(400);
    expect(await post(body({ requestKey: 'sheet-4' }))).toMatchObject({ status: 201 });
  });

  it('makes a new app for the same key once the first was disconnected (nothing of it is left to answer)', async () => {
    mockUser.current = { id: sara };
    const first = await (await post(body({ requestKey: 'sheet-6' }))).json();
    const gone = await disconnectApp(new NextRequest(`http://localhost/api/me/apps/${first.id}`, { method: 'DELETE' }), { params: Promise.resolve({ connectionId: first.id }) });
    expect(gone.status).toBeLessThan(300);
    const again = await post(body({ requestKey: 'sheet-6' }));
    expect(again.status).toBe(201);
    expect((await again.json()).id).not.toBe(first.id);
  });
});
