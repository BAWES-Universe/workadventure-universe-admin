/**
 * The saved limits, read inside a caller's transaction, against a real database. A read that fails must leave the caller's transaction usable
 * (a failed statement otherwise aborts it and every statement after it fails). Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated
 * THROWAWAY database.
 */
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn() }));

import { prisma } from '@/lib/db';
import { getServerLimits } from '@/lib/bot-limits';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

run('the saved limits read inside a transaction', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a read that fails inside the caller\'s transaction gives the recommended limits and leaves the transaction usable', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const after = await prisma.$transaction(async (tx) => {
        // A read that fails at the database (not a mock that throws): the statement itself is refused
        const failing = {
          appSetting: {
            findUnique: async () => {
              await tx.$executeRaw`SELECT 1/0`;
              return null;
            },
          },
          $executeRaw: tx.$executeRaw.bind(tx),
        };
        const limits = await getServerLimits(failing as never);
        expect(limits.bricks.keyTries).toBeGreaterThan(0);
        // The caller's own work after it still runs
        return tx.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one`;
      });
      expect(after).toEqual([{ one: 1 }]);
    } finally {
      quiet.mockRestore();
    }
  });

  it('reads the saved limits as before, with or without a transaction', async () => {
    const outside = await getServerLimits();
    const inside = await prisma.$transaction((tx) => getServerLimits(tx));
    expect(inside).toEqual(outside);
  });
});
