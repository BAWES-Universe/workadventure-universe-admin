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

/** An answer that says more is to come: a next page or cursor, a "more" flag, or a total larger than what came. */
export function morePages(answer: Record<string, unknown>, got: number): boolean {
  const said = ['next', 'next_cursor', 'nextCursor', 'next_page', 'nextPage', 'cursor', 'has_more', 'hasMore', 'more'];
  if (said.some((key) => !!answer[key])) return true;
  const links = answer.links as Record<string, unknown> | undefined;
  if (links && typeof links === 'object' && !!links.next) return true;
  const pagination = answer.pagination as Record<string, unknown> | undefined;
  if (pagination && typeof pagination === 'object' && (!!pagination.next || !!pagination.next_cursor || pagination.has_more === true)) return true;
  return ['total', 'count', 'total_count'].some((key) => typeof answer[key] === 'number' && (answer[key] as number) > got);
}
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
  /** The revision of the template this machine's image came from; behind the template's own revision means it can be updated. */
  template_revision?: number | null;
  /** What the machine may reach on the internet, as Agent37 stored it (domains are lowercased, a bare address becomes /32). Not every answer carries it. */
  network?: NetworkPolicy | null;
}

/** A cloud build of a template: `succeeded` carries the revision it published. */
export interface TemplateBuild {
  status: 'created' | 'building' | 'ingesting' | 'succeeded' | 'failed' | string;
  /** The last of the build's log, for the one who looks when it failed. */
  log: string;
  error: { code: string | null; message: string } | null;
  template: { revision: number | null; imageDigest: string | null } | null;
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

/** What Agent37 billed for one UTC day (`GET /v1/usage`, docs agents-api/billing): whole micros, by instance. Managed spend is `totalMicros - computeMicros`. */
export interface UsageDay {
  day: string;
  totalMicros: number;
  instances: { id: string; totalMicros: number; computeMicros: number; awakeMinutes: number }[];
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

/** A turn was never sent to the agent: the machine could not be found (before any request to the agent was made). */
export class TurnNotSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnNotSent';
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
/** The whole of a folder's archive, from the request to the last byte: a machine that stops answering ends the save at this. */
const ARCHIVE_TIMEOUT_MS = 20 * 60_000;
const RETRY_WAITS_MS = [1_000, 3_000, 8_000];
/** Which answers a stop or a sleep is asked again after: `any` (a gateway's too, for a restart under a wake's own ticket) or `refused` (only an answer that says it was NOT taken: a power operation of ours, whose earlier attempt must not be hidden). */
export type Retry = 'any' | 'refused';
/**
 * The longest one asked-again account call can take from its first request to its last answer: every attempt runs to its timeout and every wait between them is taken. A power operation (stop, sleep) whose sender died
 * (post-0.5.0 B) is counted as still able to land for this long after its last beat, on top of a margin for the provider's own processing (lib/computer-power.ts).
 */
export const LONGEST_ACCOUNT_CALL_MS = REQUEST_TIMEOUT_MS * (RETRY_WAITS_MS.length + 1) + RETRY_WAITS_MS.reduce((sum, ms) => sum + ms, 0);

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
  private async call<T>(method: string, url: string, headers: Record<string, string>, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS, jsonRequired = false): Promise<T> {
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
    let unreadable = false;
    const text = await response.text().catch(() => {
      unreadable = true;
      return '';
    });
    // An answer whose body could not be read says nothing: it is not read as an empty one (a check would take it for "idle")
    if (unreadable && response.ok) throw new Agent37Unreached('body');
    let json: unknown = null;
    // Text that does not parse is malformed, whatever it holds (a page, a cut-off answer, only whitespace); no text at all is no answer either
    let malformed = text.trim() === '';
    try {
      json = text.trim() ? JSON.parse(text) : null;
    } catch {
      json = null;
      malformed = true;
    }
    if (!response.ok) {
      const { code, message } = describe(json);
      throw new Agent37Error(response.status, code, message || `Agent37 answered ${response.status}`);
    }
    // A success whose body is not the JSON that was asked for says nothing (a gateway's page, a cut-off answer): for a question where
    // "no answer" would read as an answer, it is not reached, never taken for an empty one
    // (An empty body, `null`, a list or anything that is not an object is as little as a cut-off one: the check would read it as "no turn running")
    if (jsonRequired && (malformed || !json || typeof json !== 'object' || Array.isArray(json))) throw new Agent37Unreached('body');
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

  /**
   * For a power POST (a stop or a sleep): asked again only after an answer that says it was NOT taken: a 429 from Agent37's edge (a rate limit refuses the request before it reaches the machine). Everything else is thrown, and the caller
   * (`stopAtProvider`) keeps the power operation open for the provider's margin, as it does for a call that got no answer: a gateway's 502, 503 or 504 may have come after the request reached the machine, and Agent37's own `try_again` is not known to
   * mean "refused" either (on the network settings a 503 `try_again` means the change WAS saved and applies within two minutes). A repeat that then succeeded would have hidden the earlier attempt, and the operation would have been closed while
   * that one could still land (CodeRabbit on #1040).
   */
  private async againPower<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const last = attempt >= RETRY_WAITS_MS.length;
        if (last || !(error instanceof Agent37Error && error.status === 429)) throw error;
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
    return this.again(() => this.look(id));
  }

