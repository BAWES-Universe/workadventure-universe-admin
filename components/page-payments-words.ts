import type { PayLine } from '@/lib/page-payments-host';

/**
 * Every word a buyer reads on the host's own line under a paying page, in ONE place: the wording of the approved mock M1 (19 Nov). The same
 * lines are in the game's window (the game keeps its own copy of this wording: the two must say the same). Nothing else in the payment code has
 * user-facing text. No payment service is named.
 */
export const PAY_WORDS = {
  checking: { title: 'Checking your payment…', sub: 'Asking the payment service directly.' },
  slow: { title: 'This is taking longer than usual…', sub: 'Your payment is still being checked.' },
  paidAccount: { title: 'Paid. Thank you.', sub: 'It’s saved to your account, so it comes back whenever you open this page.' },
  paidGuest: { title: 'Paid. Thank you.', sub: 'A guest purchase on this browser. Save your private receipt link: it brings this purchase back on any device, so share it with no one.' },
  paidTest: { title: 'Test payment received. No money moved.', sub: 'Only a live payment counts as a purchase.' },
  restored: (date: string | null) => ({ title: date ? `Your purchase from ${date} is back.` : 'Your purchase is back.', sub: null }),
  saveReceipt: { title: 'Checking your payment…', sub: 'This browser can’t remember it. Save your private receipt link now.' },
  receiptCopied: { title: 'Private receipt link copied.', sub: 'Keep it somewhere safe, like your notes or email. Anyone who has it can bring this purchase back.' },
  copyFailed: 'Couldn’t copy it. Select the link below and copy it yourself.',
  notHeard: { title: 'We haven’t heard back about your payment yet.', sub: 'If you paid, it still counts. Check it here before paying again.' },
  stillChecking: { title: 'We’re still checking your earlier payment.', sub: 'If you paid, it will show up here when your payment service confirms it.' },
  longUnconfirmed: { title: 'We could not confirm your earlier payment.', sub: 'If you paid, contact the page’s owner with the time of the payment. We keep checking in the background; press Check payment to see a later update.' },
  /** Said under the line whenever an earlier payment may still count: pressing the page's Buy again then starts a NEW payment (a deliberate new purchase), and Check payment is the way to learn about the earlier one. */
  buyAgainNote: 'This starts a new payment. Your earlier one is still being checked.',
  notPaid: { title: 'Not paid yet.', sub: 'If you already paid, it can take a while to show. Check it here before paying again.' },
  needsUpdate: { title: 'This page’s pay button needs an update.', sub: 'If you already paid, check it here before paying again.' },
  unavailable: { title: 'Payments unavailable', sub: null },
  /** The owner set the payment on a newer version than the one this link shows: nothing was charged, and it works again once they publish. Said without telling the visitor that a newer version exists (game #2115). */
  notPublished: { title: 'Payments unavailable', sub: 'This page isn’t taking payments right now. Try again later.' },
  /** The page open here is older than the published one the payment was set on: nothing was charged, and a reload shows the latest. */
  pageChanged: { title: 'This page was updated.', sub: 'Reload it to see the latest version before you pay.' },
  limit: { title: 'Too many tries for now.', sub: 'Try again in a little while.' },
  boughtBefore: { title: 'Bought this before?', sub: null },
  noneGuest: { title: 'No purchase found in this browser.', sub: 'Open the receipt link you saved when you paid. It brings your purchase back here.' },
  noneAccount: { title: 'No purchase found on your account for this page.', sub: 'If you paid as a guest, open the receipt link you saved.' },
  buttons: {
    checkPayment: 'Check payment',
    restorePurchase: 'Restore purchase',
    copyReceipt: 'Copy private receipt link',
    copied: 'Copied',
    close: 'Close',
    resume: (app: string) => `Open ${app || 'the payment page'} again`,
  },
} as const;

export type PayAction =
  | { kind: 'check'; label: string; style: 'primary' | 'secondary' }
  | { kind: 'restore'; label: string; style: 'primary' | 'secondary' }
  | { kind: 'copy'; label: string; style: 'primary' | 'secondary'; disabled?: boolean }
  | { kind: 'resume'; label: string; url: string; style: 'primary' | 'secondary' };

export interface PayView {
  title: string;
  sub: string | null;
  actions: PayAction[];
  /** The line can be closed (a quiet offer, or "no purchase found"); a payment on its way never can. */
  closable: boolean;
  /** Said under the line while an earlier payment is still being checked: what pressing Buy again would do. Never on a payment that ended (paid, not paid, none). */
  note?: string;
}

