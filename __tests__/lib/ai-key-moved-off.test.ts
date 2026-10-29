import { prisma } from '@/lib/db';
import { addNotice } from '@/lib/notices';
import { tellKeyOwnerMovedOff } from '@/lib/ai-key-moved-off';

jest.mock('@/lib/db', () => ({
  prisma: { botsAiProvider: { findUnique: jest.fn() }, user: { findUnique: jest.fn() }, bot: { findUnique: jest.fn() } },
}));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn() }));

const keys = prisma.botsAiProvider.findUnique as jest.Mock;
const bot = { id: 'bot-1', name: 'Linear SH' };
const move = (over: object = {}) => tellKeyOwnerMovedOff({ bot, fromRef: 'sara-key', toRef: 'khalid-key', actorId: 'khalid', ...over });

beforeEach(() => {
  jest.resetAllMocks();
  keys.mockImplementation(async ({ where }: { where: { providerId: string } }) =>
    where.providerId === 'sara-key'
      ? { name: 'My DeepSeek', ownerId: 'sara' }
      : where.providerId === 'server-1'
        ? { name: 'Team OpenRouter', ownerId: null, settings: { kind: 'openrouter' } }
        : { name: 'Work Claude', ownerId: 'khalid', settings: { kind: 'claude' } },
  );
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ name: 'Khalid' });
  (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ room: { world: { universe: { name: 'BAWES Universe' } } } });
});

describe('telling a key’s owner their key lost a bot (#709)', () => {
  it('says who moved it, to what, where, and how to move it back', async () => {
    await move();
    expect(addNotice).toHaveBeenCalledWith({
      userId: 'sara',
      kind: 'ai-key-moved',
      dedupeKey: expect.stringMatching(/^moved-off:sara-key:bot-1:\d{4}-/),
      title: 'Linear SH moved off your key',
      body: 'Khalid moved it to Khalid’s Claude in BAWES Universe. To move it back, open Linear SH and pick My DeepSeek.',
      href: '/admin/you/ai-keys',
    });
  });

  it('names Universe AI when it went there', async () => {
    await move({ toRef: 'universe-ai' });
    expect((addNotice as jest.Mock).mock.calls[0][0].body).toBe('Khalid moved it to Universe AI in BAWES Universe. To move it back, open Linear SH and pick My DeepSeek.');
  });

  it('names a server provider by its name, and says no destination when the bot was left with no provider', async () => {
    await move({ toRef: 'server-1' });
    await move({ toRef: null });
    await move({ toRef: '' });
    const bodies = (addNotice as jest.Mock).mock.calls.map((call) => call[0].body);
    expect(bodies).toEqual([
      'Khalid moved it to Team OpenRouter in BAWES Universe. To move it back, open Linear SH and pick My DeepSeek.',
      'Khalid moved it in BAWES Universe. To move it back, open Linear SH and pick My DeepSeek.',
      'Khalid moved it in BAWES Universe. To move it back, open Linear SH and pick My DeepSeek.',
    ]);
  });

  it('tells nobody when the mover owns the key, or the bot was not on a person’s key', async () => {
    await move({ actorId: 'sara' });
    await move({ fromRef: 'universe-ai' });
    await move({ fromRef: null });
    await move({ toRef: 'sara-key' });
    await move({ actorId: null });
    keys.mockResolvedValue({ name: 'DeepSeek V4 Flash', ownerId: null });
    await move();
    expect(addNotice).not.toHaveBeenCalled();
  });

  it('never fails the save when telling fails', async () => {
    (addNotice as jest.Mock).mockRejectedValue(new Error('db down'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(move()).resolves.toBeUndefined();
    quiet.mockRestore();
  });
});
