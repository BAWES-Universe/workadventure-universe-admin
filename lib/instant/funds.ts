/**
 * Where an Instant run's money comes from: the person's Instant Apps credit, held before the run and charged or released after it.
 *
 * The books for that credit (funding accounts, grants, lots, spending order) are the funding books' (O1). This file is the small
 * door between the two, so the executor never reads or writes a balance itself and the books never learn how an Instant run works.
 * Every call is safe to repeat under the same key.
 *
 * Until the funding books are wired in here (`setInstantFunds`), the door is SHUT: nothing can be held, so no Instant run starts.
 * A shut door is the safe answer, never an open one. Amounts are whole micros of a dollar.
 */

export type HoldRefusal =
  /** The person's Instant Apps credit does not cover it (they can ask for more, or wait for a renewal if they have one). */
  | 'credit_used_up'
  /** A setting the credit cannot be taken without is not set yet. */
  | 'not_set'
  /** The books could not be read or written: nothing was held. */
  | 'unavailable';

export type Hold = { ok: true; created: boolean } | { ok: false; reason: HoldRefusal };

/** How a charge is classed in the books, so nested work is charged once and the provider is on every line. */
export interface ChargeClass {
  class: 'instant';
  route: string;
  provider: string;
  priceVersion?: string | null;
}

/** The most that may be given back, passed on every give-back so the books enforce what a super admin set. */
export interface GiveBackLimits {
  giveBackMaxMicros?: number | null;
  goodwillBudgetMicros?: number | null;
}

export interface InstantFunds {
  /**
   * Holds up to `amountMicros` of the person's Instant Apps credit for one run, once per key, from the Instant category only
   * (replies and computer money never pay for it), earliest expiry first. A hold already made under the key is returned as it was.
   */
  reserve(input: { key: string; personId: string; amountMicros: number; botId?: string | null; runId?: string | null; charge: ChargeClass }): Promise<Hold>;
  /** The run happened: charges `chargeMicros` (never more than was held) and gives back the rest of the hold. `ok: false` means the books did not take it: nothing is decided, and it is said again later. */
  settle(input: { key: string; chargeMicros: number; providerCostMicros?: number | null }): Promise<{ ok: boolean }>;
  /** The run did not happen or did not work: gives back the whole hold. `ok: false` means it is still held and is said again later. */
  release(input: { key: string }): Promise<{ ok: boolean }>;
  /** After a charge: gives `amountMicros` back to the lots it came from, once per `refundKey`. Free credit never becomes cash. */
  refund(input: { key: string; refundKey: string; amountMicros: number; reason: 'platform_failure' | 'goodwill'; limits?: GiveBackLimits }): Promise<{ ok: boolean; refundedMicros: number; reason?: string }>;
}

/** The shut door: no credit source is wired in, so nothing is held. */
export const shutFunds: InstantFunds = {
  async reserve() {
    return { ok: false, reason: 'unavailable' };
  },
  async settle() {
    return { ok: false };
  },
  async release() {
    return { ok: false };
  },
  async refund() {
    return { ok: false, refundedMicros: 0, reason: 'unavailable' };
  },
};

let current: InstantFunds = shutFunds;

/** The credit source the executor uses. */
export function getInstantFunds(): InstantFunds {
  return current;
}

/** Wires in the funding books (or, in tests, a fake). Call with undefined to shut the door again. */
export function setInstantFunds(funds: InstantFunds | undefined): void {
  current = funds ?? shutFunds;
}

/** Whether a credit source is wired in. A shut door means no Instant run can start. */
export const instantFundsAreWired = (): boolean => current !== shutFunds;
