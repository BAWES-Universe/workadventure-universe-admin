/** Every screen of mock M1 for the public page (and the line above each), by the state the host is in. */
// The day a purchase was made is shown in the buyer's own time zone: these tests fix the zone so "19 Nov" is the same on every machine
process.env.TZ = 'UTC';
import { describeLine, shortDate } from '@/components/page-payments-words';
import { NO_PAY_LINE, type PayLine } from '@/lib/page-payments-host';

const line = (update: Partial<PayLine>): PayLine => ({ ...NO_PAY_LINE, ...update });
const text = (update: Partial<PayLine>, copied = false) => {
  const view = describeLine(line(update), { copied });
  return view ? [view.title, view.sub, view.actions.map((action) => action.label), view.closable] : null;
};

describe('the host line’s wording (mock M1)', () => {
  it('says nothing when there is nothing to say', () => {
    expect(describeLine(NO_PAY_LINE, { copied: false })).toBeNull();
  });

  it('paid: saved to the account for a signed-in buyer; a receipt link to keep for a guest; copied once copied; a test never as a purchase', () => {
    expect(text({ paid: { test: false }, buyer: 'account' })).toEqual(['Paid. Thank you.', 'It’s saved to your account, so it comes back whenever you open this page.', [], false]);
    expect(text({ paid: { test: false }, buyer: 'guest', receipt: 'https://x/a#receipt=c' })).toEqual(['Paid. Thank you.', 'Save your receipt link. It brings this purchase back on any device.', ['Copy receipt link'], false]);
    expect(text({ paid: { test: false }, buyer: 'guest', receipt: 'https://x/a#receipt=c' }, true)).toEqual(['Receipt link copied.', 'Keep it somewhere safe, like your notes or email.', ['Copied'], false]);
    expect(text({ paid: { test: true }, buyer: 'guest', receipt: 'https://x/a#receipt=c' })).toEqual(['Test payment received. No money moved.', 'Only a live payment counts as a purchase.', [], false]);
  });

  it('a purchase found again says "is back", with the day when it is known', () => {
    expect(text({ paid: { test: false }, buyer: 'guest', restored: { paidAt: '2026-11-19T10:00:00.000Z' } })?.[0]).toBe('Your purchase from 19 Nov is back.');
    expect(text({ paid: { test: false }, restored: { paidAt: null } })?.[0]).toBe('Your purchase is back.');
    expect(shortDate('nope')).toBeNull();
  });

  it('Restore purchase is offered quietly and can be closed; "none" points a guest to the receipt link and a signed-in buyer to the guest receipt', () => {
    expect(text({ offerRestore: true, buyer: 'guest' })).toEqual(['Bought this before?', null, ['Restore purchase'], true]);
    expect(text({ problem: 'none', buyer: 'guest' })).toEqual(['No purchase found in this browser.', 'Open the receipt link you saved when you paid. It brings your purchase back here.', [], true]);
    expect(text({ problem: 'none', buyer: 'account' })).toEqual(['No purchase found on your account for this page.', 'If you paid as a guest, open the receipt link you saved.', [], true]);
  });

  it('not heard back, not paid yet and a page that needs an update all offer Check payment; a payment on its way offers nothing to press', () => {
    expect(text({ problem: 'cant_confirm', canCheck: true })).toEqual(['We haven’t heard back about your payment yet.', 'If you paid, it still counts. You can check now.', ['Check payment'], false]);
    expect(text({ problem: 'unavailable', canCheck: true })?.[2]).toEqual(['Check payment']);
    expect(text({ problem: 'not_paid', canCheck: true })).toEqual(['Not paid yet.', 'If you just paid, it can take a few minutes to show.', ['Check payment'], false]);
    expect(text({ needsUpdate: true, canCheck: true })).toEqual(['This page’s pay button needs an update.', 'If you already paid, you can check it here.', ['Check payment'], false]);
    expect(text({ checking: true })).toEqual(['Checking your payment…', 'Asking the payment service directly.', [], false]);
    expect(text({ checking: true, slow: true })?.[0]).toBe('This is taking longer than usual…');
    expect(text({ checking: true, resume: { url: 'https://c.example/x', app: 'ExamplePay' } })?.[2]).toEqual(['Open ExamplePay again']);
    expect(text({ problem: 'unavailable' })?.[0]).toBe('Payments unavailable');
    expect(text({ problem: 'limit' })?.[0]).toBe('Too many tries for now.');
  });
});
