/**
 * "Visiting Bricks on by default" (game #2005) migration: runs the real migrations on a throwaway database. Every
 * universe that exists gets the switch ON, nothing else about it or about anyone's Bricks and visits changes, a universe
 * made after starts with it on, and a host can still turn it off.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Snapshot = { universes: Row[]; users: Row[]; bots: Row[]; visits: Row[] };
type Result = {
  switchesBefore: Row[];
  switchesAfter: Row[];
  before: Snapshot;
  after: Snapshot;
  newUniverse: { allow_visiting_bricks: boolean };
  hostTurnedOff: { allow_visiting_bricks: boolean };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-visiting-bricks-on-by-default-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('Visiting Bricks on by default: the migration', () => {
  it('starts from universes with the switch off, and one a host had turned on', () => {
    expect(result.switchesBefore).toEqual([
      { id: 'u1', allow_visiting_bricks: false },
      { id: 'u2', allow_visiting_bricks: false },
      { id: 'u3', allow_visiting_bricks: true },
    ]);
  });

  it('turns the switch on for every universe that exists', () => {
    expect(result.switchesAfter).toEqual([
      { id: 'u1', allow_visiting_bricks: true },
      { id: 'u2', allow_visiting_bricks: true },
      { id: 'u3', allow_visiting_bricks: true },
    ]);
  });

  it('changes nothing else: not the universes’ other settings, the accounts, the Bricks or any visit', () => {
    expect(result.before.universes).toHaveLength(3);
    expect(result.before.visits).toHaveLength(1);
    expect(result.after).toEqual(result.before);
  });

  it('starts a universe made after it with the switch on, and lets a host turn it off', () => {
    expect(result.newUniverse).toEqual({ allow_visiting_bricks: true });
    expect(result.hostTurnedOff).toEqual({ allow_visiting_bricks: false });
  });
});
