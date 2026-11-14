/**
 * Connect GitHub for Bricks (game #2041), against a real database: a person connects their own GitHub through Universe's GitHub App,
 * Orbit keeps and renews the token, and a Brick works on GitHub as them through Orbit, without the token ever leaving it. Runs only
 * with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/github-connect-db.test.ts
 */
import crypto, { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null; isSuperAdmin?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));

import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { forgetGitHubApp, saveGitHubApp } from '@/lib/github/app';
import { gitHubToken, readGitHubAuth } from '@/lib/github/connection';
import { forgetGitHubCalls } from '@/lib/github/link';
import { GITHUB_TOOLS } from '@/lib/github/tools';
import { GET as catalog } from '@/app/api/me/apps/catalog/route';
import { POST as connectApp } from '@/app/api/me/apps/route';
import { GET as readApp, DELETE as disconnectApp } from '@/app/api/me/apps/[connectionId]/route';
import { GET as signIn } from '@/app/api/me/apps/[connectionId]/sign-in/route';
import { GET as callback } from '@/app/api/github/callback/route';
import { GET as installed } from '@/app/api/github/installed/route';
import { POST as webhook } from '@/app/api/github/webhook/route';
import { POST as saveKey, DELETE as dropKey } from '@/app/api/me/apps/github/key/route';
import { GET as createPage } from '@/app/api/admin/github-app/create/route';
import { GET as listServers } from '@/app/api/bots/[id]/mcp-servers/route';
import { POST as link } from '@/app/api/ready-made/link/route';
import { grantToBrick, readConnection } from '@/lib/app-connections';
import { createBrick } from '@/lib/brick-create';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const SERVICE = `service-${tag}`;
const ADMIN = `admin-${tag}`;
const OPENER = 'https://play.example.com/brick';

const request = (path: string, init: { method?: string; body?: unknown; token?: string; raw?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://orbit.example.com${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) },
    ...(init.raw !== undefined ? { body: init.raw } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
/** A pretend GitHub: replies by method and address, and every request kept. */
function pretendGitHub(routes: Record<string, Reply | ((init: RequestInit) => Reply)>) {
  const calls: { key: string; init: RequestInit }[] = [];
  global.fetch = (async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push({ key, init });
    const found = routes[key] ?? routes[key.split('?')[0]];
    if (!found) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const reply = typeof found === 'function' ? found(init) : found;
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  }) as unknown as typeof fetch;
  return calls;
}

const envBefore = { service: process.env.BOT_SERVICE_TOKEN, admin: process.env.ADMIN_API_TOKEN, url: process.env.ADMIN_API_URL, cors: process.env.CORS_ALLOWED_ORIGINS, key: process.env.ENCRYPTION_KEY };
const fetchBefore = global.fetch;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

let sara = '';
let saraBrick = '';

async function makeApp() {
  await saveGitHubApp({ id: 77, slug: 'bawes-universe', client_id: 'Iv1.client', client_secret: 'app-secret', webhook_secret: 'hook-secret', pem: PEM, html_url: 'https://github.com/apps/bawes-universe' }, null);
}

/** Connect, sign in and come back, as Sara: her GitHub connection's id. */
async function signedIn(installs = 1): Promise<string> {
  mockUser.current = { id: sara };
  const made = await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: 'github' } }));
  const { id } = await made.json();
  const started = await (await signIn(request(`/api/me/apps/${id}/sign-in?redirectUrl=${encodeURIComponent(OPENER)}`), params({ connectionId: id }))).json();
  const state = new URL(started.authorizeUrl).searchParams.get('state') as string;
  pretendGitHub({
    'POST https://github.com/login/oauth/access_token': { body: { access_token: 'ghu_first', refresh_token: 'ghr_first', expires_in: 28800, refresh_token_expires_in: 15897600 } },
    'GET https://api.github.com/user': { body: { login: 'sara-gh', id: 501 } },
    'GET https://api.github.com/user/installations': { body: { total_count: installs } },
  });
  await callback(request(`/api/github/callback?code=abc&state=${encodeURIComponent(state)}`));
  return id;
}

