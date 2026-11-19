import type { PayProblem } from '@/lib/page-payments-host';

/**
 * Every word a buyer reads on the host's own line under a paying page (and on the receipt page), in ONE place. PLACEHOLDER WORDING: the
 * screens and the button wording come from mock M1 (and M2 for the wording), which is a separate piece of work. When it is approved, only this
 * file changes; nothing else in the payment code has user-facing text.
 */
export const PAY_WORDS = {
  checking: 'Checking your payment…',
  slow: 'This is taking longer than usual…',
  paid: 'Payment received',
  paidTest: 'Test payment received. No real money was taken.',
  needsUpdate: 'This page’s pay button needs an update.',
  resume: (app: string) => `Open ${app || 'the payment page'} again`,
  checkPayment: 'Check payment',
  saveReceipt: 'Save your receipt link',
  receiptCopied: 'Receipt link copied',
  problem: {
    unavailable: 'Payments unavailable',
    limit: 'Too many tries for now. Try again in a little while.',
    // A closed checkout can still be paid for a while at the service: this never says that nothing was taken
    not_paid: 'We have not received this payment yet. If you already paid, it can take a little while to show.',
    cant_confirm: 'We could not confirm the payment',
    none: 'No payment found for this browser',
  } satisfies Record<PayProblem, string>,
} as const;
