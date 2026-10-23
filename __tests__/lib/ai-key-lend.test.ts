import { prisma } from '@/lib/db';
import { permissionsForWorld } from '@/lib/roles';
import { addNotice } from '@/lib/notices';
import { flag } from '@/lib/permissions';
import { resolveUniverseAiProvider } from '@/lib/universe-ai';
import { lendAccess, lendableUniverses, moveBotsOffKey, moveBotsToAllowedModel, parseLendModels } from '@/lib/ai-key-lend';
import { changedLately } from '@/lib/ai-key-late-report';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn(), findMany: jest.fn() },
    worldMember: { findMany: jest.fn() },
    universeMember: { findMany: jest.fn() },
    bot: { findMany: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
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
  $transaction: jest.Mock;
};
const permissions = permissionsForWorld as jest.Mock;
const notice = addNotice as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  (resolveUniverseAiProvider as jest.Mock).mockResolvedValue({ providerId: 'server-1' });
  db.worldMember.findMany.mockResolvedValue([]);
  db.universeMember.findMany.mockResolvedValue([]);
  db.universe.findMany.mockResolvedValue([]);
  db.bot.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations));
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
    expect(db.bot.updateMany).toHaveBeenCalledTimes(3);
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { id: 'b2', aiProviderRef: 'key-1' }, data: { aiProviderRef: 'universe-ai', aiModel: null } });
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

  it('counts and tells about only the bots this request really moved when another request took some first', async () => {
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', bawes), bot('b2', 'Guide', bawes), bot('b3', 'Nora', sandbox)]);
    db.bot.updateMany.mockImplementation(async ({ where }: { where: { id: string } }) => ({ count: where.id === 'b2' ? 0 : 1 }));
    notice.mockResolvedValue(true);
    const result = await moveBotsOffKey('key-1', { actor, why: 'revoked' });
    expect(result.count).toBe(2);
    expect(result.universes.map((universe) => universe.botNames)).toEqual([['Sam'], ['Nora']]);
    expect(notice.mock.calls[0][0].title).toBe('Sam moved to Universe AI');
  });

  it('moves the bots in one transaction, so a failure moves none and tells nobody', async () => {
    db.bot.findMany.mockResolvedValue([bot('b1', 'Sam', bawes), bot('b2', 'Guide', sandbox)]);
    db.$transaction.mockRejectedValue(new Error('db down'));
    await expect(moveBotsOffKey('key-1', { actor, why: 'revoked' })).rejects.toThrow('db down');
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

describe('a lend that allows only some models (#575)', () => {
  const sandbox = { world: { universe: { id: 'uni-1', name: 'Sandbox Universe', ownerId: 'owner' } } };
  const key = { providerId: 'key-1', model: 'claude-sonnet-5-5' };
  beforeEach(() => {
    jest.resetAllMocks();
    db.$transaction.mockImplementation(async (calls: unknown[]) => Promise.all(calls));
    db.bot.updateMany.mockResolvedValue({ count: 1 });
  });

  it('reads the list: left out, null for all, or each model once', () => {
    expect(parseLendModels(undefined)).toEqual({ ok: true, models: undefined });
    expect(parseLendModels(null)).toEqual({ ok: true, models: null });
    expect(parseLendModels([' claude-haiku-5-5', 'claude-haiku-5-5'])).toEqual({ ok: true, models: ['claude-haiku-5-5'] });
    expect(parseLendModels([])).toMatchObject({ ok: false });
    expect(parseLendModels(['a', ''])).toMatchObject({ ok: false });
    expect(parseLendModels('a')).toMatchObject({ ok: false });
  });

  it('moves only the bots on a model taken out to the first kept one, and tells the universe’s owner when it is not yours', async () => {
    db.bot.findMany.mockResolvedValue([
      { id: 'b1', name: 'Guide', aiModel: 'claude-opus-5-5', room: sandbox },
      { id: 'b2', name: 'Nora', aiModel: 'claude-haiku-5-5', room: sandbox },
      // No model of its own: it was on the check model, which was taken out
      { id: 'b3', name: 'Scout', aiModel: null, room: sandbox },
    ]);
    const moved = await moveBotsToAllowedModel(key, { universeId: 'uni-1', allowed: ['claude-haiku-5-5'], firstAllowed: 'claude-haiku-5-5', actor: { id: 'maker', name: 'Mishari' } });
    expect(moved).toEqual({ count: 2 });
    expect(db.bot.updateMany).toHaveBeenCalledTimes(2);
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { id: 'b1', aiProviderRef: 'key-1', aiModel: 'claude-opus-5-5' }, data: { aiModel: 'claude-haiku-5-5' } });
    expect(db.bot.updateMany).toHaveBeenCalledWith({ where: { id: 'b3', aiProviderRef: 'key-1', aiModel: null }, data: { aiModel: 'claude-haiku-5-5' } });
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][0]).toMatchObject({ userId: 'owner', kind: 'ai-key-moved', title: '2 bots now reply with claude-haiku-5-5', href: '/admin/universes/uni-1' });
    expect(notice.mock.calls[0][0].body).toBe('Mishari changed which models of their AI key bots in Sandbox Universe may use. The 2 bots were on ones they took out, so they now reply with claude-haiku-5-5.');
    // A reply still on its way reports the model each bot had: it is let go for a few minutes
    expect(changedLately('b1')).toBe(true);
    expect(changedLately('b3')).toBe(true);
  });

  it('tells nobody when it is your own universe, and moves nobody when every bot is on a kept model', async () => {
    db.bot.findMany.mockResolvedValue([{ id: 'b1', name: 'Guide', aiModel: 'claude-opus-5-5', room: sandbox }]);
    await moveBotsToAllowedModel(key, { universeId: 'uni-1', allowed: ['claude-haiku-5-5'], firstAllowed: 'claude-haiku-5-5', actor: { id: 'owner', name: 'Khalid' } });
    expect(notice).not.toHaveBeenCalled();
    db.bot.updateMany.mockClear();
    expect(await moveBotsToAllowedModel(key, { universeId: 'uni-1', allowed: ['claude-opus-5-5'], firstAllowed: 'claude-opus-5-5', actor: { id: 'maker', name: null } })).toEqual({ count: 0 });
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });
});
