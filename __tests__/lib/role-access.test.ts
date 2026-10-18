/**
 * Roles (#314): who may do what with roles and people. Rank decides which roles someone can touch, and a permission
 * from a role limited to some worlds only works there.
 */
import { flag, fromKeys } from '@/lib/permissions';
import { allows, computeAccess, mayChangePermissions, ranksAbove, scopeChange, worldsAllowing, type AccessInput } from '@/lib/role-access';

const base: AccessInput = {
  universeId: 'u',
  worldIds: ['a', 'b'],
  full: false,
  isOwner: false,
  everyone: BigInt(0),
  member: BigInt(0),
  membership: { allWorlds: true, worldIds: [] },
  roles: [],
};

describe('computeAccess', () => {
  it('ranks someone by their highest role; a member who holds none ranks as Member', () => {
    expect(computeAccess(base).highest).toBe(1);
    expect(computeAccess({ ...base, membership: null }).highest).toBe(0);
    const ranked = computeAccess({
      ...base,
      roles: [
        { key: 'helper', position: 11, permissions: BigInt(0), allWorlds: true, worldIds: [] },
        { key: 'mod', position: 20, permissions: BigInt(0), allWorlds: false, worldIds: ['a'] },
      ],
    });
    expect(ranked.highest).toBe(20);
  });

  it('puts the owner above every role', () => {
    const owner = computeAccess({ ...base, full: true, isOwner: true, membership: null });
    expect(owner.highest).toBe(Infinity);
    expect(ranksAbove(owner, { position: 1_000_000 })).toBe(true);
    expect(allows(owner, 'MANAGE_ROLES', { allWorlds: true })).toBe(true);
  });

  it('lets a world-limited permission work only in its worlds', () => {
    const access = computeAccess({
      ...base,
      roles: [{ key: 'mod', position: 20, permissions: flag('GIVE_ROLES'), allWorlds: false, worldIds: ['a'] }],
    });
    expect(allows(access, 'GIVE_ROLES', { allWorlds: false, worldIds: ['a'] })).toBe(true);
    expect(allows(access, 'GIVE_ROLES', { allWorlds: false, worldIds: ['a', 'b'] })).toBe(false);
    expect(allows(access, 'GIVE_ROLES', { allWorlds: true })).toBe(false);
    expect(worldsAllowing(access, 'GIVE_ROLES')).toEqual(['a']);
  });

  it('ignores worlds that were deleted, but still needs the permission somewhere', () => {
    const access = computeAccess({
      ...base,
      roles: [{ key: 'mod', position: 20, permissions: flag('INVITE_AND_REMOVE'), allWorlds: false, worldIds: ['a'] }],
    });
    expect(allows(access, 'INVITE_AND_REMOVE', { allWorlds: false, worldIds: ['a', 'gone'] })).toBe(true);
    expect(allows(access, 'INVITE_AND_REMOVE', { allWorlds: false, worldIds: ['gone'] })).toBe(true);
    expect(allows(access, 'GIVE_ROLES', { allWorlds: false, worldIds: ['gone'] })).toBe(false);
    expect(allows(access, 'INVITE_AND_REMOVE', { allWorlds: false, worldIds: ['b', 'gone'] })).toBe(false);
  });

  it('counts Everyone and an all-worlds Member everywhere', () => {
    const access = computeAccess({ ...base, everyone: flag('GO_LIVE'), member: flag('SEND_MESSAGES') });
    expect(allows(access, 'GO_LIVE', { allWorlds: true })).toBe(true);
    expect(allows(access, 'SEND_MESSAGES', { allWorlds: true })).toBe(true);
    const someWorlds = computeAccess({ ...base, member: flag('SEND_MESSAGES'), membership: { allWorlds: false, worldIds: ['a'] } });
    expect(allows(someWorlds, 'SEND_MESSAGES', { allWorlds: true })).toBe(false);
    expect(allows(someWorlds, 'SEND_MESSAGES', { allWorlds: false, worldIds: ['a'] })).toBe(true);
  });

  it('gives Administrator every permission', () => {
    const access = computeAccess({
      ...base,
      roles: [{ key: 'boss', position: 30, permissions: flag('ADMINISTRATOR'), allWorlds: true, worldIds: [] }],
    });
    expect(worldsAllowing(access, 'MANAGE_BOTS')).toBe('all');
    expect(mayChangePermissions(access, BigInt(0), fromKeys(['ADMINISTRATOR', 'GO_LIVE']))).toBe(true);
  });
});

describe('mayChangePermissions', () => {
  const access = computeAccess({
    ...base,
    roles: [{ key: 'mod', position: 20, permissions: fromKeys(['MANAGE_ROLES', 'GO_LIVE']), allWorlds: true, worldIds: [] }],
  });

  it('lets someone turn on or off only permissions they have', () => {
    expect(mayChangePermissions(access, BigInt(0), flag('GO_LIVE'))).toBe(true);
    expect(mayChangePermissions(access, BigInt(0), flag('EDIT_MAPS'))).toBe(false);
    expect(mayChangePermissions(access, flag('EDIT_MAPS'), BigInt(0))).toBe(false);
    // A permission they lack can stay as it is while they change others
    expect(mayChangePermissions(access, flag('EDIT_MAPS'), fromKeys(['EDIT_MAPS', 'GO_LIVE']))).toBe(true);
  });
});

describe('scopeChange', () => {
  it('reaches the worlds added or dropped, and every world when "all worlds" changes', () => {
    expect(scopeChange({ allWorlds: false, worldIds: ['a'] }, { allWorlds: false, worldIds: ['a', 'b'] })).toEqual({ allWorlds: false, worldIds: ['b'] });
    expect(scopeChange({ allWorlds: false, worldIds: ['a', 'b'] }, { allWorlds: false, worldIds: ['b'] })).toEqual({ allWorlds: false, worldIds: ['a'] });
    expect(scopeChange(null, { allWorlds: false, worldIds: ['a'] })).toEqual({ allWorlds: false, worldIds: ['a'] });
    expect(scopeChange({ allWorlds: false, worldIds: ['a'] }, { allWorlds: true, worldIds: [] })).toEqual({ allWorlds: true });
    expect(scopeChange({ allWorlds: true, worldIds: [] }, { allWorlds: true, worldIds: [] })).toEqual({ allWorlds: false, worldIds: [] });
  });
});
