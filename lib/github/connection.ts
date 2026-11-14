import crypto from 'crypto';
import { Prisma, type AppConnection } from '@prisma/client';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { holdRefreshLease } from '@/lib/mcp/oauth-refresh';
import { gitHubRequest, type FetchLike } from '@/lib/github/api';
import {
  appJwt,
  getGitHubApp,
  GITHUB_API,
  GITHUB_CALLBACK_PATH,
  GITHUB_WEB,
  installUrl,
  orbitBase,
  OWN_KEY_PAGE,
  selectTargetUrl,
  type GitHubApp,
} from '@/lib/github/app';

/**
 * A person's own GitHub (game #2041): one connection per person (`source: github`), signed in through Universe's GitHub App.
 * The sign-in is theirs: Orbit keeps the token (encrypted, never handed to the bot server or a Brick's computer) and renews it
 * before it runs out (GitHub's last eight hours). Or the person pastes a key of their own instead, which is used as it is.
 */

/** The key a person's GitHub connection is kept under. Never a key of the super admin's list (those start with a letter or digit). */
export const GITHUB_CATALOG_KEY = '@github';
/** The key "Connect another" shows the GitHub row under, and takes back on Connect. */
export const GITHUB_ROW_KEY = 'github';
export const GITHUB_SOURCE = 'github';

/** What a GitHub connection keeps, encrypted, in its authConfig. Only the token fields are read by the generic sign-in state. */
export interface GitHubAuth {
  provider: 'github';
  accessToken?: string;
  refreshToken?: string;
  /** Seconds since 1970, when the access token stops working (none for a key of the person's own). */
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  /** A key the person pasted ("Use my own GitHub key instead"); used as it is until they switch back. */
  ownKey?: boolean;
  login?: string;
  githubId?: number;
  reconnectRequired?: { at: string; reason: string } | null;
}

export function readGitHubAuth(connection: Pick<AppConnection, 'authConfig'>): GitHubAuth | null {
  if (!connection.authConfig) return null;
  try {
    const parsed = JSON.parse(decryptApiKey(connection.authConfig)) as GitHubAuth;
    return parsed && typeof parsed === 'object' && parsed.provider === 'github' ? parsed : null;
  } catch {
    return null;
  }
}

const sealAuth = (auth: GitHubAuth) => encryptApiKey(JSON.stringify(auth));

/** Whether this connection is a person's GitHub through Universe's app. */
export const isGitHubConnection = (connection: Pick<AppConnection, 'source'> | null | undefined): boolean => connection?.source === GITHUB_SOURCE;

/* ------------------------------------ connect ------------------------------------ */

/**
 * "Connect" on the GitHub row: the person's GitHub connection, made when they have none (not signed in yet: the sign-in comes
 * next). Asked twice, the second answer is the first connection. Null while the app has not been made.
 */
