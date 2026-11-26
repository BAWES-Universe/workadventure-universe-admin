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
  /** The person was not given Instant Apps credit this period (the month's budget ran out, for one) and has none: never told as used up. */
  | 'credit_not_given'
  /** A setting the credit cannot be taken without is not set yet. */
  | 'not_set'
  /** The books could not be read or written: nothing was held. */
  | 'unavailable';

export type Hold =
  | { ok: true; created: boolean }
  | { ok: false; reason: HoldRefusal }
  /** A rule the person said in chat ("no more than $1 a month") does not let this step take that much: the rule's own words, and nothing to ask more credit for. */
  | { ok: false; reason: 'rule'; ruleId: string; why: 'own_accounts' | 'cap'; leftMicros: number | null; words: string };

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
  reserve(input: { key: string; personId: string; amountMicros: number; botId?: string | null; runId?: string | null; /** The bot server's id for the task this run belongs to, so a rule about one task counts all of its runs. */ taskKey?: string | null; charge: ChargeClass }): Promise<Hold>;
  /**
   * The run happened: charges `chargeMicros` (never more than was held) and gives back the rest of the hold. `ok: false` means the books
   * did not take it: nothing is decided, and it is said again later. `chargedMicros` is REQUIRED on `ok: true`: what the key was charged at,
   * and when it was settled before (a settlement the books took and this side never recorded) the FIRST amount, which is the one recorded
   * here. A yes without it is not taken as done: the run stays held and the settlement is asked again.
   */
  settle(input: { key: string; chargeMicros: number; providerCostMicros?: number | null }): Promise<{ ok: true; chargedMicros: number } | { ok: false }>;
  /**
   * The run did not happen or did not work: gives back the whole hold. `ok: false` means it may still be held and is said again later.
   * `none: true` means the books CONFIRM nothing is held under the key (it never was): the only way a run whose reservation was never
   * answered may be closed without a release. A plain `ok: false` never closes it.
   * A `none: true` answer also CLOSES the key in the books: a reservation under it that arrives later (one that was still on its way)
   * is refused (`reason: 'unavailable'`) and holds nothing. That keeps a late hold from ever existing, even if this side stops
   * before it can give the hold back.
   */
  release(input: { key: string }): Promise<{ ok: boolean; none?: boolean }>;
  /** After a charge: gives `amountMicros` back to the lots it came from, once per `refundKey`. Free credit never becomes cash. */
  refund(input: { key: string; refundKey: string; amountMicros: number; reason: 'platform_failure' | 'goodwill'; limits?: GiveBackLimits }): Promise<{ ok: boolean; refundedMicros: number; reason?: string }>;
  /**
   * Read only: did the books ever give anything back under this `refundKey`? `found` answers with the FIRST amount; `none` means they
   * confirm nothing was ever given under it; `unavailable` means that is not known. It never gives, locks or changes anything, so a give-back
   * this side let go of can be looked at without making it again.
   */
  refundLookup(input: { key: string; refundKey: string }): Promise<{ status: 'found'; refundedMicros: number } | { status: 'none' } | { status: 'unavailable' }>;
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
  async refundLookup() {
    return { status: 'unavailable' };
  },
};

// Kept on `globalThis`: the server starts (and wires this in) from instrumentation, and each route bundle may carry its own copy of this
// module, so a plain module variable would stay shut in the routes that run Instant steps.
const SLOT = Symbol.for('universe.instant.funds');
const slot = globalThis as unknown as Record<symbol, InstantFunds | undefined>;

/** The credit source the executor uses. */
export function getInstantFunds(): InstantFunds {
  return slot[SLOT] ?? shutFunds;
}

/** Wires in the funding books (or, in tests, a fake). Call with undefined to shut the door again. */
export function setInstantFunds(funds: InstantFunds | undefined): void {
  slot[SLOT] = funds;
}

/** Whether a credit source is wired in. A shut door means no Instant run can start. */
export const instantFundsAreWired = (): boolean => getInstantFunds() !== shutFunds;
