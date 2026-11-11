/**
 * "More Bricks, and deleting one with Undo" (game #1996) migration: runs the real migrations on a throwaway database.
 * No bot that exists today is touched and none is deleted by the migration; from then on only a Brick can wait deleted,
 * a deleted Brick is always off and always has its day, and a suggestion has one row per person and topic.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: Row[];
  after: Row[];
  newColumns: Row[];
  checks: Record<string, boolean>;
  deleted: Row;
  undone: Row;
  offers: Record<string, number | boolean>;
  offeredAtIsSet: number;
  offersAfterAccountGone: Row[];
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-brick-delete-undo-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('more Bricks, and deleting one with Undo: the migration', () => {
  it('leaves every bot that exists today as it was, a room bot and a Brick that is off included', () => {
    expect(result.before).toHaveLength(3);
    expect(result.after).toEqual(result.before);
  });

  it('deletes nothing by itself and gives no bot a hello: every new column starts empty', () => {
    expect(result.newColumns).toEqual(
      ['bot1', 'brick1', 'brick2'].map((id) => ({ id, deleted_at: null, gone_at: null, enabled_before_delete: null, hello: null })),
    );
  });

  it('lets a Brick be deleted the way Orbit does it: marked, given its day, switched off, its switch kept for Undo', () => {
    expect(result.checks.deleteABrick).toBe(true);
    expect(result.deleted).toEqual({ enabled: false, enabled_before_delete: true, marked: true });
  });

  it('keeps a deleted Brick off: the database refuses to switch it on', () => {
    expect(result.checks.switchADeletedBrickOn).toBe(false);
  });

  it('never lets a bot in a room wait deleted, and holds the mark, the day and the kept switch together', () => {
    expect(result.checks).toMatchObject({ deleteARoomBot: false, markWithoutADay: false, dayWithoutAMark: false, keptSwitchWithoutAMark: false });
  });

  it('gives a Brick back with Undo: on again as it was, with nothing of the delete left on it', () => {
    expect(result.checks.undo).toBe(true);
    expect(result.undone).toEqual({ enabled: true, enabled_before_delete: null, deleted_at: null, gone_at: null });
  });

  it('keeps a hello to 300 characters', () => {
    expect(result.checks).toMatchObject({ helloTooLong: false, helloThatFits: true });
  });

  it('makes "once per topic" a rule of the database: a second claim for the same person and topic takes nothing', () => {
    expect(result.offers).toMatchObject({ first: 1, again: 0, otherTopic: 1, otherPerson: 1 });
    expect(result.offeredAtIsSet).toBe(3);
  });

  it('only knows people that exist, keeps a topic short, and lets a person’s suggestions go with their account', () => {
    expect(result.offers).toMatchObject({ unknownPerson: false, topicTooLong: false });
    expect(result.offersAfterAccountGone).toEqual([{ user_id: 'omar', topic: 'recipes' }]);
  });
});
