/**
 * Changing a voice key's limits (the owner's own caps on it): the server's limits it is compared with are read before the save begins. A read made
 * while the save holds its own connection waits for a second one, and a pool with none to spare never gives it.
 */
import { prisma } from '@/lib/db';
import { getVoiceLimits } from '@/lib/voice-limits';
import { updateVoiceKey } from '@/lib/voice-keys';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/voice-limits', () => ({ getVoiceLimits: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    voiceProvider: { findFirst: jest.fn() },
  },
}));

const db = prisma as unknown as { $transaction: jest.Mock; voiceProvider: { findFirst: jest.Mock } };
const SERVER = { turnSeconds: 180, replyCharacters: 600, replySeconds: 60, listenMinutesPerDay: 60 };

it('reads the server’s limits before the save begins, not while the save holds its own connection', async () => {
  let inside = false;
  const readInside: boolean[] = [];
  (getVoiceLimits as jest.Mock).mockImplementation(async () => {
    readInside.push(inside);
    return { limits: SERVER };
  });
  const update = jest.fn();
  const tx = {
    $queryRaw: jest.fn(async () => []),
    voiceProvider: { findFirst: jest.fn(async () => ({ id: 'k1', adapter: 'elevenlabs', recognition: false, speech: true, models: [], hiddenModels: null, voiceLimits: null })), update },
    voiceKeyLend: { findMany: jest.fn(async () => []) },
  };
  db.$transaction.mockImplementation(async (run: (client: unknown) => unknown) => {
    inside = true;
    try {
      return await run(tx);
    } finally {
      inside = false;
    }
  });
  db.voiceProvider.findFirst.mockResolvedValue(null);
  await updateVoiceKey('u1', 'k1', { limits: { replyCharacters: 300 } } as never).catch(() => undefined);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ voiceLimits: { replyCharacters: 300 } }) }));
  expect(readInside).toEqual([false]);
});
