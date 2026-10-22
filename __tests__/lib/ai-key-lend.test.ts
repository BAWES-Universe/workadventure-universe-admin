import { prisma } from '@/lib/db';
import { permissionsForWorld } from '@/lib/roles';
import { addNotice } from '@/lib/notices';
import { flag } from '@/lib/permissions';
import { resolveUniverseAiProvider } from '@/lib/universe-ai';
import { lendAccess, lendableUniverses, moveBotsOffKey } from '@/lib/ai-key-lend';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn(), findMany: jest.fn() },
    worldMember: { findMany: jest.fn() },
    universeMember: { findMany: jest.fn() },
    bot: { findMany: jest.fn(), updateMany: jest.fn() },
  },
}));
jest.mock('@/lib/roles', () => ({ permissionsForWorld: jest.fn() }));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn() }));
jest.mock('@/lib/universe-ai', () => ({ ...jest.requireActual('@/lib/universe-ai'), resolveUniverseAiProvider: jest.fn() }));

const db = prisma as unknown as {
  universe: Record<'findUnique' | 'findMany', jest.Mock>;
  worldMember: Record<'findMany', jest.Mock>;
  universeMember: Record<'findMany', jest.Mock>;
  bot: Record<'findMany' | 'updateMany', jest.Mock>;
};
const permissions = permissionsForWorld as jest.Mock;
const notice = addNotice as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  (resolveUniverseAiProvider as jest.Mock).mockResolvedValue({ providerId: 'server-1' });
  db.worldMember.findMany.mockResolvedValue([]);
  db.universeMember.findMany.mockResolvedValue([]);
  db.universe.findMany.mockResolvedValue([]);
  db.bot.updateMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length }));
});

describe('lendAccess', () => {
  it('lets the owner of a universe lend to it, without looking at any role', async () => {
    db.universe.findUnique.mockResolvedValue({ ownerId: 'u1', worlds: [{ id: 'w1' }] });
    expect(await lendAccess('u1', 'uni')).toBe('owner');
    expect(permissions).not.toHaveBeenCalled();
  });

  it('lets someone with Manage bots in any world of it lend, reading their tags for that world', async () => {
    db.universe.findUnique.mockResolvedValue({ ownerId: 'boss', worlds: [{ id: 'w1' }, { id: 'w2' }] });
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'w2', tags: ['editor'] }]);
    permissions.mockImplementation(async ({ worldId }: { worldId: string }) => (worldId === 'w2' ? flag('MANAGE_BOTS') : BigInt(0)));
    expect(await lendAccess('u1', 'uni')).toBe('manage');
    expect(permissions).toHaveBeenCalledWith({ userId: 'u1', worldId: 'w2', universeId: 'uni', worldTags: ['editor'] });
    expect(permissions).toHaveBeenCalledWith({ userId: 'u1', worldId: 'w1', universeId: 'uni', worldTags: [] });
  });

  it('says no to someone without Manage bots anywhere in it, and to a universe that is not there', async () => {
    db.universe.findUnique.mockResolvedValue({ ownerId: 'boss', worlds: [{ id: 'w1' }] });
    permissions.mockResolvedValue(flag('CHAT_BOTS_NEARBY'));
    expect(await lendAccess('u1', 'uni')).toBeNull();
    db.universe.findUnique.mockResolvedValue(null);
    expect(await lendAccess('u1', 'gone')).toBeNull();
  });
});

describe('lendableUniverses', () => {
  it('lists owned universes and the ones they manage bots in, by name, and leaves out the rest', async () => {
    db.universe.findMany.mockResolvedValue([{ id: 'sandbox', name: 'Sandbox Universe' }]);
    db.worldMember.findMany.mockResolvedValue([{ world: { universe: { id: 'uniboz', name: 'uniboz' } } }, { world: { universe: { id: 'other', name: 'Other' } } }]);
    db.universeMember.findMany.mockResolvedValue([{ universe: { id: 'uniboz', name: 'uniboz' } }]);
    db.universe.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ ownerId: where.id === 'sandbox' ? 'u1' : 'boss', worlds: [{ id: `${where.id}-w` }] }));
    permissions.mockImplementation(async ({ universeId }: { universeId: string }) => (universeId === 'uniboz' ? flag('MANAGE_BOTS') : BigInt(0)));
    expect(await lendableUniverses('u1')).toEqual([
      { id: 'sandbox', name: 'Sandbox Universe', access: 'owner' },
      { id: 'uniboz', name: 'uniboz', access: 'manage' },
    ]);
  });
});

