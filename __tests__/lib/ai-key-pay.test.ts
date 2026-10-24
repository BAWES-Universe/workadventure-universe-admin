import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';
import { checkKeyForBot } from '@/lib/ai-key-pay';

jest.mock('@/lib/db', () => ({ prisma: { room: { findUnique: jest.fn() }, aiKeyLend: { findUnique: jest.fn() } } }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn() }));

const room = prisma.room.findUnique as jest.Mock;
const lend = prisma.aiKeyLend.findUnique as jest.Mock;
const manages = canManageBots as jest.Mock;
const input = { keyId: 'key-1', keyOwnerId: 'maker', makerId: 'maker', roomId: 'room-1' };

beforeEach(() => {
  jest.resetAllMocks();
  room.mockResolvedValue({ world: { universeId: 'uni-1' } });
  lend.mockResolvedValue({ id: 'lend-1' });
  manages.mockResolvedValue(true);
});

describe('who pays for a bot on a personal key', () => {
  it('is allowed when the key is the maker’s, lent to the bot’s universe, and the maker still manages bots there', async () => {
    expect(await checkKeyForBot(input)).toEqual({ ok: true, lendModels: null });
    expect(lend).toHaveBeenCalledWith({ where: { providerId_universeId: { providerId: 'key-1', universeId: 'uni-1' } }, select: { id: true, models: true } });
    expect(manages).toHaveBeenCalledWith('maker', 'room-1');
  });

  it('is never someone else’s key: not the chatter’s, not a manager’s, not another maker’s', async () => {
    expect(await checkKeyForBot({ ...input, keyOwnerId: 'someone-else' })).toEqual({ ok: false, reason: 'not-maker' });
    expect(await checkKeyForBot({ ...input, makerId: null })).toEqual({ ok: false, reason: 'not-maker' });
    expect(await checkKeyForBot({ ...input, keyOwnerId: null })).toEqual({ ok: false, reason: 'not-maker' });
    expect(lend).not.toHaveBeenCalled();
  });

  it('is refused when the key is not lent to the universe the bot stands in', async () => {
    lend.mockResolvedValue(null);
    expect(await checkKeyForBot(input)).toEqual({ ok: false, reason: 'not-lent' });
    expect(manages).not.toHaveBeenCalled();
  });

  it('is refused once the maker has lost Manage bots in the room', async () => {
    manages.mockResolvedValue(false);
    expect(await checkKeyForBot(input)).toEqual({ ok: false, reason: 'no-access' });
  });

  it('is refused for a room that is not there', async () => {
    room.mockResolvedValue(null);
    expect(await checkKeyForBot(input)).toEqual({ ok: false, reason: 'no-room' });
  });
});
