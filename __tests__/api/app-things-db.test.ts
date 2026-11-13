/**
 * "Connected · it can do 3 things" (game #2001): what an app can do, by name, for its owner only, against a real database and a FAKE
 * adapter and a fake app. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null; isGuest?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/mcp/outbound-guard', () => ({
  ...jest.requireActual('@/lib/mcp/outbound-guard'),
  isAllowedServerIp: jest.fn(async () => ({ allowed: true })),
}));

import { prisma } from '@/lib/db';
import { setAdapterForTests, type LinkAnswer, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { GET as things } from '@/app/api/me/apps/[connectionId]/things/route';
import { createConnection } from '@/lib/app-connections';
import { thingName } from '@/lib/app-things';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const ask = (id: string) => things(new NextRequest(`http://localhost/api/me/apps/${id}/things`), { params: Promise.resolve({ connectionId: id }) });
const toolsAnswer = (names: string[]): LinkAnswer => ({ status: 200, contentType: 'application/json', sessionId: null, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: names.map((name) => ({ name })) } }) });

let sara = '';
let omar = '';
const keyBefore = process.env.ENCRYPTION_KEY;
const fetchBefore = global.fetch;

const fake = (names: string[]) =>
  ({
    startConnect: jest.fn(),
    connectionStatus: jest.fn(async () => 'active' as const),
    appLink: jest.fn(),
    callLink: jest.fn(async (input: { message: Record<string, unknown> }): Promise<LinkAnswer> => (input.message.method === 'tools/list' ? toolsAnswer(names) : { status: 200, contentType: 'application/json', sessionId: 'mcp-1', body: '{"jsonrpc":"2.0","id":1,"result":{}}' })),
    use: jest.fn(),
  }) as unknown as ReadyMadeAdapter;

describe('thingName', () => {
  it('reads a tool name in plain words, without the app’s own prefix', () => {
    expect(thingName('GMAIL_FETCH_EMAILS', 'gmail')).toBe('Fetch Emails');
    expect(thingName('find_events', null)).toBe('Find Events');
    expect(thingName('findEvents', null)).toBe('Find Events');
    expect(thingName('search-docs', null)).toBe('Search Docs');
    expect(thingName('GMAIL_FETCH_EMAILS', null)).toBe('Gmail Fetch Emails');
  });
});

run('what an app can do, in a real database', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
  });
  afterEach(async () => {
    setAdapterForTests(undefined);
    global.fetch = fetchBefore;
    mockUser.current = null;
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
  });
  afterAll(async () => {
    if (keyBefore === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = keyBefore;
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    await prisma.$disconnect();
  });

  const readyMade = (extra: Record<string, unknown> = {}) =>
    createConnection(sara, { name: 'Gmail', serverUrl: 'https://mcp.composio.dev/x/mcp', authType: 'none', source: 'ready_made', providerToolkit: 'gmail', providerAccountId: `ca_${tag}`, ...extra });

  it('names what a ready-made app can do, read through the adapter, and only for its owner', async () => {
    setAdapterForTests(fake(['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS']));
    const made = await readyMade();
    await prisma.appConnection.update({ where: { id: made.id }, data: { providerConfirmedAt: new Date() } });
    mockUser.current = { id: sara };
    const answer = await ask(made.id);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ things: ['Fetch Emails', 'Send Email'] });
    // Someone else's app, one that is not there, and no one signed in
    mockUser.current = { id: omar };
    expect((await ask(made.id)).status).toBe(404);
    expect((await ask('no-such-app')).status).toBe(404);
    mockUser.current = null;
    expect((await ask(made.id)).status).toBe(401);
  });

  it('says the list is incomplete when the app has more pages than are read', async () => {
    const adapter = fake([]);
    (adapter.callLink as jest.Mock).mockImplementation(async (input: { message: Record<string, unknown> }): Promise<LinkAnswer> => {
      if (input.message.method !== 'tools/list') return { status: 200, contentType: 'application/json', sessionId: 'mcp-1', body: '{"jsonrpc":"2.0","id":1,"result":{}}' };
      const id = input.message.id as number;
      return { status: 200, contentType: 'application/json', sessionId: null, body: JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: `GMAIL_TOOL_${id}` }], nextCursor: `c${id + 1}` } }) };
    });
    setAdapterForTests(adapter);
    const made = await readyMade();
    await prisma.appConnection.update({ where: { id: made.id }, data: { providerConfirmedAt: new Date() } });
    mockUser.current = { id: sara };
    const body = await (await ask(made.id)).json();
    expect(body.incomplete).toBe(true);
    expect(body.things).toHaveLength(20);
    expect(body.things[0]).toBe('Tool 2');
  });

  it('gives an empty list, never an error, while a ready-made app is not signed in or the adapter is off', async () => {
    const adapter = fake(['GMAIL_FETCH_EMAILS']);
    (adapter.connectionStatus as jest.Mock).mockResolvedValue('pending');
    setAdapterForTests(adapter);
    const made = await readyMade();
    mockUser.current = { id: sara };
    expect(await (await ask(made.id)).json()).toEqual({ things: [] });
    expect(adapter.callLink).not.toHaveBeenCalled();
    setAdapterForTests(null);
    expect(await (await ask(made.id)).json()).toEqual({ things: [] });
  });

  it('names what an app added with a link can do, by asking the app, and gives nothing while the app cannot be reached', async () => {
    const own = await createConnection(sara, { name: 'Calendar', serverUrl: 'https://calendar.example.com/mcp', authType: 'none', source: 'link' });
    const sent: string[] = [];
    global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body)) as { method: string };
      sent.push(message.method);
      const body = message.method === 'tools/list' ? { jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'find_events' }, { name: 'createEvent' }] } } : { jsonrpc: '2.0', id: 'init', result: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    mockUser.current = { id: sara };
    expect(await (await ask(own.id)).json()).toEqual({ things: ['Find Events', 'Create Event'] });
    // The session is told it is open before anything is listed
    expect(sent).toEqual(['initialize', 'notifications/initialized', 'tools/list']);

    global.fetch = jest.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await (await ask(own.id)).json()).toEqual({ things: [] });
  });

  it('gives nothing for an app that needs a sign-in it does not have', async () => {
    const own = await createConnection(sara, { name: 'Notes', serverUrl: 'https://notes.example.com/mcp', authType: 'oauth', source: 'link' });
    global.fetch = jest.fn() as unknown as typeof fetch;
    mockUser.current = { id: sara };
    expect(await (await ask(own.id)).json()).toEqual({ things: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
