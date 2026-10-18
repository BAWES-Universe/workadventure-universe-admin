/**
 * Roles (#314) migration: the helper runs the real migrations on a throwaway database, with world members and
 * invitations saved the way Orbit did before roles, then the roles migration.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Member = { user_id: string; world_id: string; tags: string[]; joined_at: string };
type Result = {
  before: Member[];
  after: Member[];
  roles: { universe_id: string; key: string; permissions: string; position: number; built_in: boolean }[];
  members: { universe_id: string; user_id: string; all_worlds: boolean; world_ids: string[]; joined_at: string }[];
  given: { universe_id: string; user_id: string; key: string; all_worlds: boolean; world_ids: string[] }[];
  invitations: { id: string; universe_id: string; all_worlds: boolean; world_ids: string[]; role_keys: string[] }[];
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-roles-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

const keysOf = (universe: string) => result.roles.filter((role) => role.universe_id === universe).map((role) => role.key);
const givenTo = (user: string, universe = 'u1') =>
  result.given.filter((row) => row.user_id === user && row.universe_id === universe).map((row) => [row.key, row.world_ids]);

describe('roles migration', () => {
  it('gives every universe the built-in roles, ranked, with Admin and Editor allowed what their tags allow', () => {
    expect(keysOf('u2')).toEqual(['admin', 'editor', 'member', 'everyone']);
    expect(keysOf('u3')).toEqual(['admin', 'editor', 'member', 'everyone']);
    const u1 = Object.fromEntries(result.roles.filter((role) => role.universe_id === 'u1').map((role) => [role.key, role]));
    expect(u1.admin.permissions).toBe('16383');
    expect(u1.editor.permissions).toBe('8416');
    expect(u1.member.permissions).toBe('0');
    expect(u1.everyone.permissions).toBe('0');
  });

  it('makes a custom role with no permissions for every other tag in use, ranked between Admin and Editor', () => {
    const custom = result.roles.filter((role) => !role.built_in);
    expect(custom.map((role) => role.key).sort()).toEqual(['finance', 'vip']);
    for (const role of custom) {
      expect(role.permissions).toBe('0');
      expect(role.position).toBeGreaterThan(2);
      expect(role.position).toBeLessThan(1_000_000);
    }
  });

  it('keeps everyone in exactly the worlds they were in, joined once per universe', () => {
    const where = (rows: Member[]) => rows.map((row) => `${row.user_id} ${row.world_id} ${row.joined_at}`).sort();
    expect(where(result.after)).toEqual(where(result.before));
    expect(result.members.find((row) => row.user_id === 'alice')).toMatchObject({
      all_worlds: false,
      world_ids: ['wa', 'wb'],
      joined_at: '2026-01-01T00:00:00.000Z',
    });
    expect(result.members.filter((row) => row.user_id === 'dan').map((row) => row.universe_id)).toEqual(['u1', 'u2']);
  });

  it('turns each tag into its role, limited to the worlds where they had it', () => {
    expect(givenTo('alice')).toEqual([['admin', ['wa']]]);
    expect(givenTo('dan')).toEqual([
      ['admin', ['wa']],
      ['editor', ['wa']],
    ]);
    expect(givenTo('cara')).toEqual([['finance', ['wa']]]);
    expect(givenTo('dan', 'u2')).toEqual([]);
    expect(result.given.every((row) => row.all_worlds === false)).toBe(true);
  });

  it('keeps every tag, and adds member where it was missing: everyone who joined is a Member', () => {
    const tags = Object.fromEntries(result.after.map((row) => [`${row.user_id} ${row.world_id}`, row.tags]));
    expect(tags).toEqual({
      'alice wa': ['admin', 'member'],
      'alice wb': ['member'],
      'bob wa': ['editor', 'member'],
      'cara wa': ['finance', 'member'],
      'dan wa': ['admin', 'editor', 'member'],
      'dan wd': ['member'],
      'eve wa': ['member'],
      'owner wc': ['admin', 'member'],
    });
  });

  it('points invitations at their universe, world and the roles their tags stand for', () => {
    const byId = Object.fromEntries(result.invitations.map((row) => [row.id, row]));
    expect(byId.i1).toEqual({ id: 'i1', universe_id: 'u1', all_worlds: false, world_ids: ['wb'], role_keys: ['editor'] });
    expect(byId.i2.role_keys).toEqual(['vip']);
    expect(byId.i3.role_keys).toEqual([]);
  });
});