export async function connectGitHub(ownerId: string): Promise<{ id: string; created: boolean } | null> {
  if (!(await getGitHubApp())) return null;
  const existing = await prisma.appConnection.findFirst({ where: { ownerId, catalogKey: GITHUB_CATALOG_KEY }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  try {
    const made = await prisma.appConnection.create({
      data: {
        ownerId,
        connectedById: ownerId,
        name: 'GitHub',
        serverUrl: GITHUB_API,
        authType: 'oauth',
        authConfig: sealAuth({ provider: 'github' }),
        source: GITHUB_SOURCE,
        catalogKey: GITHUB_CATALOG_KEY,
      },
      select: { id: true },
    });
    return { id: made.id, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.appConnection.findFirst({ where: { ownerId, catalogKey: GITHUB_CATALOG_KEY }, select: { id: true } });
      if (winner) return { id: winner.id, created: false };
    }
    throw error;
  }
}

/* ------------------------------------ sign in ------------------------------------ */

const STATE_SECONDS = 600;

interface SignInState {
  kind: 'github-sign-in';
  connectionId: string;
  personId: string;
  nonce: string;
  redirectUrl: string;
  codeVerifier: string;
  exp: number;
}

interface InstallState {
  kind: 'github-install';
  connectionId: string;
  redirectUrl: string;
  exp: number;
}

/** Reads a state Orbit made, or null when it is not one, is of another kind, or is too old. */
export function openState<T extends { kind: string; exp: number }>(token: string | null, kind: T['kind']): T | null {
  if (!token) return null;
  try {
    const value = JSON.parse(decryptApiKey(token)) as T;
    if (!value || value.kind !== kind || typeof value.exp !== 'number' || value.exp < Math.floor(Date.now() / 1000)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * The page that opened the sign-in (the game or Orbit), only when it is one of ours: the person is sent back there to close the
 * sign-in window. Same rule as every other sign-in (lib/mcp/oauth-start.ts).
 */
export function openerUrl(request: NextRequest, fallbackPath = '/admin'): string {
  const { searchParams, origin } = new URL(request.url);
  const asked = searchParams.get('redirectUrl');
  const allowed = [origin, ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean)];
  if (asked) {
    try {
      if (allowed.includes(new URL(asked).origin)) return asked;
    } catch {
      // not an address: falls through
    }
    return `${origin}${fallbackPath}`;
  }
  return `${process.env.CORS_ALLOWED_ORIGINS?.split(',')[0] || origin}${fallbackPath}`;
}

/** GitHub's sign-in page for this person's connection, with a one-time ticket (the connection's nonce) and PKCE. */
export async function gitHubSignInUrl(request: NextRequest, connectionId: string, personId: string, nonce: string): Promise<{ ok: true; authorizeUrl: string } | { ok: false; status: number; error: string }> {
  const app = await getGitHubApp();
  if (!app) return { ok: false, status: 404, error: 'GitHub is not set up yet' };
  const base = orbitBase();
  if (!base) return { ok: false, status: 500, error: 'ADMIN_API_URL environment variable is not configured' };
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const state: SignInState = {
    kind: 'github-sign-in',
    connectionId,
    personId,
    nonce,
    redirectUrl: openerUrl(request),
    codeVerifier,
    exp: Math.floor(Date.now() / 1000) + STATE_SECONDS,
  };
  const url = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('redirect_uri', `${base}${GITHUB_CALLBACK_PATH}`);
  url.searchParams.set('state', encryptApiKey(JSON.stringify(state)));
  url.searchParams.set('code_challenge', crypto.createHash('sha256').update(codeVerifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  return { ok: true, authorizeUrl: url.toString() };
}

export function readSignInState(token: string | null): SignInState | null {
  return openState<SignInState>(token, 'github-sign-in');
}

export function readInstallState(token: string | null): InstallState | null {
  return openState<InstallState>(token, 'github-install');
}

/** The address of the install page, carrying where to send the person back once they picked where it works. */
export function installPageFor(app: GitHubApp, connectionId: string, redirectUrl: string): string {
  const state: InstallState = { kind: 'github-install', connectionId, redirectUrl, exp: Math.floor(Date.now() / 1000) + 60 * 60 };
  return installUrl(app, encryptApiKey(JSON.stringify(state)));
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  refresh_token_expires_in?: number | string;
  error?: string;
  error_description?: string;
}

const seconds = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Fills the token fields from GitHub's answer (a token that never runs out has no expiry and no refresh token). */
function withTokens(auth: GitHubAuth, answer: TokenAnswer, nowMs: number): GitHubAuth {
  const now = Math.floor(nowMs / 1000);
  const expiresIn = seconds(answer.expires_in);
  const refreshIn = seconds(answer.refresh_token_expires_in);
  return {
    ...auth,
    provider: 'github',
    ownKey: undefined,
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token || undefined,
    expiresAt: expiresIn ? now + expiresIn : undefined,
    refreshTokenExpiresAt: refreshIn ? now + refreshIn : undefined,
    reconnectRequired: null,
  };
}

async function tokenRequest(app: GitHubApp, fields: Record<string, string>, fetchImpl: FetchLike): Promise<TokenAnswer | null> {
  try {
    const response = await fetchImpl(`${GITHUB_WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'BAWES-Universe-Orbit' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...fields }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { error: `http_${response.status}` };
    return (await response.json()) as TokenAnswer;
  } catch (error) {
    console.error('[GitHub] Token request failed:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

export type SignInOutcome = { status: 'done'; needsInstall: boolean } | { status: 'expired' | 'failed' | 'gone' };

/**
 * GitHub sent the person back with a code: it is exchanged for their token (once, guarded by the connection's ticket), who they
 * are is kept, and whether they installed the app anywhere yet. `needsInstall` sends them on to pick where it works.
 */
export async function finishGitHubSignIn(state: SignInState, code: string, fetchImpl: FetchLike = fetch): Promise<SignInOutcome> {
  const app = await getGitHubApp();
  const base = orbitBase();
  if (!app || !base) return { status: 'failed' };
  const connection = await prisma.appConnection.findFirst({ where: { id: state.connectionId, ownerId: state.personId, source: GITHUB_SOURCE } });
  if (!connection) return { status: 'gone' };
  // One ticket per sign-in: a replayed return, or one a newer sign-in replaced, is refused before the code is spent
  const taken = await prisma.appConnection.updateMany({ where: { id: connection.id, signInNonce: state.nonce }, data: { signInNonce: null } });
  if (taken.count !== 1) return { status: 'expired' };
  const answer = await tokenRequest(app, { grant_type: 'authorization_code', code, redirect_uri: `${base}${GITHUB_CALLBACK_PATH}`, code_verifier: state.codeVerifier }, fetchImpl);
  if (!answer?.access_token) {
    console.error('[GitHub] Sign-in exchange refused:', answer?.error ?? 'no answer');
    return { status: 'failed' };
  }
  let auth = withTokens({ provider: 'github' }, answer, Date.now());
  const me = await gitHubRequest<{ login?: string; id?: number }>(answer.access_token, '/user', {}, fetchImpl).catch(() => null);
  if (me?.ok) auth = { ...auth, login: me.data.login, githubId: me.data.id };
  await prisma.appConnection.update({ where: { id: connection.id }, data: { authConfig: sealAuth(auth) } });
  const installs = await gitHubRequest<{ total_count?: number }>(answer.access_token, '/user/installations?per_page=1', {}, fetchImpl).catch(() => null);
  // Not known (GitHub did not answer): the sign-in is done; "Where it works" offers the install page
  return { status: 'done', needsInstall: !!installs?.ok && installs.data.total_count === 0 };
}

/* ------------------------------------- token ------------------------------------- */

/** Renewed this long before it runs out, so a call that starts just before never carries a token that dies on the way. */
const RENEW_BEFORE_SECONDS = 5 * 60;

const renewing = new Map<string, Promise<TokenOutcome>>();

export type TokenOutcome = { status: 'ok'; token: string; login: string | null } | { status: 'reconnect'; reason: string } | { status: 'unavailable' };

async function markReconnect(connectionId: string, auth: GitHubAuth, reason: string): Promise<void> {
  const kept: GitHubAuth = { provider: 'github', login: auth.login, githubId: auth.githubId, reconnectRequired: { at: new Date().toISOString(), reason } };
  await prisma.appConnection.update({ where: { id: connectionId }, data: { authConfig: sealAuth(kept), signInLostAt: new Date() } }).catch(() => undefined);
}

/**
 * A working token for the person's GitHub, renewed first when it is close to running out. One renewal at a time for a connection
 * across every Orbit server (the connection's refresh lease): GitHub replaces the refresh token on each renewal, so two renewals
 * with the same one would sign the person out.
 */
export async function gitHubToken(connectionId: string, fetchImpl: FetchLike = fetch): Promise<TokenOutcome> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!connection || !isGitHubConnection(connection)) return { status: 'unavailable' };
  const auth = readGitHubAuth(connection);
  if (!auth?.accessToken) return { status: 'reconnect', reason: auth?.reconnectRequired?.reason ?? 'Not signed in to GitHub yet' };
  if (auth.ownKey || !auth.expiresAt || auth.expiresAt - RENEW_BEFORE_SECONDS > Math.floor(Date.now() / 1000)) {
    return { status: 'ok', token: auth.accessToken, login: auth.login ?? null };
  }
  const running = renewing.get(connectionId);
  if (running) return running;
  const renewal = renewUnderLease(connectionId, fetchImpl).finally(() => renewing.delete(connectionId));
  renewing.set(connectionId, renewal);
  return renewal;
}

async function renewUnderLease(connectionId: string, fetchImpl: FetchLike): Promise<TokenOutcome> {
  const letGo = await holdRefreshLease(connectionId);
  try {
    // Read again under the lease: another server may have just renewed it
    const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
    const auth = connection ? readGitHubAuth(connection) : null;
    if (!connection || !auth) return { status: 'unavailable' };
    if (!auth.accessToken) return { status: 'reconnect', reason: auth.reconnectRequired?.reason ?? 'Not signed in to GitHub yet' };
    const now = Math.floor(Date.now() / 1000);
    if (auth.ownKey || !auth.expiresAt || auth.expiresAt - RENEW_BEFORE_SECONDS > now) return { status: 'ok', token: auth.accessToken, login: auth.login ?? null };
    if (!auth.refreshToken || (auth.refreshTokenExpiresAt && auth.refreshTokenExpiresAt <= now)) {
      await markReconnect(connectionId, auth, 'The GitHub sign-in ran out');
      return { status: 'reconnect', reason: 'The GitHub sign-in ran out' };
    }
    const app = await getGitHubApp();
    if (!app) return { status: 'unavailable' };
    const answer = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: auth.refreshToken }, fetchImpl);
    if (!answer) return auth.expiresAt > now ? { status: 'ok', token: auth.accessToken, login: auth.login ?? null } : { status: 'unavailable' };
    if (!answer.access_token) {
      // GitHub answers a dead refresh token with 200 and an error: only a new sign-in fixes it
      if (answer.error === 'bad_refresh_token' || answer.error === 'invalid_grant') {
        await markReconnect(connectionId, auth, 'GitHub asked for a new sign-in');
        return { status: 'reconnect', reason: 'GitHub asked for a new sign-in' };
      }
      return auth.expiresAt > now ? { status: 'ok', token: auth.accessToken, login: auth.login ?? null } : { status: 'unavailable' };
    }
    const renewed = withTokens(auth, answer, Date.now());
    // GitHub has already turned the old refresh token off: the new one must be kept, so the write is tried more than once.
    // If it still fails, the new token works for this call and the next renewal asks for a new sign-in.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await prisma.appConnection.update({ where: { id: connectionId }, data: { authConfig: sealAuth(renewed) } });
        break;
      } catch (error) {
        if (attempt >= 3) {
          console.error('[github] Could not keep the renewed GitHub sign-in', error);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    return { status: 'ok', token: renewed.accessToken as string, login: renewed.login ?? null };
  } finally {
    await letGo();
  }
}

/** GitHub refused the token outright (401): the person signs in again (or pastes a new key). */
export async function gitHubTokenRefused(connectionId: string): Promise<void> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  const auth = connection ? readGitHubAuth(connection) : null;
  if (auth) await markReconnect(connectionId, auth, auth.ownKey ? 'GitHub no longer takes this key' : 'GitHub asked for a new sign-in');
}

/* ----------------------------------- own key ----------------------------------- */

export type OwnKeyOutcome = { status: 'saved'; login: string } | { status: 'refused' | 'gone' | 'unavailable' };

/** "Use my own GitHub key instead": the key is checked with GitHub, then used instead of the sign-in until they switch back. */
export async function saveOwnKey(connectionId: string, key: string, fetchImpl: FetchLike = fetch): Promise<OwnKeyOutcome> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!connection || !isGitHubConnection(connection)) return { status: 'gone' };
  const me = await gitHubRequest<{ login?: string; id?: number }>(key, '/user', {}, fetchImpl).catch(() => null);
  if (!me) return { status: 'unavailable' };
  if (!me.ok || typeof me.data.login !== 'string') return { status: 'refused' };
  const auth: GitHubAuth = { provider: 'github', ownKey: true, accessToken: key, login: me.data.login, githubId: me.data.id, reconnectRequired: null };
  const letGo = await holdRefreshLease(connectionId);
  try {
    await prisma.appConnection.update({ where: { id: connectionId }, data: { authConfig: sealAuth(auth), signInLostAt: null, signInLostStatus: null, noAnswerAt: null, reconnectedAt: new Date() } });
  } finally {
    await letGo();
  }
  return { status: 'saved', login: me.data.login };
}

/** "Switch back": the pasted key is forgotten, and the person signs in through the app again. */
export async function dropOwnKey(connectionId: string): Promise<boolean> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!connection || !isGitHubConnection(connection)) return false;
  const auth = readGitHubAuth(connection);
  if (!auth?.ownKey) return true;
  await prisma.appConnection.update({ where: { id: connectionId }, data: { authConfig: sealAuth({ provider: 'github', login: auth.login, githubId: auth.githubId }) } });
  return true;
}

/* -------------------------------- where it works -------------------------------- */

export interface GitHubPlace {
  account: string;
  type: 'User' | 'Organization';
  /** 'all' for every repository there, or how many were picked. */
  repos: 'all' | number;
  manageUrl: string;
}

export interface GitHubWhere {
  login: string | null;
  ownKey: boolean;
  places: GitHubPlace[];
  /** Organizations where the person asked for the app and an owner has not said OK yet. */
  waiting: { account: string; type: 'User' | 'Organization' }[];
  /** "Add a place or change repos". */
  addPlaceUrl: string;
  /** The install page, to copy for an owner ("Ask an owner"). */
  installUrl: string;
  /** The classic token page filled in for "Use my own GitHub key instead". */
  ownKeyPage: string;
  /** False when GitHub could not be asked right now: the lists are then empty, not known to be. */
  known: boolean;
}

interface InstallationRow {
  id: number;
  account?: { login?: string; type?: string } | null;
  repository_selection?: 'all' | 'selected';
}

const manageUrlOf = (row: InstallationRow) =>
  row.account?.type === 'Organization' ? `${GITHUB_WEB}/organizations/${row.account.login}/settings/installations/${row.id}` : `${GITHUB_WEB}/settings/installations/${row.id}`;

/** Where the app works for this person (their account, their organizations), and where it waits for an owner's OK. */
export async function whereItWorks(connection: AppConnection, fetchImpl: FetchLike = fetch): Promise<GitHubWhere | null> {
  const app = await getGitHubApp();
  if (!app) return null;
  const auth = readGitHubAuth(connection);
  const where: GitHubWhere = {
    login: auth?.login ?? null,
    ownKey: !!auth?.ownKey,
    places: [],
    waiting: [],
    addPlaceUrl: selectTargetUrl(app),
    installUrl: installUrl(app),
    ownKeyPage: OWN_KEY_PAGE,
    known: false,
  };
  // A pasted key works wherever the person can work: there are no places to list
  if (!auth?.accessToken || auth.ownKey) return { ...where, known: !!auth?.ownKey };
  const token = await gitHubToken(connection.id, fetchImpl);
  if (token.status !== 'ok') return where;
  try {
    const listed = await gitHubRequest<{ installations?: InstallationRow[] }>(token.token, '/user/installations?per_page=100', {}, fetchImpl);
    if (!listed.ok) return where;
    const rows = (listed.data.installations ?? []).filter((row) => row.account?.login);
    where.places = await Promise.all(
      rows.slice(0, 20).map(async (row): Promise<GitHubPlace> => {
        let repos: 'all' | number = 'all';
        if (row.repository_selection === 'selected') {
          const picked = await gitHubRequest<{ total_count?: number }>(token.token, `/user/installations/${row.id}/repositories?per_page=1`, {}, fetchImpl).catch(() => null);
          repos = picked?.ok && typeof picked.data.total_count === 'number' ? picked.data.total_count : 0;
        }
        return { account: row.account!.login as string, type: row.account?.type === 'Organization' ? 'Organization' : 'User', repos, manageUrl: manageUrlOf(row) };
      }),
    );
    where.known = true;
  } catch {
    return where;
  }
  where.waiting = await waitingRequests(app, auth.githubId, where.places, fetchImpl);
  return where;
}

/** The person's own requests that wait for an owner's OK (the app's pending installation requests, read as the app). */
async function waitingRequests(app: GitHubApp, githubId: number | undefined, places: GitHubPlace[], fetchImpl: FetchLike): Promise<GitHubWhere['waiting']> {
  if (!githubId) return [];
  try {
    const answer = await gitHubRequest<{ account?: { login?: string; type?: string }; requester?: { id?: number } }[]>(appJwt(app), '/app/installation-requests?per_page=100', {}, fetchImpl);
    if (!answer.ok || !Array.isArray(answer.data)) return [];
    const installed = new Set(places.map((place) => place.account.toLowerCase()));
    const seen = new Set<string>();
    const waiting: GitHubWhere['waiting'] = [];
    for (const request of answer.data) {
      const login = request.account?.login;
      if (!login || request.requester?.id !== githubId || installed.has(login.toLowerCase()) || seen.has(login.toLowerCase())) continue;
      seen.add(login.toLowerCase());
      waiting.push({ account: login, type: request.account?.type === 'User' ? 'User' : 'Organization' });
    }
    return waiting;
  } catch {
    return [];
  }
}

/* ---------------------------------- disconnect ---------------------------------- */

/**
 * Disconnect takes the person's sign-in back at GitHub (every token of theirs for the app), best effort. A pasted key is theirs and
 * is left alone: only they can delete it on GitHub. Never throws.
 */
export async function revokeGitHub(connection: Pick<AppConnection, 'source' | 'authConfig'>, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    if (!isGitHubConnection(connection)) return false;
    const auth = readGitHubAuth(connection);
    const app = await getGitHubApp();
    if (!auth?.accessToken || auth.ownKey || !app) return false;
    const answer = await gitHubRequest(null, `/applications/${encodeURIComponent(app.clientId)}/grant`, {
      method: 'DELETE',
      body: { access_token: auth.accessToken },
      basicAuth: { user: app.clientId, password: app.clientSecret },
    }, fetchImpl);
    return answer.status === 204;
  } catch {
    return false;
  }
}
