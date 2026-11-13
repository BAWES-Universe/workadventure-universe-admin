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
 *  - Link: POST /tool_router/session { user_id, toolkits, workbench: { enable: false } } -> { session_id, mcp: { url } }. The docs show no
 *    headers for that link, so none are sent or stored here; if one is needed it is found out on the first real test, with Khalid's OK.
 *
 * The provider's sandbox (its "workbench" that runs code) is switched off explicitly on every session, never left to its default,
 * which is on.
 */

const BASE = 'https://backend.composio.dev/api/v3.1';

type Fetch = typeof fetch;

export interface ComposioOptions {
  apiKey: string;
  /** The provider's auth config id for each app, from a super admin setting. */
  authConfigFor: (toolkit: string) => Promise<string | null>;
  fetchImpl?: Fetch;
  baseUrl?: string;
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

  return {
    async startConnect({ person, toolkit, returnUrl }): Promise<ConnectStart> {
      const authConfigId = await options.authConfigFor(toolkit);
      if (!authConfigId) throw new AdapterError('provider', `No sign-in set up for ${toolkit}`);
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
      const json = await call('/tool_router/session', { user_id: person, toolkits, workbench: { enable: false } });
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
