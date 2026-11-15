import { classifyCharge } from '@/lib/credit-values';
import { holdCredit, refundHold, releaseHold, settleHold, type GiveBackLimits } from '@/lib/credit-spend';
import { checkSpend } from '@/lib/spend-rules';

/**
 * What the Instant executor (O2) needs from the funding books, as one small contract. Amounts are whole micros of a dollar and every call
 * is idempotent per key. It takes from the Instant Apps category only, by earliest expiry first, all or nothing: replies and computer money
 * never pay for it, and it never falls back to anything else. Any failure to read or write the books answers "unavailable", so the
 * executor refuses rather than running an unfunded paid step.
 */

export interface InstantReserve {
  key: string;
  personId: string;
  amountMicros: number;
  botId?: string | null;
  runId?: string | null;
  charge: { class: 'instant'; route: string; provider: string; priceVersion?: string | null };
}

export type InstantReserved =
  | { ok: true; created: boolean }
  | { ok: false; reason: 'credit_used_up' | 'not_set' | 'unavailable' }
  /** A rule the person said in chat ("no more than $1 a month", "only my own accounts") does not let this step take that much: the rule's own words, and nothing to ask more credit for. */
  | { ok: false; reason: 'rule'; ruleId: string; why: 'own_accounts' | 'cap'; leftMicros: number | null; words: string };

export interface InstantFunds {
  reserve(input: InstantReserve): Promise<InstantReserved>;
  /** Charges `chargeMicros` (at most what was reserved) and gives the rest back. Says twice, changes nothing. */
  settle(input: { key: string; chargeMicros: number; providerCostMicros?: number | null }): Promise<{ ok: boolean }>;
  /** Gives it all back: the step never ran, or a verified platform failure. */
  release(input: { key: string }): Promise<{ ok: boolean }>;
  /** After settle: back into the lots it came from, once per refundKey. Never turns free credit into cash. */
  refund(input: { key: string; refundKey: string; amountMicros: number; reason: 'platform_failure' | 'goodwill'; limits?: GiveBackLimits }): Promise<{ ok: boolean; refundedMicros: number; reason?: string }>;
}

/** `clock` is for tests only; the executor never passes it. */
export function createInstantFunds(clock: () => Date = () => new Date()): InstantFunds {
  return {
    async reserve(input) {
      try {
        const held = await holdCredit({
          holdKey: input.key,
          personId: input.personId,
          category: 'instant_apps',
          amountMicros: input.amountMicros,
          chargeClass: classifyCharge({ work: 'instant', inComputerJob: false }),
          botId: input.botId ?? null,
          route: input.charge.route,
          provider: input.charge.provider,
          priceVersion: input.charge.priceVersion ?? null,
          jobKey: input.runId ?? null,
          // What the person said in chat is checked inside the hold's own transaction, under the person's lock, before any credit is held:
          // two steps asked at the same moment cannot both pass a cap that only has room for one
          guard: async (tx) => {
            const ruled = await checkSpend({ payerPersonId: input.personId, botId: input.botId ?? null, taskKey: input.runId ?? null, chargeClass: 'apps', amountMicros: input.amountMicros }, clock(), tx);
            return ruled.ok ? null : { ok: false, reason: 'rule', ruleId: ruled.ruleId, why: ruled.why, leftMicros: ruled.leftMicros, words: ruled.words };
          },
        }, clock());
        if (held.ok) return { ok: true, created: held.created };
        if (held.reason === 'rule') return held;
        return { ok: false, reason: held.reason === 'credit_used_up' || held.reason === 'not_set' ? held.reason : 'unavailable' };
      } catch (error) {
        console.error('[Funding] Could not hold Instant credit:', error instanceof Error ? error.message : 'unknown');
        return { ok: false, reason: 'unavailable' };
      }
    },
    async settle(input) {
      try {
        const hold = await settleHold({ holdKey: input.key, customerMicros: input.chargeMicros, provider: input.providerCostMicros === undefined ? undefined : { costMicros: input.providerCostMicros, basis: input.providerCostMicros === null ? 'unknown' : 'measured' } }, clock());
        // Charged only if it is now settled: a hold that was released (or never existed) was not charged, whatever it answers
        return { ok: hold?.state === 'settled' };
      } catch (error) {
        console.error('[Funding] Could not settle Instant credit:', error instanceof Error ? error.message : 'unknown');
        return { ok: false };
      }
    },
    async release(input) {
      try {
        return { ok: (await releaseHold({ holdKey: input.key }, clock()))?.state === 'released' };
      } catch (error) {
        console.error('[Funding] Could not release Instant credit:', error instanceof Error ? error.message : 'unknown');
        return { ok: false };
      }
    },
    async refund(input) {
      try {
        const done = await refundHold({ holdKey: input.key, refundKey: input.refundKey, amountMicros: input.amountMicros, reason: input.reason, limits: input.limits }, clock());
        return done.ok ? { ok: true, refundedMicros: done.refundedMicros } : { ok: false, refundedMicros: 0, reason: done.reason };
      } catch (error) {
        console.error('[Funding] Could not refund Instant credit:', error instanceof Error ? error.message : 'unknown');
        return { ok: false, refundedMicros: 0, reason: 'unavailable' };
      }
    },
  };
}