const bot = (id: string, name: string, universe: { id: string; name: string; ownerId: string }) => ({ id, name, room: { world: { universe } } });
const bawes = { id: 'bawes', name: 'BAWES Universe', ownerId: 'owner-bawes' };
const sandbox = { id: 'sandbox', name: 'Sandbox Universe', ownerId: 'owner-sandbox' };
const actor = { id: 'u1', name: 'Mishari' };

describe('moveBotsOffKey', () => {
  it('moves every bot on the key to Universe AI and tells each universe’s owner once', async () => {
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', bawes), bot('b2', 'Guide', sandbox), bot('b3', 'Nora', sandbox)]);
    notice.mockResolvedValue(true);
    const result = await moveBotsOffKey('key-1', { actor, why: 'revoked' });
    expect(db.bot.findMany.mock.calls[0][0].where).toEqual({ aiProviderRef: 'key-1' });
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['b1', 'b2', 'b3'] }, aiProviderRef: 'key-1' }, data: { aiProviderRef: 'universe-ai' } });
    expect(result.count).toBe(3);
    expect(notice).toHaveBeenCalledTimes(2);
    expect(notice.mock.calls[0][0]).toMatchObject({ userId: 'owner-bawes', kind: 'ai-key-moved', title: 'Sam moved to Universe AI', href: '/admin/universes/bawes' });
    expect(notice.mock.calls[0][0].body).toBe('Mishari revoked their AI key. The bot now replies on Universe AI.');
    expect(notice.mock.calls[1][0]).toMatchObject({ userId: 'owner-sandbox', title: '2 bots moved to Universe AI' });
    expect(notice.mock.calls[1][0].body).toBe('Mishari revoked their AI key. The 2 bots now reply on Universe AI.');
  });

  it('pulling from one universe touches only that universe’s bots, and says where it was pulled from', async () => {
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', bawes)]);
    await moveBotsOffKey('key-1', { universeId: 'bawes', actor, why: 'pulled' });
    expect(db.bot.findMany.mock.calls[0][0].where).toEqual({ aiProviderRef: 'key-1', room: { world: { universeId: 'bawes' } } });
    expect(notice.mock.calls[0][0].body).toBe('Mishari pulled their AI key from BAWES Universe. The bot now replies on Universe AI.');
  });

  it('does not tell someone about their own action', async () => {
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', { ...bawes, ownerId: 'u1' })]);
    await moveBotsOffKey('key-1', { actor, why: 'revoked' });
    expect(db.bot.updateMany).toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it('says so when Universe AI has no provider, and tells the owner even of their own action', async () => {
    (resolveUniverseAiProvider as jest.Mock).mockResolvedValue(null);
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', { ...bawes, ownerId: 'u1' })]);
    await moveBotsOffKey('key-1', { actor, why: 'revoked' });
    expect(db.bot.updateMany).toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][0].body).toBe(
      'Mishari revoked their AI key. The bot now replies on Universe AI. Universe AI has no provider switched on yet, so they stay quiet until a super admin enables one.',
    );
  });

  it('moves the bots and sends the usual notice when Universe AI can’t be checked', async () => {
    (resolveUniverseAiProvider as jest.Mock).mockRejectedValue(new Error('db down'));
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', bawes)]);
    await moveBotsOffKey('key-1', { actor, why: 'revoked' });
    expect(notice.mock.calls[0][0].body).toBe('Mishari revoked their AI key. The bot now replies on Universe AI.');
  });

  it('tells nobody when a request that ran at the same time already moved the bots', async () => {
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', bawes)]);
    db.bot.updateMany.mockResolvedValue({ count: 0 });
    expect(await moveBotsOffKey('key-1', { actor, why: 'revoked' })).toEqual({ count: 0, universes: [] });
    expect(notice).not.toHaveBeenCalled();
  });

  it('changes nothing when no bot is on the key', async () => {
    db.bot.findMany.mockResolvedValue([]);
    expect(await moveBotsOffKey('key-1', { actor, why: 'revoked' })).toEqual({ count: 0, universes: [] });
    expect(db.bot.updateMany).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it('keeps the bots moved, and logs, when a notice can’t be saved', async () => {
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', bawes)]);
    notice.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await moveBotsOffKey('key-1', { actor, why: 'revoked' })).count).toBe(1);
    expect(spy).toHaveBeenCalledWith('[AiKeys] Could not tell the universe owner:', 'db down');
    spy.mockRestore();
  });
});
