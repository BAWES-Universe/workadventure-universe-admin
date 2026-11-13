/**
 * "Bringing a Brick along" (game #2005) migration: runs the real migrations on a throwaway database. Every universe that
 * exists today starts with Visiting Bricks OFF and nothing else changes; a universe made from now on starts with it on.
 * A visit is one row per person for one Brick, and goes with the Brick or the person; a room that goes takes no Brick
 * with it.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { users: Row[]; bots: Row[]; universesWithoutTheSwitch: Row[] };
  after: { users: Row[]; bots: Row[]; universesWithoutTheSwitch: Row[] };
  rowsAfterMigration: { visits: number };
  switches: Row[];
  newUniverse: { allow_visiting_bricks: boolean };
  columns: string[];
  visitDefaults: { has_start: boolean; has_seen: boolean };
  checks: Record<string, boolean>;
  afterRoomGone: Row[];
  bricksAfterRoomGone: number;
  visitsAfterBrickGone: number;
  visitsAfterPersonGone: number;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-visiting-bricks-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('bringing a Brick along: the migration', () => {
  it('leaves every account, every bot and every universe that exists today as it was', () => {
    expect(result.before.users).toHaveLength(3);
    expect(result.before.bots).toHaveLength(3);
    expect(result.after).toEqual(result.before);
  });

  it('starts every universe that exists today with Visiting Bricks off, and writes no visit for anyone', () => {
    expect(result.switches).toEqual([
      { id: 'u1', allow_visiting_bricks: false },
      { id: 'u2', allow_visiting_bricks: false },
    ]);
    expect(result.rowsAfterMigration).toEqual({ visits: 0 });
  });

  it('starts a universe made after it with Visiting Bricks on', () => {
    expect(result.newUniverse).toEqual({ allow_visiting_bricks: true });
  });

  it('keeps a visit to which Brick, whose, where and when, and nothing of its owner’s', () => {
    expect(result.columns).toEqual(['bot_id', 'room_id', 'seen_at', 'started_at', 'user_id']);
    expect(result.visitDefaults).toEqual({ has_start: true, has_seen: true });
  });

  it('lets one Brick walk with a person at a time and a Brick walk with one person', () => {
    expect(result.checks.secondBrickForTheSamePerson).toBe(false);
    expect(result.checks.theSameBrickForAnotherPerson).toBe(false);
    expect(result.checks.anotherPersonsOwnBrick).toBe(true);
    expect(result.checks.noPerson).toBe(false);
    expect(result.checks.noBot).toBe(false);
  });

  it('keeps every Brick when a room goes, and loses a visit with its Brick or its person', () => {
    expect(result.afterRoomGone).toEqual([
      { user_id: 'omar', bot_id: 'brick2', room_id: null },
      { user_id: 'sara', bot_id: 'brick1', room_id: null },
    ]);
    expect(result.bricksAfterRoomGone).toBe(2);
    expect(result.visitsAfterBrickGone).toBe(1);
    expect(result.visitsAfterPersonGone).toBe(0);
  });
});
