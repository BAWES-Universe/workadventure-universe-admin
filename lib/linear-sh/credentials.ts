import { Settings, MCP_URL } from "./config";

type Connection = {
  id: string;
  botId: string;
  enabled: boolean;
  serverUrl: string;
  authType: string;
  authConfig: string | null;
};
type Fetch = typeof fetch;
/** One app token per service run, renewed before expiry; never persisted or returned to a browser. */
export class AppCredentials {
  private cached?: { key: string; token: string; expires: number };
  private pending?: Promise<string>;
  constructor(
    private load: (id: string) => Promise<Connection | null>,
    private decrypt: (text: string) => string,
    private http: Fetch = fetch,
    private now = Date.now,
  ) {}
  invalidate() {
    this.cached = undefined;
  }
  async token(config: Settings): Promise<string> {
    // Load on every request so disabling/rotating the connection invalidates cached tokens.
    const row = await this.load(config.connectionId);
    if (
      !row ||
      row.id !== config.connectionId ||
      row.botId !== config.botId ||
      !row.enabled ||
      row.serverUrl !== MCP_URL ||
      row.authType !== "bearer" ||
      !row.authConfig
    )
      throw new Error("Application connection unavailable");
    const key = `${row.authConfig}:${config.workspaceId}:${config.appActorId}:${config.writesEnabled}`;
    if (this.cached?.key === key && this.cached.expires > this.now() + 60000)
      return this.cached.token;
    // Concurrent config changes must not borrow a token from a different configuration.
    if (this.pending) {
      await this.pending;
      return this.token(config);
    }
    this.pending = this.issue(row, config, key);
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  private async issue(row: Connection, config: Settings, key: string) {
    const parsed = JSON.parse(this.decrypt(row.authConfig!));
    const app = parsed.linearSh;
    if (
      !app ||
      typeof app.clientId !== "string" ||
      typeof app.clientSecret !== "string" ||
      !app.clientId ||
      !app.clientSecret
    )
      throw new Error("Managed application credentials required");
    // Use read-only scope for read acceptance; explicit write activation adds the editing scope.
    const scope = config.writesEnabled ? "read,write" : "read";
    const response = await this.http("https://api.linear.app/oauth/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: app.clientId,
        client_secret: app.clientSecret,
        scope,
      }),
    });
    if (!response.ok) throw new Error("Application authorization unavailable");
    const result = await response.json();
    const scopes = Array.isArray(result.scope)
      ? result.scope
      : String(result.scope || "").split(/[ ,]+/);
    if (
      result.token_type?.toLowerCase() !== "bearer" ||
      typeof result.access_token !== "string" ||
      !result.access_token ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 60 ||
      !scopes.includes("read") ||
      (config.writesEnabled && !scopes.includes("write")) ||
      scopes.some((v: string) => !["read", "write"].includes(v))
    )
      throw new Error("Invalid application grant");
    const data = await this.graph<{
      viewer: { id: string };
      organization: { id: string };
    }>(result.access_token, "{ viewer { id } organization { id } }", {});
    if (
      data.viewer?.id !== config.appActorId ||
      data.organization?.id !== config.workspaceId
    )
      throw new Error("Application actor or workspace mismatch");
    this.cached = {
      key,
      token: result.access_token,
      expires: this.now() + result.expires_in * 1000,
    };
    return result.access_token as string;
  }
  async graph<T = unknown>(
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    // Fixed internal identity/ACL queries only. No arbitrary GraphQL is exposed to employees/models.
    const response = await this.http("https://api.linear.app/graphql", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status === 401) this.invalidate();
    if (!response.ok) throw new Error("Linear identity unavailable");
    const result = await response.json();
    if (result.errors || !result.data)
      throw new Error("Linear identity unavailable");
    return result.data;
  }
}
