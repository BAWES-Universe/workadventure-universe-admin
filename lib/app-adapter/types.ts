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

export interface ReadyMadeAdapter {
  /** Starts a person's sign-in to one app on the provider's own page. `person` is our id for them, never their email. */
  startConnect(input: { person: string; toolkit: string; returnUrl: string }): Promise<ConnectStart>;
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
