import { flag, fromKeys, toWire } from '@/lib/permissions';
import {
  ROLE_TEMPLATES,
  builtInRoles,
  canGiveRole,
  changedCount,
  countOn,
  firstMissing,
  freshColour,
  inheritedPermissions,
  movableRoles,
  seesHiddenRoles,
  permissionLockReason,
  permissionSummary,
  roleLine,
  roleLockReason,
  scopeLabel,
  type MeResponse,
  type RoleRow,
  type Viewer,
} from '@/lib/role-ui';

function role(over: Partial<RoleRow>): RoleRow {
  return {
    id: over.key ?? 'r',
    key: 'x',
    name: 'X',
    color: '#34D399',
    showBadge: true,
    permissions: '0',
    position: 12,
    builtIn: false,
    people: 0,
    canEdit: true,
    ...over,
  };
}

const owner: Viewer = { full: true, everywhere: BigInt(0), canManageRoles: true };
const lead: Viewer = { full: false, everywhere: fromKeys(['MANAGE_ROLES', 'EDIT_MAPS']), canManageRoles: true };

describe('templates', () => {
  it('match the approved ones', () => {
    const byId = Object.fromEntries(ROLE_TEMPLATES.map((template) => [template.id, template.keys]));
    expect(byId.blank).toEqual([]);
    expect(byId.moderator).toEqual(['MODERATE_CALLS', 'KICK_FROM_ROOM', 'BAN_AND_APPEALS', 'MODERATE_AREA_CHATS']);
    expect(byId.host).toEqual(['GO_LIVE', 'SEND_MESSAGES']);
    expect(byId.builder).toEqual(['EDIT_MAPS', 'MANAGE_ROOMS']);
  });
});

describe('which switches are locked, and why', () => {
  const custom = role({ key: 'accountant', name: 'Accountant' });

  it('locks every switch of Admin, whoever looks', () => {
    const admin = role({ key: 'admin', name: 'Admin', builtIn: true });
    expect(permissionLockReason(admin, owner, fromKeys(['GO_LIVE']), 'GO_LIVE', 'BAWES')).toBe('Admin always has every permission');
  });

  it('leaves everything free for the owner', () => {
    expect(permissionLockReason(custom, owner, BigInt(0), 'ADMINISTRATOR', 'BAWES')).toBeNull();
  });

  it('locks a permission the viewer does not have, in the "Needs" wording, with the universe filled in', () => {
    expect(permissionLockReason(custom, lead, BigInt(0), 'GO_LIVE', 'BAWES')).toBe('Needs Go live');
    expect(permissionLockReason(custom, lead, BigInt(0), 'REACH_UNIVERSE', 'BAWES')).toBe('Needs Reach all of BAWES');
    expect(permissionLockReason(custom, lead, BigInt(0), 'EDIT_MAPS', 'BAWES')).toBeNull();
  });

  it('locks the whole role when the viewer cannot edit it, saying what is missing', () => {
    const above = role({ key: 'boss', name: 'Boss', canEdit: false });
    expect(permissionLockReason(above, lead, BigInt(0), 'EDIT_MAPS', 'BAWES')).toBe('Needs a role above Boss');
    const noManage = { ...lead, canManageRoles: false };
    expect(roleLockReason(above, noManage)).toBe('Needs Manage roles in every world');
    expect(roleLockReason(custom, lead)).toBeNull();
  });

  it('says a permission is included while Administrator is on', () => {
    const withAdmin = fromKeys(['ADMINISTRATOR']);
    expect(permissionLockReason(custom, owner, withAdmin, 'GO_LIVE', 'BAWES')).toBe('Included in Administrator');
    expect(permissionLockReason(custom, owner, withAdmin, 'ADMINISTRATOR', 'BAWES')).toBeNull();
  });

  it('finds the first permission a template needs that the viewer lacks', () => {
    expect(firstMissing(lead, fromKeys(['EDIT_MAPS']))).toBeNull();
    expect(firstMissing(lead, fromKeys(['EDIT_MAPS', 'MANAGE_ROOMS']))).toBe('MANAGE_ROOMS');
    expect(firstMissing(owner, fromKeys(['MODERATE_CALLS']))).toBeNull();
    expect(firstMissing({ ...lead, everywhere: flag('ADMINISTRATOR') }, fromKeys(['MODERATE_CALLS']))).toBeNull();
  });
});

describe('counting and summaries', () => {
  it('counts the 17 everyday permissions, Administrator standing for all of them', () => {
    expect(countOn(fromKeys(['GO_LIVE']))).toBe(1);
    expect(countOn(fromKeys(['ADMINISTRATOR']))).toBe(17);
    expect(changedCount(fromKeys(['GO_LIVE']), fromKeys(['GO_LIVE', 'EDIT_MAPS']))).toBe(1);
  });

  it('writes a short line for a role row', () => {
    expect(permissionSummary(BigInt(0))).toBe('No extra permissions');
    expect(permissionSummary(fromKeys(['GO_LIVE']))).toBe('Go live');
    expect(permissionSummary(fromKeys(['MODERATE_CALLS', 'KICK_FROM_ROOM']))).toBe('Kick from rooms, moderate calls');
    expect(permissionSummary(fromKeys(['GIVE_ROLES', 'MANAGE_ROLES', 'GO_LIVE', 'EDIT_MAPS', 'MANAGE_BOTS']))).toBe('5 permissions');
    expect(roleLine(role({ people: 1, permissions: toWire(fromKeys(['GO_LIVE'])) }))).toBe('1 person · Go live');
    expect(roleLine(role({ key: 'member', builtIn: true, people: 23 }))).toBe('23 people · Everyone who joined, given automatically');
    expect(roleLine(role({ key: 'everyone', builtIn: true, people: null }))).toBe('Every visitor · No extra permissions');
    // A new universe's Everyone: the three bot permissions
    const bots = toWire(fromKeys(['CHAT_BOTS_NEARBY', 'DM_BOTS', 'SUMMON_BOTS']));
    expect(roleLine(role({ key: 'everyone', builtIn: true, people: null, permissions: bots }))).toBe(
      'Every visitor · Chat with bots nearby, DM bots, summon bots',
    );
  });
});

