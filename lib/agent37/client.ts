/**
 * Agent37's API (agent37.com/docs/agents-api, read 14 Nov 2026), one small client with no rules of ours in it.
 *
 * Three doors, and which key goes where is easy to get wrong:
 *  - the account (`https://api.agent37.com`): the account key as `Authorization: Bearer`. Make, start, sleep, stop, delete, billing, signed links.
 *  - one computer's own address (`https://{id}.agent37.app`): the same key as `X-Agent37-Key`. Health, files.
 *  - nothing else. The key never leaves Orbit, and no message or error made here carries it.
 *
 * Shapes are copied from the docs and from the 13 Nov check on a real machine. Where the docs say nothing, the code says so.
 */

export const AGENT37_API = 'https://api.agent37.com';
/** Where commands run: the instance address is for the agent, this one is for the machine. Signed links cannot authorize it. */
export const AGENT37_SANDBOX = 'https://sandbox.agent37.app';

/** The states of an instance, as Agent37 names them. */
export type InstanceStatus = 'provisioning' | 'running' | 'stopping' | 'stopped' | 'starting' | 'restarting' | 'updating' | 'sleeping' | 'waking' | 'failed' | 'deleting' | 'deleted';

export interface Instance {
  id: string;
  status: InstanceStatus | string;
  url: string;
  region?: string;
  resources?: { cpu: number; memory: number; disk: number };
  metadata?: Record<string, unknown> | null;
  /** Epoch seconds; present only while sleeping or waking. */
  slept_at?: number | null;
  past_due?: boolean;
}

export interface CreateInstance {
  template: string;
  name?: string;
  type?: 'default' | 'performance' | 'vm';
  region?: 'us' | 'eu' | 'ap-south';
  resources?: { cpu: number; memory: number; disk: number };
  metadata?: Record<string, string>;
  env?: Record<string, string>;
  budget?: { monthly_cap_micros?: number; credit_micros?: number };
  auto_sleep?: boolean;
  idle_timeout_seconds?: number;
  network?: 'allow-all' | 'deny-all' | { allow: string[] };
}

export interface Billing {
  balance_usd: number;
  past_due: boolean;
  tier?: number;
  instance_limit?: number;
  auto_top_up?: { enabled: boolean } | null;
}

/** An answer that was not a success. `code` is Agent37's own word for it (`try_again`, `insufficient_balance`...), when it gave one. */
export class Agent37Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /** Only for `session_busy`: the turn that is running, so a caller can reattach to it instead of starting another. */
    readonly runningResponseId: string | null = null,
  ) {
    super(message);
    this.name = 'Agent37Error';
  }
  /** Safe to ask again: Agent37 said so, or it was a gateway hiccup. */
  get retryable(): boolean {
    return this.code === 'try_again' || this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

/** The call never got an answer (no connection, or it took too long). What it did at Agent37 is not known. */
export class Agent37Unreached extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Agent37Unreached';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  key: string;
  fetchImpl?: FetchLike;
  /** For tests: how a wait is made. */
  sleep?: (ms: number) => Promise<void>;
  api?: string;
  sandbox?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Either stream went over Agent37's 512 KB cap and its middle was cut out. */
  truncated: boolean;
  /** Only for a command run in the background. */
  pid?: number;
}

export type NetworkPolicy = 'allow-all' | 'deny-all' | { allow: string[] };

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_WAITS_MS = [1_000, 3_000, 8_000];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Agent37's error body is not documented to one shape: a code and a message can be at the top or under `error`. Only short plain words are kept. */
function describe(body: unknown): { code: string | null; message: string } {
  const record = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<string, unknown>;
  const inner = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : record;
  const code = typeof inner.code === 'string' ? inner.code : typeof record.error === 'string' ? record.error : null;
  const message = typeof inner.message === 'string' ? inner.message : typeof record.message === 'string' ? record.message : '';
  return { code: code ? code.slice(0, 60) : null, message: message.slice(0, 200) };
}

export class Agent37Client {
  private readonly key: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly api: string;
  private readonly sandbox: string;

  constructor(options: ClientOptions) {
    if (!options.key.trim()) throw new Error('The Agent37 key is empty');
    this.key = options.key.trim();
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? wait;
    this.api = options.api ?? AGENT37_API;
    this.sandbox = options.sandbox ?? AGENT37_SANDBOX;
  }

