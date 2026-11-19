/**
 * Reading the server's bot limits: a read that fails gives the recommended values; inside a transaction it is made in a savepoint that is rolled back to,
 * so the failed statement does not abort the caller's transaction (a decision that must not use the recommended values asks for `getServerLimitsOrThrow`).
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

  it('reads inside a savepoint when the read is inside a transaction, and rolls back to it when it fails: the caller\'s transaction stays usable and goes on with the recommended values', async () => {
    const statements: string[] = [];
    const inside = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        statements.push(strings.join('?'));
        return 0;
      }),
      appSetting: { findUnique: jest.fn().mockRejectedValue(new Error('database away')) },
    };
    expect(await getServerLimits(inside as never)).toEqual(readServerLimits(null));
    expect(statements).toEqual(['SAVEPOINT bot_limits_read', 'ROLLBACK TO SAVEPOINT bot_limits_read']);
  });

  it('reads through the transaction it is given when it works', async () => {
    const inside = { appSetting: { findUnique: jest.fn().mockResolvedValue(null) } };
    expect(await getServerLimits(inside as never)).toEqual(readServerLimits(null));
    expect(mockFind).not.toHaveBeenCalled();
  });
});
