import { AdapterError, type AppLink, type ConnectStart, type InstantAdapter, type InstantCall, type InstantLog, type LinkAnswer, type ReadyMadeAdapter, type UseResult } from '@/lib/app-adapter/types';
import { INSTANT_ACCOUNT, readInstantCharge } from '@/lib/instant/values';

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
 * INSTANT: an Instant tool runs on the provider's own accounts and is charged to OUR prepaid balance, and the provider's session has
 * no dollar cap. So every session made here says `instant: false` out loud (a session that says nothing lets Instant run the day
 * the project switch goes on), and an Instant tool runs only through `instant.run` below, sent on purpose through the Instant
 * account by the bounded executor (lib/instant/executor.ts). A single app step (`use`) names its connected account and never
 * runs without one, because a call with no account named is one the provider may serve from Instant.
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

/** The most groups the usage API returns for one question. */
const USAGE_GROUP_LIMIT = 1000;

/** A count the provider sent: a whole number of zero or more, as a number or a numeric string; anything else is null (never zero). */
function readCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One execution log line, as far as the executor reads it. A line with no id is not one. */
function readLog(row: Record<string, unknown>): InstantLog | null {
  const id = typeof row.id === 'string' && row.id ? row.id : null;
  if (!id) return null;
  const metadata = isObject(row.metadata) ? row.metadata : {};
  const tool = isObject(metadata.tool) ? metadata.tool.slug : undefined;
  const status = row.status === 'success' ? 'success' : row.status === 'failed' ? 'failed' : 'unknown';
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return {
    id,
    status,
    chargeMicros: readInstantCharge(metadata.instant_charge),
    credentialSource: typeof metadata.credential_source === 'string' ? metadata.credential_source : null,
    tool: typeof tool === 'string' ? tool : null,
    userId: typeof metadata.user_id === 'string' ? metadata.user_id : null,
    atMs: Number.isFinite(at) ? at : null,
  };
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

  const instant: InstantAdapter = {
    async run({ runUserId, tool, arguments: args }): Promise<InstantCall> {
      let response: Response;
      try {
        response = await doFetch(`${base}/tools/execute/${encodeURIComponent(tool)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey },
          // Instant is chosen on purpose, by name, and never by the provider's own order of accounts
          body: JSON.stringify({ user_id: runUserId, connected_account_id: INSTANT_ACCOUNT, arguments: args }),
          signal: AbortSignal.timeout(60_000),
          redirect: 'error',
        });
      } catch (error) {
        // Sent, and nothing came back that can be read: it may have run
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return { kind: 'unclear', why: timedOut ? 'timeout' : 'network', status: null };
      }
      const status = response.status;
      const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const error = json && typeof json.error === 'object' && json.error !== null ? (json.error as Record<string, unknown>) : null;
      const code = str(error?.slug) ?? (typeof error?.code === 'number' ? String(error.code) : str(error?.code));
      // Refused before anything ran: not signed in, balance empty, Instant not switched on, too many requests
      if (status === 401 || status === 402 || status === 403 || status === 429) return { kind: 'rejected', status, code };
      if (status === 400 || status === 404 || status === 422) return { kind: 'invalid', status, code };
      if (status >= 500 || status === 408) return { kind: 'unclear', why: 'server', status };
      if (!response.ok || !json || typeof json.successful !== 'boolean') return { kind: 'unclear', why: 'unreadable', status };
      const data = isObject(json.data) || Array.isArray(json.data) ? json.data : (json.data ?? null);
      // The charge, when the answer carries it. Composio's REST docs do not say it does, so its log is also asked after the run.
      const reported = readInstantCharge(json.instant_charge ?? (isObject(json.metadata) ? (json.metadata as Record<string, unknown>).instant_charge : undefined));
      return { kind: 'done', successful: json.successful === true, data, error: json.successful === true ? null : (str(json.error) ?? 'failed'), logId: str(json.log_id), chargeMicros: reported };
    },

    async log(logId) {
      const json = await call(`/logs/tool_execution/${encodeURIComponent(logId)}`, null).catch((error) => {
        // A line that is not there (404) is "none"; anything else is Composio not being reachable
        if (error instanceof AdapterError && /answered 404/.test(error.message)) return null;
        throw error;
      });
      if (!json) return null;
      const log = readLog(json);
      if (!log) return null;
      const body = isObject(json.data) && isObject((json.data as Record<string, unknown>).response) ? ((json.data as Record<string, unknown>).response as Record<string, unknown>).body : undefined;
      return { log, response: body ?? null };
    },

    async findLogs({ userId, fromMs, toMs }) {
      const json = await call('/logs/tool_execution', {
        limit: 20,
        filters: [{ field: 'user_id', operator: '==', value: userId }],
        time_range: { from: fromMs, to: toMs },
      });
      const rows = Array.isArray(json.logs) ? (json.logs as Record<string, unknown>[]) : [];
      return rows.map(readLog).filter((entry): entry is InstantLog => entry !== null);
    },

    async tool(slug) {
      const json = await call(`/tools/${encodeURIComponent(slug)}?toolkit_versions=latest&include_pricing=true`, null).catch((error) => {
        if (error instanceof AdapterError && /answered 404/.test(error.message)) return null;
        throw error;
      });
      if (!json) return null;
      const price = isObject(json.instant) && isObject((json.instant as Record<string, unknown>).price) ? ((json.instant as Record<string, unknown>).price as Record<string, unknown>) : null;
      return {
        slug: str(json.slug) ?? slug,
        toolkit: isObject(json.toolkit) ? str((json.toolkit as Record<string, unknown>).slug) : null,
        description: str(json.description),
        inputSchema: json.input_parameters ?? null,
        instantSupported: isObject(json.instant) && (json.instant as Record<string, unknown>).supported === true,
        priceWords: str(price?.description),
      };
    },

    async sessionInstant(sessionId) {
      const json = await call(`/tool_router/session/${encodeURIComponent(sessionId)}`, null).catch((error) => {
        if (error instanceof AdapterError && /answered 404/.test(error.message)) return null;
        throw error;
      });
      if (!json) return 'gone';
      const config = isObject(json.config) ? (json.config as Record<string, unknown>) : {};
      // `instant` is always `false` or a policy object (the provider's docs): only an explicit false is a denial
      return config.instant === false ? 'denied' : 'allowed';
    },

    async denySessionInstant(sessionId) {
      const response = await send(`${base}/tool_router/session/${encodeURIComponent(sessionId)}`, () => ({
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey },
        body: JSON.stringify({ instant: false }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      }));
      if (response.status === 404) return 'gone';
      const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !json) throw new AdapterError('provider', `Provider answered ${response.status}`);
      // Whatever it says, it is trusted only once it reads back as denied
      const config = isObject(json.config) ? (json.config as Record<string, unknown>) : {};
      if (config.instant !== false) throw new AdapterError('provider', 'The session still allows Instant after the change');
      return 'denied';
    },
  };

  return {
    instant,
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
        // Explicit, never left out: a session with no word about Instant allows it once the project switch is on
        instant: false,
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
      // No account named is a call the provider may serve from Instant (its order is the person's, then a shared one, then Instant)
      if (!providerAccountId) throw new AdapterError('provider', 'A tool run needs the connected account it is for');
      const json = await call(`/tools/execute/${encodeURIComponent(tool)}`, {
        user_id: person,
        connected_account_id: providerAccountId,
        arguments: args,
      });
      return { ok: json.successful === true, data: json.data ?? null, error: str(json.error), providerCallId: str(json.log_id) };
    },

    /** POST /project/usage/tool_calls { from, to, limit } -> { event_count, groups: [{ key, event_count }] } (read live 14 Nov 2026 with the project key). Counts only: no price comes back. `limit` is the most groups returned (1000 at most): a full list may be cut short, and is said to be partial. An unreadable total is an error, never a measured zero. */
    async usage({ fromMs, toMs }) {
      const json = await call('/project/usage/tool_calls', { from: fromMs, to: toMs, limit: USAGE_GROUP_LIMIT });
      const total = readCount(json.event_count);
      if (total === null) throw new AdapterError('provider', 'Composio usage answered without a readable total');
      const rows = Array.isArray(json.groups) ? (json.groups as Record<string, unknown>[]) : [];
      const groups: { key: string; count: number }[] = [];
      let unreadable = json.groups !== undefined && !Array.isArray(json.groups);
      for (const row of rows) {
        const count = readCount(row?.event_count);
        if (typeof row?.key === 'string' && count !== null) groups.push({ key: row.key, count });
        else unreadable = true;
      }
      // A full list may have more behind it, and a row that could not be read is missing too: neither is a tool known to have no calls
      return { toolCalls: total, groups, ...(rows.length >= USAGE_GROUP_LIMIT || unreadable ? { partial: true } : {}) };
    },
  };
}
