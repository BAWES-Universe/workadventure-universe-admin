jest.mock('@/lib/db', () => ({ prisma: {} }));

import { flag } from '@/lib/permissions';
import {
  ADMIN_KEY,
  BUILT_IN_ROLES,
  EDITOR_DEFAULT_PERMISSIONS,
  permissionsFromTags,
  permissionsInWorld,
  tagsByWorld,
  worldsOf,
} from '@/lib/roles';
import { isEmptyScope, unionScope, withoutWorld } from '@/lib/universe-members';

const WORLDS = ['hq', 'campus', 'lab'];
const role = (key: string, position: number, permissions: bigint, worldIds: string[] | 'all') => ({
  key,
  position,
  permissions,
  allWorlds: worldIds === 'all',
  worldIds: worldIds === 'all' ? [] : worldIds,
});

describe('roles', () => {
  it('ranks Admin above every custom role, and Editor and Member below them', () => {
    const position = Object.fromEntries(BUILT_IN_ROLES.map((built) => [built.key, built.position]));
    expect(position.admin).toBeGreaterThan(100_000);
    expect(position.editor).toBeLessThan(10);
    expect(position.member).toBeLessThan(position.editor);
    expect(position.everyone).toBeLessThan(position.member);
  });

  it('gives the built-in Editor exactly what the editor tag allows today', () => {
    expect(EDITOR_DEFAULT_PERMISSIONS).toBe(
      flag('MANAGE_WORLDS') | flag('MANAGE_ROOMS') | flag('EDIT_MAPS') | flag('MANAGE_BOTS'),
    );
    expect(permissionsFromTags(['editor'])).toBe(EDITOR_DEFAULT_PERMISSIONS);
    expect(permissionsFromTags(['member', 'finance'])).toBe(BigInt(0));
  });

  it('lists the worlds a scope covers, ignoring worlds that no longer exist', () => {
    expect(worldsOf({ allWorlds: true, worldIds: [] }, WORLDS)).toEqual(WORLDS);
    expect(worldsOf({ allWorlds: false, worldIds: ['lab', 'gone'] }, WORLDS)).toEqual(['lab']);
  });

  it('tags someone with their roles in each world, highest first, then member', () => {
    const tags = tagsByWorld(
      { allWorlds: false, worldIds: ['hq'] },
      [role('accountant', 20, BigInt(0), ['campus']), role(ADMIN_KEY, 1_000_000, BigInt(0), ['hq', 'campus'])],
      WORLDS,
    );
    expect(Object.fromEntries(tags)).toEqual({
      hq: ['admin', 'member'],
      campus: ['admin', 'accountant', 'member'],
    });
  });

  it('puts a member with a role in every world in every world, a new one included', () => {
    const tags = tagsByWorld({ allWorlds: false, worldIds: [] }, [role('editor', 2, BigInt(0), 'all')], [...WORLDS, 'new']);
    expect([...tags.keys()]).toEqual([...WORLDS, 'new']);
  });

  it('never writes member twice, and leaves out Everyone', () => {
    const tags = tagsByWorld(
      { allWorlds: true, worldIds: [] },
      [role('member', 1, BigInt(0), 'all'), role('everyone', 0, BigInt(0), 'all')],
      ['hq'],
    );
    expect(tags.get('hq')).toEqual(['member']);
  });

  it('adds up Everyone, Member and the roles that work in the world', () => {
    const everyone = flag('SEND_MESSAGES');
    const member = flag('GO_LIVE');
    const roles = [role('mod', 30, flag('MODERATE_CALLS'), ['hq']), role('ed', 2, flag('EDIT_MAPS'), ['lab'])];
    const scope = { allWorlds: false, worldIds: ['hq'] };
    const inHq = permissionsInWorld('hq', everyone, { scope, member, inWorld: true }, roles);
    expect(inHq).toBe(everyone | member | flag('MODERATE_CALLS'));
    const guest = permissionsInWorld('hq', everyone, null, []);
    expect(guest).toBe(everyone);
  });

  it('expands Administrator to every permission', () => {
    const roles = [role('owner-like', 40, flag('ADMINISTRATOR'), 'all')];
    const result = permissionsInWorld('lab', BigInt(0), null, roles);
    expect(result & flag('EDIT_MAPS')).toBe(flag('EDIT_MAPS'));
    expect(result & flag('KICK_FROM_ROOM')).toBe(flag('KICK_FROM_ROOM'));
  });
});

describe('world scopes', () => {
  it('joins two scopes', () => {
    expect(unionScope({ allWorlds: false, worldIds: ['hq'] }, { allWorlds: false, worldIds: ['lab', 'hq'] })).toEqual({
      allWorlds: false,
      worldIds: ['hq', 'lab'],
    });
    expect(unionScope({ allWorlds: true, worldIds: [] }, { allWorlds: false, worldIds: ['lab'] }).allWorlds).toBe(true);
  });

  it('takes one world out, turning every world into the list of the others', () => {
    expect(withoutWorld({ allWorlds: true, worldIds: [] }, 'hq', WORLDS)).toEqual({ allWorlds: false, worldIds: ['campus', 'lab'] });
    const none = withoutWorld({ allWorlds: false, worldIds: ['hq'] }, 'hq', WORLDS);
    expect(isEmptyScope(none)).toBe(true);
  });
});
