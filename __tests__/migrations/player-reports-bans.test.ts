/**
 * The player-reports migration changes bans that already exist. The helper runs it on a copy of the database made by
 * every earlier migration, holding one ban of each kind, and these tests check what it did.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type BanRow = {
  id: string;
  world_id: string | null;
  universe_id: string | null;
  is_active: boolean;
  appealed_at: string | null;
  appeal_text: string | null;
  lifted_at: string | null;
  lifted_by: string | null;
};

let bans: Map<string, BanRow>;

beforeAll(() => {
  const output = execFileSync(
    process.execPath,
    [path.join(__dirname, '../helpers/run-player-reports-migration.mjs')],
    { encoding: 'utf8', timeout: 120_000 },
  );
  bans = new Map((JSON.parse(output.trim().split('\n').pop() as string) as BanRow[]).map((row) => [row.id, row]));
}, 150_000);

function ban(id: string) {
  const row = bans.get(id);
  return { world_id: row?.world_id, universe_id: row?.universe_id, is_active: row?.is_active };
}

describe('player reports migration, on the bans that were there before', () => {
  it('turns a ban made in the game into a ban from that world only, still in force', () => {
    expect(ban('A-active')).toEqual({ world_id: 'w1', universe_id: null, is_active: true });
  });

  it('keeps a lifted game ban lifted', () => {
    expect(ban('A-lifted')).toEqual({ world_id: 'w1', universe_id: null, is_active: false });
  });

  it('switches off a ban whose world was deleted, so it stops blocking the whole universe', () => {
    expect(ban('B-active')).toEqual({ world_id: null, universe_id: 'uni1', is_active: false });
    expect(ban('B-lifted')).toEqual({ world_id: null, universe_id: 'uni1', is_active: false });
  });

  it('leaves a ban from one world alone', () => {
    expect(ban('C-active')).toEqual({ world_id: 'w1', universe_id: null, is_active: true });
  });

  it('leaves a ban from everywhere alone, for a person and for an address', () => {
    expect(ban('D-active')).toEqual({ world_id: null, universe_id: null, is_active: true });
    expect(ban('D-address')).toEqual({ world_id: null, universe_id: null, is_active: true });
  });

  it('adds the appeal and lift columns, empty on old bans', () => {
    const row = bans.get('A-active');
    expect([row?.appealed_at, row?.appeal_text, row?.lifted_at, row?.lifted_by]).toEqual([null, null, null, null]);
  });
});
