import { claimAppSlot, AppsFull } from '@/lib/bot-limits';

/** Making room for an App reads the limit through the caller's own transaction, never through a second connection. */

const globalRead = jest.fn();
jest.mock('@/lib/db', () => ({ prisma: { appSetting: { findUnique: (...args: unknown[]) => globalRead(...args) } } }));

function transaction(count: number) {
  return {
    appSetting: { findUnique: jest.fn(async () => ({ value: { bricks: { appsPerBot: 2 } } })) },
    botMcpServer: { count: jest.fn(async () => count) },
    $queryRaw: jest.fn(async () => []),
  };
}

beforeEach(() => globalRead.mockReset().mockRejectedValue(new Error('the global client was used while a transaction held a connection')));

it('reads the limit through the transaction and holds the bot first', async () => {
  const tx = transaction(1);
  await expect(claimAppSlot(tx as never, 'bot-1')).resolves.toBeUndefined();
  expect(tx.appSetting.findUnique).toHaveBeenCalled();
  expect(globalRead).not.toHaveBeenCalled();
});

it('refuses when the bot is full of the limit that was read', async () => {
  const tx = transaction(2);
  await expect(claimAppSlot(tx as never, 'bot-1')).rejects.toBeInstanceOf(AppsFull);
  expect(globalRead).not.toHaveBeenCalled();
});
