/**
 * "A Brick that lives in a room" (game #2005) migration: runs the real migrations on a throwaway database. Nothing that
 * exists today is touched and nothing is written for anyone; from then on a Brick has one home at most, a home never
 * gives a Brick a room of its own, and it goes with its room, its Brick or the person who placed it, and nothing else.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { users: Row[]; bots: Row[]; rooms: Row[] };
  after: { users: Row[]; bots: Row[]; rooms: Row[] };
  rowsAfterMigration: { homes: number };
  columns: string[];
  defaults: { behavior_type: string; behavior_config: unknown };
  checks: Record<string, boolean>;
  bricksWithARoom: number;
  homesAfterRoomGone: number;
  bricksAfterRoomGone: number;
  homesAfterBrickGone: number;
  homesAfterPersonGone: number;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-brick-homes-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('a Brick that lives in a room: the migration', () => {
  it('leaves every account, room and bot that exists today as it was, and writes nothing for anyone', () => {
    expect(result.before.bots).toHaveLength(3);
    expect(result.after).toEqual(result.before);
    expect(result.rowsAfterMigration).toEqual({ homes: 0 });
  });

  it('keeps which Brick, which room, who placed it, how it behaves there and when: and nothing of its owner’s', () => {
    expect(result.columns).toEqual(['behavior_config', 'behavior_type', 'bot_id', 'created_at', 'placed_by_id', 'room_id', 'updated_at']);
    expect(result.defaults).toEqual({ behavior_type: 'idle', behavior_config: {} });
  });

  it('gives a Brick one home at most and a room any number of Bricks, in rooms, Bricks and people that exist', () => {
    expect(result.checks).toEqual({ secondHomeForTheSameBrick: false, twoBricksInOneRoom: true, noRoom: false, noBot: false, noPerson: false });
  });

  it('never gives a Brick a room of its own', () => {
    expect(result.bricksWithARoom).toBe(0);
  });

  it('goes with its room, its Brick or its person and takes nothing else: every Brick is still there after its room goes', () => {
    expect(result.homesAfterRoomGone).toBe(1);
    expect(result.bricksAfterRoomGone).toBe(2);
    expect(result.homesAfterBrickGone).toBe(1);
    expect(result.homesAfterPersonGone).toBe(0);
  });
});
