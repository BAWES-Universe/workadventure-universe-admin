import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** The page a buyer lands on after paying: what keeps checking by itself. */
const verifyOrder = jest.fn();
jest.mock('@/lib/app-direct/pay', () => ({ verifyOrder: (...args: unknown[]) => verifyOrder(...args) }));

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
});
