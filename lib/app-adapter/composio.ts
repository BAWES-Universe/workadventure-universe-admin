import { AdapterError, type AppLink, type ConnectStart, type LinkAnswer, type ReadyMadeAdapter, type UseResult } from '@/lib/app-adapter/types';

/**
 * The real adapter, written from the provider's live docs (docs.composio.dev, read 12 Nov 2026), wired but never switched on
 * here. It is built only when COMPOSIO_API_KEY is set in Orbit's environment (lib/app-adapter/index.ts), and nothing sets it.
 *
 *  - API: https://backend.composio.dev/api/v3.1, header `x-api-key`.
 *  - Connect: POST /connected_accounts/link { auth_config_id, user_id, callback_url } -> { redirect_url, connected_account_id, expires_at }.
 *    The auth config is one per app, kept in a super admin setting (never in code) and passed in as the toolkit's config id.
 *  - Status: GET /connected_accounts/{id} -> { status: ACTIVE | INITIALIZING | INITIATED | FAILED | EXPIRED | INACTIVE }. Only ACTIVE reads as connected.
 *  - Use: POST /tools/execute/{tool_slug} { user_id, connected_account_id, arguments } -> { data, successful, error, log_id }.
 *  - Link: POST /tool_router/session { user_id, toolkits: { enable: [...] }, workbench: { enable: true } } -> { session_id, mcp: { url } }. The link answers 401 without
 *    the provider key, which Orbit sends itself on every message (callLink); no header is ever stored or handed on.
 *
 *  - Sign-in setup: with no auth config chosen by a super admin, the provider's own managed one for the app is used: found with
 *    GET /auth_configs?toolkit_slug&is_composio_managed, or made with POST /auth_configs { toolkit: { slug } } (its default is
 *    Composio-managed auth), so nobody registers anything with Google or others and nothing needs setting up.
 *
 * The key is sent on every call to a person's app link too (it answers 401 without it), by Orbit alone (callLink). A 429 is asked again
 * after the wait the provider names (its limit is 2,000 calls a minute for the account).
 *
 * The provider's sandbox (its "workbench", which runs code on the person's own data) is ON in every session (the provider's default,
 * stated explicitly); each run is counted like an app step by whoever sends it (the bot server).
 */

const BASE = 'https://backend.composio.dev/api/v3.1';

type Fetch = typeof fetch;

export interface ComposioOptions {
  apiKey: string;
  /** An auth config id a super admin chose for an app; null for none, which means the provider's managed one. */
  authConfigFor: (toolkit: string) => Promise<string | null>;
  fetchImpl?: Fetch;
  baseUrl?: string;
  /** For tests: how a wait is made. */
  sleep?: (ms: number) => Promise<void>;
}

/** The provider allows 2,000 calls a minute for the whole account: a refused call is asked again after the wait it names, a few times. */
const RETRIES = 3;
const MAX_WAIT_MS = 5_000;

/** The managed auth config found or made for each app, kept for the life of the process. */
const managedAuthConfigs = new Map<string, string>();

/** For tests. */
export function forgetManagedAuthConfigs(): void {
  managedAuthConfigs.clear();
}

