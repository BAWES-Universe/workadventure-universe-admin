import * as Sentry from '@sentry/nextjs';

/**
 * How an alert about a stuck computer give-back or refund is told once (the refund, the long-pending give-back and the failing late look all use it).
 *
 * The alert's row is locked (FOR UPDATE SKIP LOCKED) in an interactive transaction; Sentry is told INSIDE it and the row's mark (`alertedAt`, `late_look_told`) is set before the
 * commit. `captureMessage` only queues the event and returns an id, so the event is also FLUSHED inside the transaction: when the flush does not confirm, the transaction is rolled
 * back, the mark stays unset, and the next sweep tells it again. A flush that returns false can come from another event in the shared queue; that only means a duplicate alert on the
 * next sweep, which is acceptable (a duplicate is never a lost alert). Delivery past the flush is best effort; the durable signals are the overdue-refund ops overview and the
 * readiness check.
 */

/** How long one alert waits for Sentry to confirm the event. */
export const SENTRY_FLUSH_MS = 2_000;
/** The claim transaction's own timeout: above the flush budget, so a slow flush is never what rolls it back (Prisma's default is 5 s). */
export const ALERT_TRANSACTION_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/** The flush did not confirm the event: thrown inside the claim transaction so that it rolls back and the next sweep tells the alert again. */
export class AlertNotDelivered extends Error {
  constructor() {
    super('Sentry did not confirm the alert');
    this.name = 'AlertNotDelivered';
  }
}

/**
 * Tells Sentry (capture, then flush) and throws `AlertNotDelivered` when the flush does not confirm. With no Sentry client (a server with no DSN, nothing could ever be
 * delivered) it commits at once instead of failing on every sweep for ever.
 */
export async function tellSentry(capture: () => void): Promise<void> {
  capture();
  if (!Sentry.getClient?.()) return;
  if (!(await Sentry.flush(SENTRY_FLUSH_MS))) throw new AlertNotDelivered();
}