  /** One look at an instance with its own short timeout and never asked again: for a caller that must answer within a few seconds (a job's renewal, post-0.5.0 B). */
  getInstanceOnce(id: string, timeoutMs: number): Promise<Instance> {
    return this.look(id, timeoutMs);
  }

  /**
   * The one look at an instance. An answer that is not an object naming the machine's status (`{}`, a gateway's page, a list) says nothing about it: it is not reached, never read as "not running", which would prove a
   * stop that never took and end a billed stretch (CodeRabbit on #1036). Both the asked-again look and the single one come through here.
   */
  private async look(id: string, timeoutMs?: number): Promise<Instance> {
    const instance = await this.call<Instance>('GET', `${this.api}/v1/instances/${encodeURIComponent(id)}`, this.account(), undefined, timeoutMs, true);
    if (typeof instance.status !== 'string') throw new Agent37Unreached('status');
    return instance;
  }

  /** Newest first. The docs say nothing about pages, so this is the newest instances: enough to find one that was just made. */
  async listInstances(): Promise<Instance[]> {
    return this.listed(await this.again(() => this.call<{ data?: Instance[]; [more: string]: unknown }>('GET', `${this.api}/v1/instances`, this.account())));
  }

  /** The same list from ONE request with its own short timeout and never asked again: for the sweep's look for a machine that runs behind a row that says it is stopped (it never waits on Agent37, and skips a pass that gets no clean answer). */
  async listInstancesOnce(timeoutMs: number): Promise<Instance[]> {
    return this.listed(await this.call<{ data?: Instance[]; [more: string]: unknown }>('GET', `${this.api}/v1/instances`, this.account(), undefined, timeoutMs));
  }

  private listed(answer: { data?: Instance[]; [more: string]: unknown } | null): Instance[] {
    // An answer with no list in it (an empty body, `{}`, a page that is not the list) says nothing: it is not read as an account with no machines,
    // which would let a make look for its machine in nothing and a purge call a Brick clear without looking
    if (!answer || typeof answer !== 'object' || !Array.isArray(answer.data)) throw new Error('Agent37 did not answer with a list of machines');
    const rows = answer.data;
    // The answer is the whole account (checked 18 Nov against the account: the answer is only `data`, newest first, each machine with `created`, and `limit`, `page`, `cursor` and `offset` change nothing). If Agent37 ever says more is to come, a list that is
    // not all of it must not pass for all of it: a make would look for its machine in it, and a purge would call a Brick clear
    if (morePages(answer, rows.length)) throw new Error('Agent37 says the list of machines is only part of them');
    return rows;
  }