describe('the list', () => {
  const roles = [
    role({ id: 'a', key: 'admin', builtIn: true, position: 1_000_000 }),
    role({ id: 'lead', key: 'lead', position: 40 }),
    role({ id: 'mod', key: 'mod', position: 13 }),
    role({ id: 'acc', key: 'acc', position: 12 }),
    role({ id: 'e', key: 'editor', builtIn: true, position: 2 }),
    role({ id: 'm', key: 'member', builtIn: true, position: 1 }),
    role({ id: 'ev', key: 'everyone', builtIn: true, position: 0 }),
  ];
  const me = (highest: number | null, full = false, canManageRoles = true) => ({ full, highestPosition: highest, canManageRoles });

  it('moves only the custom roles below the viewer', () => {
    expect(movableRoles(roles, me(40)).map((r) => r.id)).toEqual(['mod', 'acc']);
    expect(movableRoles(roles, me(null, true)).map((r) => r.id)).toEqual(['lead', 'mod', 'acc']);
    expect(movableRoles(roles, me(1))).toEqual([]);
  });

  it('moves nothing without Manage roles in every world, however high the viewer ranks', () => {
    expect(movableRoles(roles, me(40, false, false))).toEqual([]);
    expect(movableRoles(roles, me(null, true, false))).toEqual([]);
  });

  it('lists the built-in roles Everyone, Admin, Editor, Member', () => {
    expect(builtInRoles(roles).map((r) => r.key)).toEqual(['everyone', 'admin', 'editor', 'member']);
  });

  it('lets the viewer give only roles below theirs, never Member or Everyone', () => {
    const base = { giveWorlds: 'all' as const };
    expect(canGiveRole(roles[3], { ...base, ...me(40) })).toBe(true);
    expect(canGiveRole(roles[1], { ...base, ...me(40) })).toBe(false);
    expect(canGiveRole(roles[5], { ...base, ...me(null, true) })).toBe(false);
    expect(canGiveRole(roles[3], { giveWorlds: [] as string[], ...me(40) } as MeResponse)).toBe(false);
  });

  it('starts a new role in a colour nobody wears yet', () => {
    expect(freshColour([])).toBe('#F87171');
    expect(freshColour(['#f87171'])).toBe('#FB923C');
  });
});

describe('where someone has a role', () => {
  const worlds = [
    { id: 'hq', name: 'HQ' },
    { id: 'campus', name: 'Campus' },
  ];
  it('says Everywhere, one world or several', () => {
    expect(scopeLabel({ allWorlds: true, worldIds: [] }, worlds)).toBe('Everywhere');
    expect(scopeLabel({ allWorlds: false, worldIds: ['hq'] }, worlds)).toBe('HQ only');
    expect(scopeLabel({ allWorlds: false, worldIds: ['hq', 'campus'] }, worlds)).toBe('HQ, Campus');
  });
});

describe('who sees the holders of a role whose badge is off', () => {
  const base = { full: false, canManageRoles: false, giveWorlds: [] as 'all' | string[] };
  it('is anyone who manages roles or gives them somewhere, and the owner', () => {
    expect(seesHiddenRoles({ ...base, full: true })).toBe(true);
    expect(seesHiddenRoles({ ...base, canManageRoles: true })).toBe(true);
    expect(seesHiddenRoles({ ...base, giveWorlds: 'all' })).toBe(true);
    expect(seesHiddenRoles({ ...base, giveWorlds: ['hq'] })).toBe(true);
  });
  it('is not anyone else', () => {
    expect(seesHiddenRoles(base)).toBe(false);
  });
});

describe('what a role inherits', () => {
  const everyone = role({ key: 'everyone', builtIn: true, permissions: toWire(fromKeys(['CHAT_BOTS_NEARBY', 'DM_BOTS'])) });
  const member = role({ key: 'member', builtIn: true, permissions: toWire(fromKeys(['DM_BOTS', 'SUMMON_BOTS'])) });
  const all = [everyone, member];

  it('gives Member only what Everyone has', () => {
    expect([...inheritedPermissions(member, all)]).toEqual([
      ['CHAT_BOTS_NEARBY', 'Everyone'],
      ['DM_BOTS', 'Everyone'],
    ]);
  });

  it('gives Editor and custom roles Everyone first, then Member', () => {
    const expected = [
      ['CHAT_BOTS_NEARBY', 'Everyone'],
      ['DM_BOTS', 'Everyone'],
      ['SUMMON_BOTS', 'Member'],
    ];
    expect([...inheritedPermissions(role({ key: 'editor', builtIn: true }), all)]).toEqual(expected);
    expect([...inheritedPermissions(role({ key: 'mod' }), all)]).toEqual(expected);
  });

  it('gives Everyone and Admin nothing, and a custom role named like a built-in key is still custom', () => {
    expect(inheritedPermissions(everyone, all).size).toBe(0);
    expect(inheritedPermissions(role({ key: 'admin', builtIn: true }), all).size).toBe(0);
    expect(inheritedPermissions(role({ key: 'x' }), [role({ key: 'everyone', builtIn: false, permissions: '65536' })]).size).toBe(0);
  });
});
