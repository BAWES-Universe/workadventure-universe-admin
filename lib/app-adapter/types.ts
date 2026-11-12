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
  /** Headers the provider says its link needs; empty unless it sent some. Never invented here. */
  headers: Record<string, string>;
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
  /** The person's own app link at the provider. The provider's code-running sandbox is off in whatever it makes. */
  appLink(input: { person: string; toolkits: string[] }): Promise<AppLink>;
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