/** "19 Nov": the day a purchase was made, in the buyer's own browser language, never a time zone dump. */
export function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** While a payment is on its way and this browser cannot keep the buyer's code, the receipt link can be copied right away (it is the only way back). */
function savePrompt(copied: boolean): PayAction {
  return copied ? { kind: 'copy', label: PAY_WORDS.buttons.copied, style: 'secondary', disabled: true } : { kind: 'copy', label: PAY_WORDS.buttons.copyReceipt, style: 'primary' };
}

/**
 * What the line says, and what can be pressed, for the state the host is in. A pure function so every screen of the mock is tested on its own.
 * Order: a payment that ended well, then a problem, then a page that cannot ask, then a payment on its way, then the quiet offers.
 */
export function describeLine(line: PayLine, state: { copied: boolean }): PayView | null {
  const check: PayAction = { kind: 'check', label: PAY_WORDS.buttons.checkPayment, style: 'primary' };
  const resume: PayAction[] = line.resume ? [{ kind: 'resume', label: PAY_WORDS.buttons.resume(line.resume.app), url: line.resume.url, style: 'secondary' }] : [];

  if (line.paid) {
    if (line.paid.test) return { ...PAY_WORDS.paidTest, actions: [], closable: false };
    if (line.restored) return { ...PAY_WORDS.restored(shortDate(line.restored.paidAt)), actions: [], closable: false };
    if (line.receipt) {
      return state.copied
        ? { ...PAY_WORDS.receiptCopied, actions: [{ kind: 'copy', label: PAY_WORDS.buttons.copied, style: 'secondary', disabled: true }], closable: false }
        : { ...PAY_WORDS.paidGuest, actions: [{ kind: 'copy', label: PAY_WORDS.buttons.copyReceipt, style: 'primary' }], closable: false };
    }
    return { ...PAY_WORDS.paidAccount, actions: [], closable: false };
  }
  if (line.problem === 'none') return { ...(line.buyer === 'account' ? PAY_WORDS.noneAccount : PAY_WORDS.noneGuest), actions: [], closable: true };
  // Whatever else is pressed, a browser that cannot keep the buyer's code keeps offering the receipt link while the payment is not settled
  const save = line.keepReceipt && line.receipt ? [savePrompt(state.copied)] : [];
  if (line.problem === 'not_paid') return { ...PAY_WORDS.notPaid, actions: [check, ...save], closable: false };
  // While an earlier payment may still count (it is not known to have failed), a new Buy starts a NEW payment: the line says so (approved wording), and Check payment stays the obvious action
  const again = PAY_WORDS.buyAgainNote;
  if (line.problem === 'long_unconfirmed') return { ...PAY_WORDS.longUnconfirmed, actions: [check, ...save], closable: false, note: again };
  if (line.problem === 'still_checking') return { ...PAY_WORDS.stillChecking, actions: [check, ...save], closable: false, note: again };
  if (line.problem === 'cant_confirm') return { ...PAY_WORDS.notHeard, actions: [check, ...save], closable: false, note: again };
  // A start whose answer was lost: an order may or may not exist, so it is said like any other payment not heard back about
  if (line.problem === 'unavailable') return line.canCheck ? { ...PAY_WORDS.notHeard, actions: [check, ...save], closable: false, note: again } : { ...PAY_WORDS.unavailable, actions: [], closable: false };
  if (line.problem === 'not_published') return { ...PAY_WORDS.notPublished, actions: [], closable: false };
  if (line.problem === 'page_changed') return { ...PAY_WORDS.pageChanged, actions: [], closable: false };
  if (line.problem === 'limit') return { ...PAY_WORDS.limit, actions: [], closable: false };
  if (line.needsUpdate) return { ...PAY_WORDS.needsUpdate, actions: line.checking ? [] : [check], closable: false };
  if (line.checking) {
    return { ...(save.length ? PAY_WORDS.saveReceipt : line.slow ? PAY_WORDS.slow : PAY_WORDS.checking), actions: [...resume, ...save], closable: false };
  }
  if (line.offerRestore) return { ...PAY_WORDS.boughtBefore, actions: [{ kind: 'restore', label: PAY_WORDS.buttons.restorePurchase, style: 'secondary' }], closable: true };
  if (line.canCheck) return { ...PAY_WORDS.notHeard, actions: [check, ...save], closable: false, note: again };
  return null;
}
