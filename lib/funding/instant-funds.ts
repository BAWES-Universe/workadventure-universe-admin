import { classifyCharge } from '@/lib/credit-values';
import { findRefund, holdCredit, refundHold, releaseHold, releaseKeyIfNothingHeld, settleHold } from '@/lib/credit-spend';
import { checkSpend } from '@/lib/spend-rules';
import { setInstantFunds, type InstantFunds } from '@/lib/instant/funds';

/**
 * What the Instant executor (O2) needs from the funding books, as the contract in lib/instant/funds.ts. Amounts are whole micros of a
 * dollar and every call is idempotent per key. It takes from the Instant Apps category only, by earliest expiry first, all or nothing:
 * replies and computer money never pay for it, and it never falls back to anything else. Any failure to read or write the books answers
 * "unavailable" (or a plain `ok: false`), so the executor refuses or says it again later, never running an unfunded paid step.
 */

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
          jobKey: input.taskKey ?? input.runId ?? null,
          // What the person said in chat is checked inside the hold's own transaction, under the person's lock, before any credit is held:
          // two steps asked at the same moment cannot both pass a cap that only has room for one
          guard: async (tx) => {
            const ruled = await checkSpend({ payerPersonId: input.personId, botId: input.botId ?? null, taskKey: input.taskKey ?? input.runId ?? null, chargeClass: 'apps', amountMicros: input.amountMicros }, clock(), tx);
            return ruled.ok ? null : { ok: false, reason: 'rule', ruleId: ruled.ruleId, why: ruled.why, leftMicros: ruled.leftMicros, words: ruled.words };
          },
        }, clock());
        if (held.ok) return { ok: true, created: held.created };
        if (held.reason === 'rule') return held;
        // A key the books were told to give up (see `release`) holds nothing, said as "unavailable": the step is not run and credit is not blamed
        return { ok: false, reason: held.reason === 'credit_used_up' || held.reason === 'not_set' ? held.reason : held.reason === 'not_given' ? 'credit_not_given' : 'unavailable' };
      } catch (error) {
        console.error('[Funding] Could not hold Instant credit:', error instanceof Error ? error.message : 'unknown');
        return { ok: false, reason: 'unavailable' };
      }
    },
    async settle(input) {
      try {
        const hold = await settleHold({ holdKey: input.key, customerMicros: input.chargeMicros, provider: input.providerCostMicros === undefined ? undefined : { costMicros: input.providerCostMicros, basis: input.providerCostMicros === null ? 'unknown' : 'measured' } }, clock());
        // Charged only if it is now settled: a hold that was released (or never existed) was not charged, whatever it answers. The amount is
        // what the books recorded: when the key was settled before, that is the FIRST amount, whatever this call said
        if (hold?.state === 'settled' && hold.customerMicros !== null) return { ok: true, chargedMicros: hold.customerMicros };
        return { ok: false };
      } catch (error) {
        console.error('[Funding] Could not settle Instant credit:', error instanceof Error ? error.message : 'unknown');
        return { ok: false };
      }
    },
    async release(input) {
      try {
        // A hold may land between "nothing is held" and closing the key: the key's lock decides, and a hold that won is released as any other
        for (let attempt = 0; attempt < 2; attempt++) {
          const released = await releaseHold({ holdKey: input.key }, clock());
          if (released) return { ok: released.state === 'released' };
          // Never held: the key is closed too, so a reservation still on its way is refused when it arrives and holds nothing
          if ((await releaseKeyIfNothingHeld({ holdKey: input.key }, clock())) === 'closed') return { ok: false, none: true };
        }
        return { ok: false };
      } catch (error) {
        console.error('[Funding] Could not release Instant credit:', error instanceof Error ? error.message : 'unknown');
        return { ok: false };
      }
    },
    async refund(input) {
      try {
        // Asking again with the same refundKey answers what the first ask gave (even nothing), never a second give-back
        const done = await refundHold({ holdKey: input.key, refundKey: input.refundKey, amountMicros: input.amountMicros, reason: input.reason, limits: input.limits }, clock());
        return done.ok ? { ok: true, refundedMicros: done.refundedMicros } : { ok: false, refundedMicros: 0, reason: done.reason };
      } catch (error) {
        console.error('[Funding] Could not refund Instant credit:', error instanceof Error ? error.message : 'unknown');
        return { ok: false, refundedMicros: 0, reason: 'unavailable' };
      }
    },
    async refundLookup(input) {
      try {
        const seen = await findRefund({ refundKey: input.refundKey });
        return seen.found ? { status: 'found', refundedMicros: seen.refundedMicros } : { status: 'none' };
      } catch (error) {
        console.error('[Funding] Could not look up an Instant give-back:', error instanceof Error ? error.message : 'unknown');
        return { status: 'unavailable' };
      }
    },
  };
}

/** Opens the Instant credit door on the funding books. Said again, it just wires them in again. */
export function wireInstantFunds(): void {
  setInstantFunds(createInstantFunds());
}
