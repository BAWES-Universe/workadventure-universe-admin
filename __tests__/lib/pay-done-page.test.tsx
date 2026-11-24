import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** The page a buyer lands on after paying: what keeps checking by itself. */
const verifyOrder = jest.fn();
const ended = new WeakSet<object>();
jest.mock('@/lib/app-direct/pay', () => ({ verifyOrderForReturnPage: (...args: unknown[]) => verifyOrder(...args), checksHaveEnded: (view: object) => ended.has(view) }));

import PaymentDone from '@/app/pay/done/page';

const order = '123e4567-e89b-12d3-a456-426614174000';
const page = async (status: string) => {
  verifyOrder.mockResolvedValueOnce({ status });
  return renderToStaticMarkup(await PaymentDone({ searchParams: Promise.resolve({ o: order }) }));
};

describe('the payment done page', () => {
  it('looks again soon while checking, more slowly while not received yet (a late payment can still arrive), and never once it is settled', async () => {
    expect(await page('checking')).toContain('content="4"');
    expect(await page('not_paid')).toContain('content="15"');
    expect(await page('paid')).not.toContain('refresh');
    expect(await page('cant_confirm')).not.toContain('refresh');
  });

  it('says an order the service has not had the last word about is being checked (slowly), and a settled cannot-confirm keeps its words', async () => {
    verifyOrder.mockResolvedValueOnce({ status: 'checking', longWait: true });
    const html = renderToStaticMarkup(await PaymentDone({ searchParams: Promise.resolve({ o: order }) }));
    expect(html).toContain('Checking your payment');
    expect(html).toContain('content="15"');
    expect(await page('cant_confirm')).toContain('We could not confirm this payment');
  });

  it('does not keep refreshing a not-received order that is no longer looked at (past the late-payment hours)', async () => {
    const view = { status: 'not_paid' };
    ended.add(view);
    verifyOrder.mockResolvedValueOnce(view);
    const html = renderToStaticMarkup(await PaymentDone({ searchParams: Promise.resolve({ o: order }) }));
    expect(html).not.toContain('refresh');
  });
});
