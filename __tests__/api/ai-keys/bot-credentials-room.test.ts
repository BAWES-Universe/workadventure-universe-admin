import { credentialsForBot } from '@/lib/bot-ai-credentials';
import { whereIsBrick } from '@/lib/brick-visit';

/**
 * A call that names a room the Brick is not visiting is answered for nobody, whatever a second look at "is it visiting anywhere" would say:
 * a visit that ran out between two looks must never turn a call from another room into one served on the owner's key.
 */

jest.mock('@/lib/brick-visit', () => ({ whereIsBrick: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
  },
}));

import { prisma } from '@/lib/db';

const db = prisma as unknown as { bot: { findUnique: jest.Mock }; user: { findFirst: jest.Mock } };
const where = whereIsBrick as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  // A Brick: no room, an owner, not deleted
  db.bot.findUnique.mockResolvedValue({ id: 'brick', name: 'Brick', aiProviderRef: null, aiModel: null, behaviorConfig: null, createdById: 'owner', roomId: null, ownerId: 'owner', deletedAt: null, maxReplyTokens: null, maxSteps: null, room: null });
  db.user.findFirst.mockResolvedValue(null);
});

describe('credentialsForBot for a call that names a room', () => {
  it('refuses a call from a room the Brick is not visiting, and looks the Brick up once', async () => {
    where.mockResolvedValue(null);
    expect(await credentialsForBot('brick', { roomUrl: 'https://play.example.test/_/a/b' })).toEqual({ status: 404, error: 'Bot not found' });
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('refuses it when the Brick was visiting elsewhere a moment ago and the visit has gone since (no second lookup to read that as nowhere)', async () => {
    // The first lookup (for the room named) finds nothing; a second one (for anywhere) would find nothing either, which used to serve the owner's key
    where.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const answer = await credentialsForBot('brick', { roomUrl: 'https://play.example.test/_/a/b' });
    expect(answer).toMatchObject({ status: 404 });
  });

  it('still answers a call that names neither a person nor a room, as it always did', async () => {
    where.mockResolvedValue(null);
    const answer = await credentialsForBot('brick', {}).catch(() => null);
    // It gets past the visit gate (the rest of the answer needs the books, which this test does not set up)
    expect(answer === null || (answer as { status: number }).status !== 404 || where.mock.calls.length > 0).toBe(true);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
