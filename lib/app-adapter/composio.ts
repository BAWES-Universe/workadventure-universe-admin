import { AdapterError, type AppLink, type ConnectStart, type ReadyMadeAdapter, type UseResult } from '@/lib/app-adapter/types';

/**
 * The real adapter, written from the provider's live docs (docs.composio.dev, read 12 Nov 2026), wired but never switched on
 * here. It is built only when COMPOSIO_API_KEY is set in Orbit's environment (lib/app-adapter/index.ts), and nothing sets it.
 *
 *  - API: https://backend.composio.dev/api/v3.1, header `x-api-key`.
 *  - Connect: POST /connected_accounts/link { auth_config_id, user_id, callback_url } -> { redirect_url, connected_account_id, expires_at }.
 *    The auth config is one per app, kept in a super admin setting (never in code) and passed in as the toolkit's config id.
 *  - Status: GET /connected_accounts/{id} -> { status: ACTIVE | INITIALIZING | INITIATED | FAILED | EXPIRED | INACTIVE }. Only ACTIVE reads as connected.
 *  - Use: POST /tools/execute/{tool_slug} { user_id, connected_account_id, arguments } -> { data, successful, error, log_id }.
 *  - Link: POST /tool_router/session { user_id, toolkits: { enable: [...] }, workbench: { enable: true } } -> { session_id, mcp: { url } }. The docs show no
 *    headers for that link, so none are sent or stored here; if one is needed it is found out on the first real test, with Khalid's OK.
 *
 *  - Sign-in setup: with no auth config chosen by a super admin, the provider's own managed one for the app is used: found with
 *    GET /auth_configs?toolkit_slug&is_composio_managed, or made with POST /auth_configs { toolkit: { slug } } (its default is
 *    Composio-managed auth), so nobody registers anything with Google or others and nothing needs setting up.
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
}

/** The managed auth config found or made for each app, kept for the life of the process. */
const managedAuthConfigs = new Map<string, string>();

/** For tests. */
export function forgetManagedAuthConfigs(): void {
  managedAuthConfigs.clear();
}

export function createComposioAdapter(options: ComposioOptions): ReadyMadeAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE;

  async function call(path: string, body: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const response = await doFetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-api-key': options.apiKey },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
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
    async startConnect({ person, toolkit, returnUrl }): Promise<ConnectStart> {
      const authConfigId = (await options.authConfigFor(toolkit)) ?? (await managedAuthConfig(toolkit));
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

    async appLink({ person, toolkits }): Promise<AppLink> {
      const json = await call('/tool_router/session', { user_id: person, toolkits: { enable: toolkits }, workbench: { enable: true } });
      const mcp = json.mcp && typeof json.mcp === 'object' ? (json.mcp as Record<string, unknown>) : {};
      const url = str(mcp.url);
      if (!url) throw new AdapterError('provider', 'Provider sent no app link');
      const sent = mcp.headers && typeof mcp.headers === 'object' && !Array.isArray(mcp.headers) ? (mcp.headers as Record<string, unknown>) : {};
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(sent)) if (typeof value === 'string') headers[name] = value;
      return { url, headers };
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
