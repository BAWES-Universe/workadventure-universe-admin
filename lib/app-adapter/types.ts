/**
 * The ready-made apps adapter (game #2001, step 8): an optional outside service that holds sign-ins to many well known apps, so a
 * person taps "Connect" instead of pasting a link. It is HIDDEN and OFF: with no adapter key in Orbit's environment nothing of it
 * shows, no screen names it, and every call here refuses. Turning it on, making any account with the provider, registering sign-in
 * apps with Google or others, and spending money all need Khalid's own OK.
 *
 * Orbit talks to it only through this interface, so a fake stands in for tests and the real one can be swapped out.
 */

export interface ConnectStart {
  /** Where the person signs in, on the provider's own page. */
  redirectUrl: string;
  /** The provider's id for the connection being made, kept so the return can be matched. */
  providerAccountId: string;
  expiresAt: string | null;
}

export interface AppLink {
  /** The person's own app link at the provider (one per person), plugged into the same connection of step 2. */
  url: string;
}

export interface LinkAnswer {
  status: number;
  contentType: string | null;
  /** The link's session header, to send back on the next message. */
  sessionId: string | null;
  /** The answer as the link sent it (JSON, or an event stream holding it). */
  body: string;
}

export interface UseResult {
  ok: boolean;
  data: unknown;
  /** Shown to nobody: kept for the books and for finding a fault. */
  error: string | null;
  /** The provider's own id for this call, kept in the meter event's detail. */
  providerCallId: string | null;
}

/** How one Instant run came back (see `InstantAdapter.run`). */
export type InstantCall =
  /** Composio answered the run. `successful` is its own word for whether the tool worked; `chargeMicros` is the charge it reported with the answer, when it did (null: not reported, never zero). */
  | { kind: 'done'; successful: boolean; data: unknown; error: string | null; logId: string | null; chargeMicros: number | null }
  /** Composio refused before anything ran (not signed in, the balance is empty, Instant is not switched on for the tool, rate limited): nothing was charged. `code` is Composio's own error slug. */
  | { kind: 'rejected'; status: number; code: string | null }
  /** Composio answered that the request was not a valid one (bad arguments, no such tool): it did not run, and its log of the refusal is what decides whether anything was charged. */
  | { kind: 'invalid'; status: number; code: string | null }
  /** No readable answer (a timeout, a broken connection, a server error): it may have run and may have been charged. */
  | { kind: 'unclear'; why: 'timeout' | 'network' | 'server' | 'unreadable'; status: number | null };

/** One line of Composio's execution log, as far as the executor reads it. */
export interface InstantLog {
  id: string;
  /** Composio's own word: success or failed (anything else reads as unknown). */
  status: 'success' | 'failed' | 'unknown';
  /** The charge on the line (`metadata.instant_charge`) in micros; null when the line has none, which is never read as free. */
  chargeMicros: number | null;
  credentialSource: string | null;
  tool: string | null;
  userId: string | null;
  atMs: number | null;
}

/** What the executor needs of Composio for Instant runs (spec O2). Optional on the adapter: an adapter without it cannot run Instant. */
export interface InstantAdapter {
  /**
   * One Instant run, sent on purpose through the Instant account (`connected_account_id: "instant_account"`, never a session, never the
   * MCP link): the only way an Instant tool is ever run. `runUserId` is the opaque id the run goes out under, so its log can be found
   * by it exactly. A refused or unreadable answer is a value, not an error, so the caller always knows which of the four it is.
   */
  run(input: { runUserId: string; tool: string; arguments: Record<string, unknown> }): Promise<InstantCall>;
  /** One execution log line by its id, or null when there is none. Throws when Composio cannot be asked. */
  log(logId: string): Promise<{ log: InstantLog; response: unknown } | null>;
  /** The log lines a run id produced (it is the filter), newest first. Throws when Composio cannot be asked. */
  findLogs(input: { userId: string; fromMs: number; toMs: number }): Promise<InstantLog[]>;
  /** Composio's own listing of one tool with its Instant pricing words, for the schema a Brick needs and for the price drift check; null when there is no such tool. */
  tool(slug: string): Promise<{ slug: string; toolkit: string | null; description: string | null; inputSchema: unknown; instantSupported: boolean; priceWords: string | null } | null>;
  /** Whether an app link's session lets Instant run: `denied`, `allowed`, or `gone` when Composio has no such session. */
  sessionInstant(sessionId: string): Promise<'denied' | 'allowed' | 'gone'>;
  /** Switches Instant off on a session that is already there. `gone` when Composio has no such session. */
  denySessionInstant(sessionId: string): Promise<'denied' | 'gone'>;
}

export interface ReadyMadeAdapter {
  /** The Instant executor's side of the provider. Absent on an adapter that cannot run Instant. */
  instant?: InstantAdapter;
  /** Starts a person's sign-in to one app on the provider's own page. `person` is our id for them, never their email. `authConfigId` is the sign-in setup already read by the caller (null: the provider's managed one); left out, the adapter reads the setting itself. A caller holding a database transaction passes it so no second connection is taken from the pool. */
  startConnect(input: { person: string; toolkit: string; returnUrl: string; authConfigId?: string | null }): Promise<ConnectStart>;
  /** Whether the person finished signing in for a connection started by `startConnect`: `active` once they did, `pending` while the page is still open, `failed` when it expired or was refused. */
  connectionStatus(input: { providerAccountId: string }): Promise<'active' | 'pending' | 'failed'>;
  /** The person's own app link at the provider. `accounts` pins each toolkit to the one connected account the person last signed in with, so a link never reaches an older account of theirs. The provider's code-running sandbox is ON in whatever it makes (the owner's rule: nothing ships off); it works only on data from the person's own connected apps, and each run is counted like an app step by the bot server. */
  appLink(input: { person: string; toolkits: string[]; accounts?: Record<string, string> }): Promise<AppLink>;
  /**
   * One message of the app link's own protocol (a JSON-RPC message), sent to a person's app link WITH the provider key, which the
   * link needs on every call and which must never leave Orbit: not to a Brick, not to the bot server, not to a screen. `sessionId`
   * is the link's own session header from an earlier answer, when it gave one.
   */
  callLink(input: { url: string; message: Record<string, unknown>; sessionId: string | null }): Promise<LinkAnswer>;
  /** One use of one app tool for one person. `callId` makes a retry the same call. */
  use(input: { person: string; toolkit: string; tool: string; arguments: Record<string, unknown>; providerAccountId: string | null; callId: string }): Promise<UseResult>;
  /** The provider's own count of tool calls for our project over a range (epoch milliseconds, end excluded), by tool name (`partial`: the by-tool list is cut short, so a tool missing from it is not known to be zero). Optional: the monthly check says it could not run when an adapter has none. */
  usage?(input: { fromMs: number; toMs: number }): Promise<{ toolCalls: number; groups: { key: string; count: number }[]; partial?: boolean }>;
}

/** Thrown for anything the adapter will not do (it is off, or the provider refused). The text is for logs; a person sees nothing of it. */
export class AdapterError extends Error {
  constructor(
    readonly kind: 'off' | 'provider',
    message: string,
  ) {
    super(message);
  }
}
