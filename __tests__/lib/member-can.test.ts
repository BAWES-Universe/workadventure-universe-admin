/**
 * What you may change about another member: the roles below yours, where, and whether to remove them.
 */
import { fromKeys } from '@/lib/permissions';
import { computeAccess, type AccessInput } from '@/lib/role-access';
import { memberCan, rankOfMember, reachOfMember } from '@/lib/member-can';

const base: AccessInput = {
  universeId: 'u', worldIds: ['hq', 'campus'], full: false, isOwner: false, everyone: BigInt(0), member: BigInt(0),
  membership: { allWorlds: true, worldIds: [] }, roles: [],
};
const as = (position: number, keys: Parameters<typeof fromKeys>[0], worlds: string[] | 'all' = 'all') =>
  computeAccess({ ...base, roles: [{ key: 'r', position, permissions: fromKeys(keys), allWorlds: worlds === 'all', worldIds: worlds === 'all' ? [] : worlds }] });
const owner = computeAccess({ ...base, full: true, isOwner: true, membership: null });
const member = (position?: number) => ({ allWorlds: true, worldIds: [] as string[], roles: position ? [{ allWorlds: true, worldIds: [] as string[], role: { position } }] : [] });
const ROLES = [{ id: 'low', position: 5 }, { id: 'mid', position: 12 }, { id: 'high', position: 30 }];
const can = (access: ReturnType<typeof computeAccess>, who: ReturnType<typeof member>, extra: { userId?: string; ownerId?: string } = {}) =>
  memberCan({ access, viewerId: 'me', userId: extra.userId ?? 'them', ownerId: extra.ownerId ?? 'owner', member: who, roles: ROLES });

describe('memberCan', () => {
  it('lets someone who gives roles give the roles below their own to someone below them', () => {
    expect(can(as(20, ['GIVE_ROLES']), member())).toEqual({ giveRoleIds: ['low', 'mid'], giveWorlds: 'all', remove: false });
  });

  it('gives nothing to someone at or above your rank', () => {
    expect(can(as(20, ['GIVE_ROLES', 'INVITE_AND_REMOVE']), member(20))).toMatchObject({ giveRoleIds: [], remove: false });
    expect(can(as(20, ['GIVE_ROLES', 'INVITE_AND_REMOVE']), member(30))).toMatchObject({ giveRoleIds: [], remove: false });
  });

  it('lets someone who invites and removes take a member below them out, and not without that permission', () => {
    expect(can(as(20, ['INVITE_AND_REMOVE']), member(5))).toMatchObject({ giveRoleIds: [], remove: true });
    expect(can(as(20, ['GIVE_ROLES']), member(5)).remove).toBe(false);
  });

  it('removes only where you may invite, across every world they are in', () => {
    expect(can(as(20, ['INVITE_AND_REMOVE'], ['hq']), member()).remove).toBe(false);
    const inHq = { allWorlds: false, worldIds: ['hq'], roles: [] };
    expect(can(as(20, ['INVITE_AND_REMOVE'], ['hq']), inHq).remove).toBe(true);
  });

  it('gives the owner everything over anyone but themselves, and nothing over the owner', () => {
    expect(can(owner, member(30))).toMatchObject({ giveRoleIds: ['low', 'mid', 'high'], remove: true });
    expect(can(as(20, ['GIVE_ROLES', 'INVITE_AND_REMOVE']), member(), { userId: 'owner' })).toMatchObject({ giveRoleIds: [], remove: false });
  });

  it('lets anyone leave, except the owner', () => {
    expect(can(as(5, []), member(30), { userId: 'me' }).remove).toBe(true);
    expect(can(owner, member(), { userId: 'me', ownerId: 'me' }).remove).toBe(false);
  });

  it('gives a super admin who is no part of the universe nothing', () => {
    const nobody = computeAccess({ ...base, membership: null });
    expect(can(nobody, member())).toEqual({ giveRoleIds: [], giveWorlds: [], remove: false });
  });
});

describe('rankOfMember and reachOfMember', () => {
  it('ranks a member by their highest role, Member at least, and the owner above all', () => {
    expect(rankOfMember(member(), false)).toBe(1);
    expect(rankOfMember(member(12), false)).toBe(12);
    expect(rankOfMember(member(), true)).toBe(Infinity);
  });

  it('reaches every world through the membership or any role, else the union of worlds', () => {
    expect(reachOfMember(member())).toEqual({ allWorlds: true });
    expect(reachOfMember({ allWorlds: false, worldIds: ['hq'], roles: [{ allWorlds: false, worldIds: ['campus'], role: { position: 5 } }] })).toEqual({ allWorlds: false, worldIds: ['hq', 'campus'] });
    expect(reachOfMember({ allWorlds: false, worldIds: ['hq'], roles: [{ allWorlds: true, worldIds: [], role: { position: 5 } }] })).toEqual({ allWorlds: true });
  });
});