  /** Starts a stopped instance or wakes a sleeping one. 200 when done, 202 while a host move finishes: either way, look again. */
  startInstance(id: string): Promise<{ id: string; status: string }> {
    return this.again(() => this.call('POST', `${this.api}/v1/instances/${encodeURIComponent(id)}/start`, this.account()));
  }

  /** Sleeps a running instance now: memory and processes are kept, the disk is kept, only the disk is billed. */
  sleepInstance(id: string, retry: Retry = 'any'): Promise<{ id: string; status: string }> {
    const run = () => this.call<{ id: string; status: string }>('POST', `${this.api}/v1/instances/${encodeURIComponent(id)}/sleep`, this.account());
    return retry === 'refused' ? this.againPower(run) : this.again(run);
  }

  /** Halts the container: memory is lost, the disk is kept, and it stays down until started. */
  stopInstance(id: string, retry: Retry = 'any'): Promise<{ id: string; status: string }> {
    const run = () => this.call<{ id: string; status: string }>('POST', `${this.api}/v1/instances/${encodeURIComponent(id)}/stop`, this.account());
    return retry === 'refused' ? this.againPower(run) : this.again(run);
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

  /**
   * One UTC day of Agent37's bill, by instance: what they charged and how many minutes each machine was awake. Read-only, so safe to ask
   * again. A day that is not a date, or an answer with no total, is refused rather than read as "nothing was billed".
   */
  async usageForDay(day: string): Promise<UsageDay> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error('A usage day must be a date (YYYY-MM-DD)');
    const answer = await this.again(() => this.call<Record<string, unknown>>('GET', `${this.api}/v1/usage?from=${day}&to=${day}`, this.account()));
    const whole = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
    const total = whole(answer?.total_micros);
    if (total === null || !Array.isArray(answer?.instances)) throw new Agent37Error(502, null, 'Agent37 answered usage with no total');
    const instances: UsageDay['instances'] = [];
    for (const raw of answer.instances as Array<Record<string, unknown>>) {
      const id = typeof raw?.id === 'string' ? raw.id : null;
      const entryTotal = whole(raw?.total_micros);
      if (!id || entryTotal === null) continue;
      instances.push({ id, totalMicros: entryTotal, computeMicros: whole(raw.compute_micros) ?? entryTotal, awakeMinutes: whole(raw.awake_minutes) ?? 0 });
    }
    return { day, totalMicros: total, instances };
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
  async archive(instanceUrl: string, signal: AbortSignal = AbortSignal.timeout(ARCHIVE_TIMEOUT_MS)): Promise<Response> {
    let response: Response;
    try {
      // The signal stays on the body as it streams: a machine that stops answering halfway ends the save instead of holding it for ever
      response = await this.fetchImpl(`${instanceUrl.replace(/\/+$/, '')}/v1/files/archive`, { method: 'GET', headers: this.own(), signal });
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
    const answer = await this.again(() => this.call<{ active_response_id?: string | null }>('GET', `${instanceUrl.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}`, this.own(), undefined, 20_000, true));
    return typeof answer?.active_response_id === 'string' && answer.active_response_id ? answer.active_response_id : null;
  }

  /**
   * Starts a cloud build of a template (free; the build runs on Agent37). The context is a gzipped folder with a Dockerfile at its root:
   * it is told its size here, uploaded to the address given, and then started.
   */
  async createTemplateBuild(input: { name: string; sizeBytes: number; defaultPort?: number }): Promise<{ id: string; uploadUrl: string }> {
    const answer = await this.call<{ id?: string; upload_url?: string }>('POST', `${this.api}/v1/template-builds`, this.account(), {
      name: input.name,
      size_bytes: input.sizeBytes,
      ...(input.defaultPort !== undefined ? { default_port: input.defaultPort } : {}),
    });
    if (typeof answer?.id !== 'string' || typeof answer?.upload_url !== 'string') throw new Agent37Error(502, null, 'Agent37 answered a build with no id');
    return { id: answer.id, uploadUrl: answer.upload_url };
  }

  /** Puts the gzipped context where Agent37 said. The address carries its own permission: no account key goes with it. */
  async uploadTemplateContext(uploadUrl: string, bytes: Uint8Array): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(bytes.length) }, body: bytes as unknown as BodyInit, signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new Agent37Unreached(error instanceof Error ? error.name : 'unknown');
    }
    if (!response.ok) throw new Agent37Error(response.status, null, `The build context was refused with ${response.status}`);
  }

