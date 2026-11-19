/**
 * Reading the server's bot limits: a read on its own that fails gives the recommended values, but one inside a transaction passes its error
 * on, because a failed statement has already aborted the transaction and carrying on would only hide why.
 */
const mockFind = jest.fn();
jest.mock('@/lib/db', () => ({ prisma: { appSetting: { findUnique: (...args: unknown[]) => mockFind(...args) } } }));

import { getServerLimits } from '@/lib/bot-limits';
import { readServerLimits } from '@/lib/bot-limit-values';

describe('getServerLimits', () => {
  beforeEach(() => {
    mockFind.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('gives the recommended values when a read on its own fails', async () => {
    mockFind.mockRejectedValueOnce(new Error('database away'));
    expect(await getServerLimits()).toEqual(readServerLimits(null));
  });

  it('passes the error on when the read is inside a transaction, which a failed statement has already aborted', async () => {
    const inside = { appSetting: { findUnique: jest.fn().mockRejectedValue(new Error('database away')) } };
    await expect(getServerLimits(inside as never)).rejects.toThrow('database away');
  });

  it('reads through the transaction it is given when it works', async () => {
    const inside = { appSetting: { findUnique: jest.fn().mockResolvedValue(null) } };
    expect(await getServerLimits(inside as never)).toEqual(readServerLimits(null));
    expect(mockFind).not.toHaveBeenCalled();
  });
});
