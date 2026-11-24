jest.mock('@sentry/nextjs', () => ({ getClient: jest.fn(), flush: jest.fn() }));

import * as Sentry from '@sentry/nextjs';
import { ALERT_TRANSACTION_OPTIONS, AlertNotDelivered, SENTRY_FLUSH_MS, tellSentry } from '@/lib/computer-alerts';

const getClient = Sentry.getClient as jest.Mock;
const flush = Sentry.flush as jest.Mock;

describe('telling Sentry inside an alert’s claim transaction', () => {
  beforeEach(() => {
    getClient.mockReset();
    flush.mockReset();
  });

  it('gives the claim transaction more time than the flush may take, so a slow flush is never what rolls it back', () => {
    expect(ALERT_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(SENTRY_FLUSH_MS);
    expect(ALERT_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(5_000);
  });

  it('captures, then flushes, and throws when the flush does not confirm (so the transaction rolls back)', async () => {
    getClient.mockReturnValue({});
    const order: string[] = [];
    flush.mockImplementation(async () => {
      order.push('flush');
      return false;
    });
    await expect(tellSentry(() => order.push('capture'))).rejects.toBeInstanceOf(AlertNotDelivered);
    expect(order).toEqual(['capture', 'flush']);
    expect(flush).toHaveBeenCalledWith(SENTRY_FLUSH_MS);
    flush.mockResolvedValue(true);
    await expect(tellSentry(() => undefined)).resolves.toBeUndefined();
  });

  it('commits at once, without a flush, when there is no Sentry client (nothing could ever be delivered)', async () => {
    getClient.mockReturnValue(undefined);
    await expect(tellSentry(() => undefined)).resolves.toBeUndefined();
    expect(flush).not.toHaveBeenCalled();
  });
});
