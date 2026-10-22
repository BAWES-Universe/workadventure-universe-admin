/**
 * People handle their own universes: being a super admin gives no access to other people's universes (who to invite,
 * which roles to give, whom to remove). The owner keeps everything, and a super admin who holds a role in someone
 * else's universe has exactly that role's rights, like anyone else.
 */
import { flag, fromKeys } from '@/lib/permissions';
import { accessFor, accessForMany, allows, ranksAbove, worldsAllowing } from '@/lib/role-access';

type Row = { key: string; position: number; permissions: bigint };

/** The few tables accessFor and accessForMany read, for a universe 'u' owned by 'owner' with worlds hq and campus. */
function fakeDb(members: Record<string, Row[] | 'plain'>) {
  const base = [
    { universeId: 'u', key: 'everyone', permissions: BigInt(0) },
    { universeId: 'u', key: 'member', permissions: BigInt(0) },
  ];
  const memberRow = (userId: string) => {
    const held = members[userId];
    if (!held) return null;
    return {
      universeId: 'u',
      userId,
      allWorlds: true,
      worldIds: [],
      roles: held === 'plain' ? [] : held.map((role) => ({ allWorlds: true, worldIds: [], role })),
    };
  };
  return {
    universe: {
      findUnique: async () => ({ ownerId: 'owner', worlds: [{ id: 'hq' }, { id: 'campus' }] }),
      findMany: async () => [{ id: 'u', ownerId: 'owner', worlds: [{ id: 'hq' }, { id: 'campus' }] }],
    },
    role: { findMany: async () => base },
    universeMember: {
      findUnique: async ({ where }: { where: { universeId_userId: { userId: string } } }) => memberRow(where.universeId_userId.userId),
      findMany: async ({ where }: { where: { userId: string } }) => [memberRow(where.userId)].filter(Boolean),
    },
  } as never;
}

const greeter: Row = { key: 'greeter', position: 10, permissions: fromKeys(['INVITE_AND_REMOVE']) };
const mod: Row = { key: 'mod', position: 20, permissions: fromKeys(['GIVE_ROLES', 'MANAGE_ROLES']) };
const superAdmin = { id: 'root', isSuperAdmin: true } as { id: string };

describe.each([
  ['accessFor', async (db: never, user: { id: string }) => accessFor(db, 'u', user)],
  ['accessForMany', async (db: never, user: { id: string }) => (await accessForMany(db, ['u'], user)).get('u') ?? null],
])('%s', (_name, load) => {
  it('gives the owner everything, above every role', async () => {
    const access = (await load(fakeDb({}), { id: 'owner' }))!;
    expect(access.full).toBe(true);
    expect(allows(access, 'INVITE_AND_REMOVE', { allWorlds: true })).toBe(true);
    expect(worldsAllowing(access, 'GIVE_ROLES')).toBe('all');
    expect(ranksAbove(access, { position: 99 })).toBe(true);
  });

  it('gives a super admin who is not in the universe nothing: no invite, no roles, no rank', async () => {
    const access = (await load(fakeDb({}), superAdmin))!;
    expect(access.full).toBe(false);
    expect(access.inUniverse).toBe(false);
    expect(allows(access, 'INVITE_AND_REMOVE', { allWorlds: true })).toBe(false);
    expect(allows(access, 'INVITE_AND_REMOVE', { allWorlds: false, worldIds: ['hq'] })).toBe(false);
    expect(worldsAllowing(access, 'INVITE_AND_REMOVE')).toEqual([]);
    expect(worldsAllowing(access, 'GIVE_ROLES')).toEqual([]);
    expect(ranksAbove(access, { position: 2 })).toBe(false);
  });

  it('gives a super admin who is a plain member only what a member has', async () => {
    const access = (await load(fakeDb({ root: 'plain' }), superAdmin))!;
    expect(access.full).toBe(false);
    expect(access.inUniverse).toBe(true);
    expect(worldsAllowing(access, 'INVITE_AND_REMOVE')).toEqual([]);
    expect(ranksAbove(access, { position: 2 })).toBe(false);
  });

  it('gives a super admin who holds a role in the universe exactly that role, like anyone else', async () => {
    const asGreeter = (await load(fakeDb({ root: [greeter] }), superAdmin))!;
    expect(asGreeter.full).toBe(false);
    expect(worldsAllowing(asGreeter, 'INVITE_AND_REMOVE')).toBe('all');
    expect(worldsAllowing(asGreeter, 'GIVE_ROLES')).toEqual([]);
    expect(ranksAbove(asGreeter, { position: 5 })).toBe(true);
    expect(ranksAbove(asGreeter, { position: 10 })).toBe(false);

    const asMod = (await load(fakeDb({ root: [mod] }), superAdmin))!;
    expect(worldsAllowing(asMod, 'GIVE_ROLES')).toBe('all');
    expect(worldsAllowing(asMod, 'INVITE_AND_REMOVE')).toEqual([]);
    expect(flag('GIVE_ROLES') & asMod.everywhere).not.toBe(BigInt(0));
  });

  it('treats someone with the same role who is not a super admin the same way', async () => {
    const root = (await load(fakeDb({ root: [greeter] }), superAdmin))!;
    const other = (await load(fakeDb({ other: [greeter] }), { id: 'other' }))!;
    expect(other.highest).toBe(root.highest);
    expect(worldsAllowing(other, 'INVITE_AND_REMOVE')).toEqual(worldsAllowing(root, 'INVITE_AND_REMOVE'));
  });
});