  /** One call, one answer. Throws Agent37Error for an answer that is not a success and Agent37Unreached when there was none. */
  private async call<T>(method: string, url: string, headers: Record<string, string>, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Agent37Unreached(error instanceof Error ? error.name : 'unknown');
    }
    const text = await response.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const { code, message } = describe(json);
      throw new Agent37Error(response.status, code, message || `Agent37 answered ${response.status}`);
    }
    return json as T;
  }

  /** For calls that are safe to repeat: waits and asks again when Agent37 says `try_again` or a gateway answers badly. */
  private async again<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const last = attempt >= RETRY_WAITS_MS.length;
        if (last || !(error instanceof Agent37Error && error.retryable)) throw error;
        await this.sleep(RETRY_WAITS_MS[attempt]);
      }
    }
  }

  private account = () => ({ Authorization: `Bearer ${this.key}` });
  private own = () => ({ 'X-Agent37-Key': this.key });

  /** Make an instance. NOT repeated here: after an answer that was lost, the caller looks the instance up first. */
  createInstance(input: CreateInstance): Promise<Instance> {
    return this.call('POST', `${this.api}/v1/instances`, this.account(), input, 120_000);
  }

  getInstance(id: string): Promise<Instance> {
    return this.again(() => this.call('GET', `${this.api}/v1/instances/${encodeURIComponent(id)}`, this.account()));
  }

  /** Newest first. The docs say nothing about pages, so this is the newest instances: enough to find one that was just made. */
  async listInstances(): Promise<Instance[]> {
    const answer = await this.again(() => this.call<{ data?: Instance[] }>('GET', `${this.api}/v1/instances`, this.account()));
    return Array.isArray(answer?.data) ? answer.data : [];
  }

  /** Starts a stopped instance or wakes a sleeping one. 200 when done, 202 while a host move finishes: either way, look again. */
  startInstance(id: string): Promise<{ id: string; status: string }> {
    return this.again(() => this.call('POST', `${this.api}/v1/instances/${encodeURIComponent(id)}/start`, this.account()));
  }

  /** Sleeps a running instance now: memory and processes are kept, the disk is kept, only the disk is billed. */
  sleepInstance(id: string): Promise<{ id: string; status: string }> {
    return this.again(() => this.call('POST', `${this.api}/v1/instances/${encodeURIComponent(id)}/sleep`, this.account()));
  }

  /** Halts the container: memory is lost, the disk is kept, and it stays down until started. */
  stopInstance(id: string): Promise<{ id: string; status: string }> {
    return this.again(() => this.call('POST', `${this.api}/v1/instances/${encodeURIComponent(id)}/stop`, this.account()));
  }

  /** Deletes for good, disk included. */
  deleteInstance(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.again(() => this.call('DELETE', `${this.api}/v1/instances/${encodeURIComponent(id)}`, this.account()));
  }

  /** A link to a port of the instance that works for `ttl` seconds. It is a credential: it goes nowhere but to the one who asked. */
  signedUrl(id: string, port: number, ttlSeconds: number): Promise<{ url: string }> {
    return this.again(() => this.call('POST', `${this.api}/v1/instances/${encodeURIComponent(id)}/signed-url`, this.account(), { port, ttl_seconds: ttlSeconds }));
  }

  /** The wallet. `balance_usd` is dollars. */
  billing(): Promise<Billing> {
    return this.again(() => this.call('GET', `${this.api}/v1/billing`, this.account()));
  }

  /** The agent's own health. It answers 502 for a few seconds after a machine starts, so a caller asks again until `healthy` is true. */
  async healthy(instanceUrl: string): Promise<boolean> {
    try {
      const answer = await this.call<{ healthy?: boolean }>('GET', `${instanceUrl.replace(/\/+$/, '')}/v1/health`, this.own(), undefined, 15_000);
      return answer?.healthy === true;
    } catch {
      return false;
    }
  }

  /**
   * The home folder as a tar.gz, streamed. Any request to a machine's address wakes it: only call this for one that is awake.
   * Returns the response so the caller streams it; a non-200 throws.
   */
  async archive(instanceUrl: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${instanceUrl.replace(/\/+$/, '')}/v1/files/archive`, { method: 'GET', headers: this.own() });
    } catch (error) {
      throw new Agent37Unreached(error instanceof Error ? error.name : 'unknown');
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const { code, message } = describe(json);
      throw new Agent37Error(response.status, code, message || `Agent37 answered ${response.status}`);
    }
    return response;
  }

  /**
   * Runs a shell command on the machine (`sh -c`). A sleeping machine is woken first, so this is only for a machine a job holds. A
   * non-zero exit is an answer, not an error. `name` makes a repeat of the same request return the first result without running the
   * command again (remembered while it runs and for 5 minutes after), which is what makes it safe to ask again after a lost answer.
   * Foreground commands wait up to 15 minutes at Agent37; this waits a little longer and then says it was not reached.
   */
  exec(id: string, command: string, options: { user?: 'root'; background?: boolean; name?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const { timeoutMs = 60_000, ...rest } = options;
    const body: Record<string, unknown> = { command, ...(rest.user ? { user: rest.user } : {}), ...(rest.background ? { background: true } : {}), ...(rest.name ? { name: rest.name } : {}) };
    const run = async (): Promise<ExecResult> => {
      const answer = await this.call<{ exit_code?: number; stdout?: string; stderr?: string; truncated?: boolean; pid?: number }>('POST', `${this.sandbox}/v1/instances/${encodeURIComponent(id)}/exec`, this.own(), body, timeoutMs);
      return {
        exitCode: typeof answer?.exit_code === 'number' ? answer.exit_code : -1,
        stdout: typeof answer?.stdout === 'string' ? answer.stdout : '',
        stderr: typeof answer?.stderr === 'string' ? answer.stderr : '',
        truncated: answer?.truncated === true,
        ...(typeof answer?.pid === 'number' ? { pid: answer.pid } : {}),
      };
    };
    // Asked again only when the request carries a name: without one a repeat would run the command twice
    return rest.name ? this.again(run) : run();
  }

  /**
   * Starts a turn and returns its stream as it comes (`stream: true`). The first byte can wait for the machine to wake, so there is no
   * short timeout: the caller's signal ends it. A non-200 throws (a turn already running in the session is 409 `session_busy`).
   */
  async openTurn(instanceUrl: string, input: { text: string; sessionId?: string | null }, signal?: AbortSignal): Promise<Response> {
    return this.stream('POST', `${instanceUrl.replace(/\/+$/, '')}/v1/responses`, { input: input.text, stream: true, ...(input.sessionId ? { session_id: input.sessionId } : {}) }, signal);
  }

  /** The stream of a turn already running (or just finished): the events so far, then the rest. 404 `response_not_found` once it is old. */
  async reattachTurn(instanceUrl: string, responseId: string, signal?: AbortSignal): Promise<Response> {
    return this.stream('GET', `${instanceUrl.replace(/\/+$/, '')}/v1/responses/${encodeURIComponent(responseId)}/stream`, undefined, signal);
  }

  /** Cancels a turn. It still ends with a completed event holding what it wrote before. A turn that is not there is not an error. */
  async cancelTurn(instanceUrl: string, responseId: string): Promise<void> {
    try {
      await this.again(() => this.call('POST', `${instanceUrl.replace(/\/+$/, '')}/v1/responses/${encodeURIComponent(responseId)}/cancel`, this.own(), {}, 15_000));
    } catch (error) {
      if (error instanceof Agent37Error && (error.status === 404 || error.status === 409)) return;
      throw error;
    }
  }

  /** The id of the turn running in a session, or null when it is idle (or the session is new). */
  async activeTurn(instanceUrl: string, sessionId: string): Promise<string | null> {
    const answer = await this.again(() => this.call<{ active_response_id?: string | null }>('GET', `${instanceUrl.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}`, this.own(), undefined, 20_000));
    return typeof answer?.active_response_id === 'string' && answer.active_response_id ? answer.active_response_id : null;
  }

  /** What the machine may reach on the internet. A 503 `try_again` means it is saved and reaches the machine within two minutes: asked again, it confirms. */
  setNetwork(id: string, network: NetworkPolicy): Promise<Instance> {
    return this.again(() => this.call('PATCH', `${this.api}/v1/instances/${encodeURIComponent(id)}`, this.account(), { network }));
  }

  /** A streamed call: returns the response when it is a 200, so the caller reads the body as it comes. */
  private async stream(method: string, url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { ...this.own(), Accept: 'text/event-stream', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      throw new Agent37Unreached(error instanceof Error ? error.name : 'unknown');
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const { code, message } = describe(json);
      // `session_busy` names the turn that is running, so a caller can reattach to it
      const running = json && typeof json === 'object' && typeof (json as { error?: { response_id?: unknown } }).error?.response_id === 'string' ? (json as { error: { response_id: string } }).error.response_id : null;
      throw new Agent37Error(response.status, code, message || `Agent37 answered ${response.status}`, running);
    }
    return response;
  }
}
