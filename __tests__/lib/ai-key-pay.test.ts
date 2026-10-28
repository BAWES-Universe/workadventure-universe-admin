import { prisma } from '@/lib/db';
import { canManageBots, canManageThisBot } from '@/lib/bot-permissions';
import { checkKeyForBot } from '@/lib/ai-key-pay';

jest.mock('@/lib/db', () => ({ prisma: { room: { findUnique: jest.fn() }, aiKeyLend: { findUnique: jest.fn() } } }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn(), canManageThisBot: jest.fn() }));

const room = prisma.room.findUnique as jest.Mock;
const lend = prisma.aiKeyLend.findUnique as jest.Mock;
const managesRoom = canManageBots as jest.Mock;
const managesBot = canManageThisBot as jest.Mock;
const bot = { id: 'bot-1', createdById: 'sara', roomId: 'room-1' };
const input = { keyId: 'key-1', keyOwnerId: 'khalid', bot };

beforeEach(() => {
  jest.resetAllMocks();
  room.mockResolvedValue({ world: { universeId: 'uni-1' } });
  lend.mockResolvedValue({ id: 'lend-1' });
  managesRoom.mockResolvedValue(true);
  managesBot.mockResolvedValue(true);
});

describe('who pays for a bot on a personal key (#709)', () => {
  it('lets a bot run on the key of anyone who manages it, not only its maker', async () => {
    expect(await checkKeyForBot(input)).toEqual({ ok: true, lendModels: null });
    expect(lend).toHaveBeenCalledWith({ where: { providerId_universeId: { providerId: 'key-1', universeId: 'uni-1' } }, select: { id: true, models: true } });
    // The key owner's own right to manage this bot, with no super-admin pass and no maker pass
    expect(managesBot).toHaveBeenCalledWith('khalid', null, bot, { creatorPasses: false });
  });

  it('still lets the maker run it on their own key', async () => {
    expect(await checkKeyForBot({ ...input, keyOwnerId: 'sara' })).toEqual({ ok: true, lendModels: null });
    expect(managesBot).toHaveBeenCalledWith('sara', null, bot, { creatorPasses: false });
  });

  it('checks the room for a bot that is not made yet', async () => {
    expect(await checkKeyForBot({ ...input, bot: { id: null, createdById: 'khalid', roomId: 'room-1' } })).toEqual({ ok: true, lendModels: null });
    expect(managesRoom).toHaveBeenCalledWith('khalid', 'room-1');
    expect(managesBot).not.toHaveBeenCalled();
  });

  it('is refused for a key that is no one’s', async () => {
    expect(await checkKeyForBot({ ...input, keyOwnerId: null })).toEqual({ ok: false, reason: 'no-owner' });
    expect(lend).not.toHaveBeenCalled();
  });

  it('is refused when the key is not lent to the universe the bot stands in', async () => {
    lend.mockResolvedValue(null);
    expect(await checkKeyForBot(input)).toEqual({ ok: false, reason: 'not-lent' });
    expect(managesBot).not.toHaveBeenCalled();
  });

  it('is refused once the key’s owner can no longer manage the bot', async () => {
    managesBot.mockResolvedValue(false);
    expect(await checkKeyForBot(input)).toEqual({ ok: false, reason: 'no-access' });
  });

  it('is refused for a room that is not there', async () => {
    room.mockResolvedValue(null);
    expect(await checkKeyForBot(input)).toEqual({ ok: false, reason: 'no-room' });
  });
});
