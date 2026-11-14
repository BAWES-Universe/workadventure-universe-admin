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
}

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

  constructor(options: ClientOptions) {
    if (!options.key.trim()) throw new Error('The Agent37 key is empty');
    this.key = options.key.trim();
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? wait;
    this.api = options.api ?? AGENT37_API;
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
}