export function createComposioAdapter(options: ComposioOptions): ReadyMadeAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE;

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const linkHosts = new Set([new URL(base).hostname]);

  /** Sends one request, and again after the provider's own wait when it says too many (429). */
  async function send(url: string, init: () => RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await doFetch(url, init());
      if (response.status !== 429 || attempt >= RETRIES) return response;
      const asked = Number(response.headers?.get?.('retry-after'));
      await sleep(Math.min(MAX_WAIT_MS, Number.isFinite(asked) && asked > 0 ? asked * 1000 : 1_000 * (attempt + 1)));
    }
  }

  async function call(path: string, body: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const response = await send(`${base}${path}`, () => ({
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-api-key': options.apiKey },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
      // The key goes only to the provider's own address: an answer that sends us elsewhere fails instead of being followed
      redirect: 'error',
    }));
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) throw new AdapterError('provider', `Provider answered ${response.status}`);
    return json;
  }

  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

  async function managedAuthConfig(toolkit: string): Promise<string> {
    const known = managedAuthConfigs.get(toolkit);
    if (known) return known;
    const found = await call(`/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=1`, null);
    const item = Array.isArray(found.items) ? (found.items[0] as Record<string, unknown> | undefined) : undefined;
    let id = str(item?.id);
    if (!id) {
      const made = await call('/auth_configs', { toolkit: { slug: toolkit } });
      const config = made.auth_config && typeof made.auth_config === 'object' ? (made.auth_config as Record<string, unknown>) : {};
      id = str(config.id);
    }
    if (!id) throw new AdapterError('provider', `Provider has no sign-in setup for ${toolkit}`);
    managedAuthConfigs.set(toolkit, id);
    return id;
  }

  return {
    async startConnect({ person, toolkit, returnUrl, authConfigId: given }): Promise<ConnectStart> {
      // A caller that already read the setting passes it (undefined: read it here), so a caller inside a database transaction never
      // takes a second pooled connection for it
      const authConfigId = (given !== undefined ? given : await options.authConfigFor(toolkit)) ?? (await managedAuthConfig(toolkit));
      const json = await call('/connected_accounts/link', { auth_config_id: authConfigId, user_id: person, callback_url: returnUrl });
      const redirectUrl = str(json.redirect_url);
      const providerAccountId = str(json.connected_account_id);
      if (!redirectUrl || !providerAccountId) throw new AdapterError('provider', 'Provider sent no sign-in page');
      return { redirectUrl, providerAccountId, expiresAt: str(json.expires_at) };
    },

    async connectionStatus({ providerAccountId }): Promise<'active' | 'pending' | 'failed'> {
      const json = await call(`/connected_accounts/${encodeURIComponent(providerAccountId)}`, null);
      const status = typeof json.status === 'string' ? json.status.toUpperCase() : '';
      if (status === 'ACTIVE') return 'active';
      if (status === 'INITIALIZING' || status === 'INITIATED') return 'pending';
      return 'failed';
    },

    async appLink({ person, toolkits, accounts }): Promise<AppLink> {
      // Each toolkit pinned to the account the person signed in with (the provider takes a list of ids per toolkit)
      const pinned = accounts ? Object.fromEntries(Object.entries(accounts).map(([toolkit, id]) => [toolkit, [id]])) : null;
      const json = await call('/tool_router/session', {
        user_id: person,
        toolkits: { enable: toolkits },
        workbench: { enable: true },
        ...(pinned && Object.keys(pinned).length > 0 ? { connected_accounts: pinned } : {}),
      });
      const mcp = json.mcp && typeof json.mcp === 'object' ? (json.mcp as Record<string, unknown>) : {};
      const url = str(mcp.url);
      if (!url) throw new AdapterError('provider', 'Provider sent no app link');
      // Whatever headers the session answer holds are dropped on purpose: the key is Orbit's alone, sent by callLink
      return { url };
    },

    async callLink({ url, message, sessionId }): Promise<LinkAnswer> {
      // The key goes only to the provider's own hosts, whatever link was stored
      let host: URL;
      try {
        host = new URL(url);
      } catch {
        throw new AdapterError('provider', 'The app link is not a link');
      }
      if (host.protocol !== 'https:') throw new AdapterError('provider', 'The app link is not secure');
      if (!(host.hostname === 'composio.dev' || host.hostname.endsWith('.composio.dev') || linkHosts.has(host.hostname))) {
        throw new AdapterError('provider', 'The app link is not the provider’s');
      }
      const response = await send(url, () => ({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-api-key': options.apiKey,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      }));
      return {
        status: response.status,
        contentType: response.headers?.get?.('content-type') ?? null,
        sessionId: response.headers?.get?.('mcp-session-id') ?? null,
        body: await response.text(),
      };
    },

    async use({ person, toolkit, tool, arguments: args, providerAccountId }): Promise<UseResult> {
      void toolkit;
      const json = await call(`/tools/execute/${encodeURIComponent(tool)}`, {
        user_id: person,
        ...(providerAccountId ? { connected_account_id: providerAccountId } : {}),
        arguments: args,
      });
      return { ok: json.successful === true, data: json.data ?? null, error: str(json.error), providerCallId: str(json.log_id) };
    },
  };
}