run('Connect GitHub for Bricks, in a real database', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE;
    process.env.ADMIN_API_TOKEN = ADMIN;
    process.env.ADMIN_API_URL = 'https://orbit.example.com';
    process.env.CORS_ALLOWED_ORIGINS = 'https://play.example.com';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    sara = (await prisma.user.create({ data: { uuid: `sara-${tag}`, email: `sara-${tag}@example.test`, name: 'Sara' } })).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Brick' })).id;
  });
  beforeEach(async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'github-app' } });
    forgetGitHubApp();
    forgetGitHubCalls();
  });
  afterEach(async () => {
    global.fetch = fetchBefore;
    mockUser.current = null;
    await prisma.appConnection.deleteMany({ where: { ownerId: sara } });
  });
  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'github-app' } });
    forgetGitHubApp();
    await prisma.user.deleteMany({ where: { id: sara } });
    for (const [name, value] of [['BOT_SERVICE_TOKEN', envBefore.service], ['ADMIN_API_TOKEN', envBefore.admin], ['ADMIN_API_URL', envBefore.url], ['CORS_ALLOWED_ORIGINS', envBefore.cors], ['ENCRYPTION_KEY', envBefore.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await prisma.$disconnect();
  });

  it('offers no GitHub row of its own until the app is made, then offers it first to everyone', async () => {
    mockUser.current = { id: sara };
    const before = await (await catalog(request('/api/me/apps/catalog'))).json();
    expect(before.apps.some((app: { key: string }) => app.key === 'github')).toBe(false);
    expect((await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: 'github' } }))).status).toBe(404);
    await makeApp();
    const after = await (await catalog(request('/api/me/apps/catalog'))).json();
    expect(after.apps[0]).toEqual({ key: 'github', name: 'GitHub', blurb: 'Code, pull requests, issues and CI', icon: 'github', connectionId: null });
  });

  it('the Create page sends GitHub the whole form for the organization, for a super admin only', async () => {
    mockUser.current = { id: sara, isSuperAdmin: false };
    expect((await createPage(request('/api/admin/github-app/create'))).status).toBe(403);
    mockUser.current = { id: sara, isSuperAdmin: true };
    const page = await (await createPage(request('/api/admin/github-app/create'))).text();
    expect(page).toContain('action="https://github.com/organizations/BAWES-Universe/settings/apps/new?state=');
    expect(page).toContain('name="manifest"');
    expect(page).toContain('https://orbit.example.com/api/github/callback');
    await makeApp();
    expect(await (await createPage(request('/api/admin/github-app/create'))).text()).toContain('already set up');
  });

  it('connects once, signs in on GitHub with PKCE, keeps the token in Orbit and sends a person with no install on to pick where it works', async () => {
    await makeApp();
    mockUser.current = { id: sara };
    const first = await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: 'github' } }));
    expect(first.status).toBe(201);
    const { id } = await first.json();
    expect((await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: 'github' } }))).status).toBe(200);
    const started = await (await signIn(request(`/api/me/apps/${id}/sign-in?redirectUrl=${encodeURIComponent(OPENER)}`), params({ connectionId: id }))).json();
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('Iv1.client');
    expect(url.searchParams.get('redirect_uri')).toBe('https://orbit.example.com/api/github/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBeNull();

    const calls = pretendGitHub({
      'POST https://github.com/login/oauth/access_token': { body: { access_token: 'ghu_1', refresh_token: 'ghr_1', expires_in: 28800, refresh_token_expires_in: 15897600 } },
      'GET https://api.github.com/user': { body: { login: 'sara-gh', id: 501 } },
      'GET https://api.github.com/user/installations': { body: { total_count: 0 } },
    });
    const back = await callback(request(`/api/github/callback?code=abc&state=${encodeURIComponent(url.searchParams.get('state') as string)}`));
    expect(back.status).toBe(302);
    const install = new URL(back.headers.get('location') as string);
    expect(install.origin + install.pathname).toBe('https://github.com/apps/bawes-universe/installations/new');
    const exchange = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(exchange)).toMatchObject({ client_id: 'Iv1.client', client_secret: 'app-secret', grant_type: 'authorization_code', code: 'abc' });
    expect(exchange.get('code_verifier')).toBeTruthy();

    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id } });
    expect(row.authConfig).not.toContain('ghu_1');
    expect(readGitHubAuth(row)).toMatchObject({ provider: 'github', accessToken: 'ghu_1', refreshToken: 'ghr_1', login: 'sara-gh', githubId: 501 });
    expect((await readConnection(id, sara))).toMatchObject({ source: 'github', connected: true, reconnectRequired: false, lendable: false });

    // Back from the install page: the window closes on the page that opened it
    const done = await installed(request(`/api/github/installed?installation_id=1&setup_action=install&state=${encodeURIComponent(install.searchParams.get('state') as string)}`));
    expect(done.headers.get('location')).toBe('https://play.example.com/oauth-popup-callback.html?oauth=success');

    // The same return again is refused before GitHub is asked: the ticket was used
    const again = await callback(request(`/api/github/callback?code=abc&state=${encodeURIComponent(url.searchParams.get('state') as string)}`));
    expect(again.headers.get('location')).toBe('https://play.example.com/oauth-popup-callback.html?oauth=error&message=sign_in_expired');
  });

  it('closes the window at once when the app is already installed somewhere', async () => {
    await makeApp();
    mockUser.current = { id: sara };
    const { id } = await (await connectApp(request('/api/me/apps', { method: 'POST', body: { catalogKey: 'github' } }))).json();
    const started = await (await signIn(request(`/api/me/apps/${id}/sign-in?redirectUrl=${encodeURIComponent(OPENER)}`), params({ connectionId: id }))).json();
    pretendGitHub({
      'POST https://github.com/login/oauth/access_token': { body: { access_token: 'ghu_1', refresh_token: 'ghr_1', expires_in: 28800 } },
      'GET https://api.github.com/user': { body: { login: 'sara-gh', id: 501 } },
      'GET https://api.github.com/user/installations': { body: { total_count: 2 } },
    });
    const back = await callback(request(`/api/github/callback?code=abc&state=${encodeURIComponent(new URL(started.authorizeUrl).searchParams.get('state') as string)}`));
    expect(back.headers.get('location')).toBe('https://play.example.com/oauth-popup-callback.html?oauth=success');
  });

  it('a Brick gets GitHub through Orbit: no token is handed out, the tools are listed, a call runs once', async () => {
    await makeApp();
    const id = await signedIn();
    const grant = await grantToBrick(sara, id, saraBrick);
    expect(grant).toMatchObject({ lookUpSetting: 'rightAway', makeSetting: 'rightAway', changeSetting: 'rightAway', deleteSendSetting: 'rightAway' });

    const listed = await (await listServers(request(`/api/bots/${saraBrick}/mcp-servers`, { token: ADMIN }), params({ id: saraBrick }))).json();
    const server = (listed.servers ?? listed).find((s: { connectionId: string }) => s.connectionId === id);
    expect(server).toMatchObject({ readyMade: true });
    expect(server.authConfig).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain('ghu_first');

    const send = (message: Record<string, unknown>, callId?: string) =>
      link(request('/api/ready-made/link', { method: 'POST', token: SERVICE, body: { botId: saraBrick, serverId: grant!.id, forOwner: true, message, ...(callId ? { callId } : {}) } }));
    const opened = await (await send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05' } })).json();
    expect(JSON.parse(opened.body).result.serverInfo.name).toBe('github');
    const tools = JSON.parse((await (await send({ jsonrpc: '2.0', id: '1', method: 'tools/list' })).json()).body).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(GITHUB_TOOLS.map((tool) => tool.name));

    const calls = pretendGitHub({ 'GET https://api.github.com/user': { body: { login: 'sara-gh', name: 'Sara' } } });
    const ran = await (await send({ jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'github_whoami', arguments: {} } }, 'call-1')).json();
    expect(JSON.parse(JSON.parse(ran.body).result.content[0].text)).toMatchObject({ login: 'sara-gh' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer ghu_first');
    expect((await send({ jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'github_whoami', arguments: {} } }, 'call-1')).status).toBe(409);
    // Only its owner's Brick, and only tools it has
    expect((await send({ jsonrpc: '2.0', id: '3', method: 'tools/call', params: { name: 'something_else', arguments: {} } }, 'call-2')).status).toBe(400);
  });

  it('renews the token before it runs out, once, and asks for a new sign-in when GitHub refuses the renewal', async () => {
    await makeApp();
    const id = await signedIn();
    const row = await prisma.appConnection.findUniqueOrThrow({ where: { id } });
    const auth = readGitHubAuth(row)!;
    await prisma.appConnection.update({ where: { id }, data: { authConfig: encryptApiKey(JSON.stringify({ ...auth, expiresAt: Math.floor(Date.now() / 1000) + 60 })) } });

    const calls = pretendGitHub({ 'POST https://github.com/login/oauth/access_token': { body: { access_token: 'ghu_second', refresh_token: 'ghr_second', expires_in: 28800 } } });
    const [a, b] = await Promise.all([gitHubToken(id), gitHubToken(id)]);
    expect(a).toMatchObject({ status: 'ok', token: 'ghu_second' });
    expect(b).toMatchObject({ status: 'ok', token: 'ghu_second' });
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_first' });
    expect(readGitHubAuth(await prisma.appConnection.findUniqueOrThrow({ where: { id } }))).toMatchObject({ accessToken: 'ghu_second', refreshToken: 'ghr_second' });

    const renewed = readGitHubAuth(await prisma.appConnection.findUniqueOrThrow({ where: { id } }))!;
    await prisma.appConnection.update({ where: { id }, data: { authConfig: encryptApiKey(JSON.stringify({ ...renewed, expiresAt: Math.floor(Date.now() / 1000) - 10 })) } });
    pretendGitHub({ 'POST https://github.com/login/oauth/access_token': { body: { error: 'bad_refresh_token' } } });
    expect(await gitHubToken(id)).toMatchObject({ status: 'reconnect' });
    expect(await readConnection(id, sara)).toMatchObject({ connected: false, reconnectRequired: true });
  });

  it('shows where it works, and where it waits for an owner’s OK', async () => {
    await makeApp();
    const id = await signedIn();
    pretendGitHub({
      'GET https://api.github.com/user/installations': {
        body: {
          installations: [
            { id: 11, account: { login: 'sara-gh', type: 'User' }, repository_selection: 'all' },
            { id: 12, account: { login: 'BAWES-Universe', type: 'Organization' }, repository_selection: 'selected' },
          ],
        },
      },
      'GET https://api.github.com/user/installations/12/repositories': { body: { total_count: 3 } },
      'GET https://api.github.com/app/installation-requests': (init) => {
        // Asked as the app itself, with its own short token
        expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Bearer ey/);
        return { body: [{ account: { login: 'acme', type: 'Organization' }, requester: { id: 501 } }, { account: { login: 'other', type: 'Organization' }, requester: { id: 999 } }] };
      },
    });
    mockUser.current = { id: sara };
    const answer = await (await readApp(request(`/api/me/apps/${id}`), params({ connectionId: id }))).json();
    expect(answer.github).toEqual({
      login: 'sara-gh',
      ownKey: false,
      known: true,
      places: [
        { account: 'sara-gh', type: 'User', repos: 'all', manageUrl: 'https://github.com/settings/installations/11' },
        { account: 'BAWES-Universe', type: 'Organization', repos: 3, manageUrl: 'https://github.com/organizations/BAWES-Universe/settings/installations/12' },
      ],
      waiting: [{ account: 'acme', type: 'Organization' }],
      addPlaceUrl: 'https://github.com/apps/bawes-universe/installations/select_target',
      installUrl: 'https://github.com/apps/bawes-universe/installations/new',
      ownKeyPage: 'https://github.com/settings/tokens/new?scopes=repo,workflow,read:org&description=Universe',
    });
  });

  it('takes a key of the person’s own after GitHub accepts it, uses it as it is, and switches back', async () => {
    await makeApp();
    mockUser.current = { id: sara };
    pretendGitHub({ 'GET https://api.github.com/user': (init) => ((init.headers as Record<string, string>).Authorization === 'Bearer ghp_good_key_123' ? { body: { login: 'sara-gh', id: 501 } } : { status: 401, body: { message: 'Bad credentials' } }) });
    expect((await saveKey(request('/api/me/apps/github/key', { method: 'POST', body: { key: 'ghp_wrong_key_000' } }))).status).toBe(400);
    const saved = await saveKey(request('/api/me/apps/github/key', { method: 'POST', body: { key: 'ghp_good_key_123' } }));
    expect(saved.status).toBe(200);
    const { id, login } = await saved.json();
    expect(login).toBe('sara-gh');
    expect(await gitHubToken(id)).toMatchObject({ status: 'ok', token: 'ghp_good_key_123' });
    expect(await readConnection(id, sara)).toMatchObject({ connected: true });
    await dropKey(request('/api/me/apps/github/key', { method: 'DELETE' }));
    expect(await readConnection(id, sara)).toMatchObject({ connected: false });
  });

  it('Disconnect takes the sign-in back at GitHub with the app’s own secret', async () => {
    await makeApp();
    const id = await signedIn();
    const calls = pretendGitHub({ 'DELETE https://api.github.com/applications/Iv1.client/grant': { status: 204 } });
    mockUser.current = { id: sara };
    expect((await disconnectApp(request(`/api/me/apps/${id}`, { method: 'DELETE' }), params({ connectionId: id }))).status).toBe(204);
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('Iv1.client:app-secret').toString('base64')}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ access_token: 'ghu_first' });
    expect(await prisma.appConnection.count({ where: { id } })).toBe(0);
  });

  it('takes webhooks only with GitHub’s signature', async () => {
    await makeApp();
    const body = '{"action":"created"}';
    const signature = `sha256=${crypto.createHmac('sha256', 'hook-secret').update(body).digest('hex')}`;
    expect((await webhook(request('/api/github/webhook', { method: 'POST', raw: body, headers: { 'x-hub-signature-256': signature } }))).status).toBe(204);
    expect((await webhook(request('/api/github/webhook', { method: 'POST', raw: body, headers: { 'x-hub-signature-256': 'sha256=00' } }))).status).toBe(401);
  });

  it('never stores the app’s secrets in the clear', async () => {
    await makeApp();
    const row = await prisma.appSetting.findUniqueOrThrow({ where: { key: 'github-app' } });
    const text = JSON.stringify(row.value);
    expect(text).not.toContain('app-secret');
    expect(text).not.toContain('PRIVATE KEY');
    expect(JSON.parse(decryptApiKey((row.value as { secrets: string }).secrets))).toMatchObject({ clientSecret: 'app-secret' });
  });
});