  startTemplateBuild(buildId: string): Promise<unknown> {
    return this.again(() => this.call('POST', `${this.api}/v1/template-builds/${encodeURIComponent(buildId)}/start`, this.account()));
  }

  /** Where a build stands (its log from the start is read each time and only its end kept). */
  async templateBuild(buildId: string): Promise<TemplateBuild> {
    const answer = await this.again(() =>
      this.call<{ status?: string; data?: string; error?: { code?: string; message?: string } | null; template?: { revision?: number; image_digest?: string } | null }>(
        'GET',
        `${this.api}/v1/template-builds/${encodeURIComponent(buildId)}/logs?offset=0`,
        this.account(),
      ),
    );
    return {
      status: typeof answer?.status === 'string' ? answer.status : 'created',
      log: typeof answer?.data === 'string' ? answer.data.slice(-2000) : '',
      error: answer?.error ? { code: typeof answer.error.code === 'string' ? answer.error.code.slice(0, 60) : null, message: typeof answer.error.message === 'string' ? answer.error.message.slice(0, 300) : '' } : null,
      template: answer?.template ? { revision: typeof answer.template.revision === 'number' ? answer.template.revision : null, imageDigest: typeof answer.template.image_digest === 'string' ? answer.template.image_digest : null } : null,
    };
  }

  /** Moves a machine to the template's current image. Its home folder (where the files are) is kept; the rest of the disk is replaced. */
  updateInstance(id: string): Promise<{ id: string; status: string; template_revision?: number }> {
    return this.again(() => this.call('POST', `${this.api}/v1/instances/${encodeURIComponent(id)}/update`, this.account()));
  }

  /** What the machine may reach on the internet. A 503 `try_again` means it is saved and reaches the machine within two minutes: asked again, it confirms. */
  setNetwork(id: string, network: NetworkPolicy): Promise<Instance> {
    return this.again(() => this.call('PATCH', `${this.api}/v1/instances/${encodeURIComponent(id)}`, this.account(), { network }));
  }

  /**
   * A machine's managed budget as Agent37 holds it (`GET /v1/instances/{id}/budget`, docs agents-api/budgets): the monthly cap, what is left of
   * the month, and what is left of the ONE-TIME credit. Agent37's managed services (model router, Brave, Composio, Perflo) can spend from either.
   * A number that is not there is read as "not zero", so a changed answer never looks closed.
   */
  async getBudget(id: string): Promise<{ monthlyCapMicros: number; monthlyRemainingMicros: number; creditRemainingMicros: number }> {
    const answer = await this.again(() => this.call<Record<string, unknown>>('GET', `${this.api}/v1/instances/${encodeURIComponent(id)}/budget`, this.account()));
    const micros = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER);
    return { monthlyCapMicros: micros(answer?.monthly_cap_micros), monthlyRemainingMicros: micros(answer?.monthly_remaining_micros), creditRemainingMicros: micros(answer?.credit_remaining_micros) };
  }

  /** Sets the monthly cap (`PATCH /v1/instances/{id}/budget`); it takes effect at once. The one-time credit has no call that lowers it. */
  setMonthlyCap(id: string, micros: number): Promise<unknown> {
    return this.again(() => this.call('PATCH', `${this.api}/v1/instances/${encodeURIComponent(id)}/budget`, this.account(), { monthly_cap_micros: micros }));
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
