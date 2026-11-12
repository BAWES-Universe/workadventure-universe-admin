/**
 * "Goals and tasks" (game #2002) migration: runs the real migrations on a throwaway database. Nobody and no Brick that
 * exists today is touched and nothing is written for anyone by the migration; from then on a due time has one run, the
 * database keeps the words the code relies on, and a Brick that goes for good takes its items with it.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { users: Row[]; bots: Row[] };
  after: { users: Row[]; bots: Row[] };
  rowsAfterMigration: { items: number; runs: number };
  checks: Record<string, boolean>;
  defaults: { state: string; set_by: string; revision: number; failures_in_row: number; steps: unknown };
  afterBrickGone: { items: number; runs: number };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-brick-items-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('goals and tasks: the migration', () => {
  it('leaves every account and every Brick that exists today as it was, and writes nothing for anyone', () => {
    expect(result.before.users).toHaveLength(2);
    expect(result.before.bots).toHaveLength(2);
    expect(result.after).toEqual(result.before);
    expect(result.rowsAfterMigration).toEqual({ items: 0, runs: 0 });
  });

  it('starts an item on, set by the person, at revision 1, with no failures and no steps', () => {
    expect(result.defaults).toEqual({ state: 'on', set_by: 'you', revision: 1, failures_in_row: 0, steps: [] });
  });

  it('keeps the words the code relies on, and an item is due only while it is on', () => {
    expect(result.checks).toMatchObject({ firstItem: true, unknownKind: false, unknownState: false, dueOnlyWhenOn: false, dueWhenOn: true, unknownOwner: false });
  });

  it('gives one due time one run, however many try, and the next due time its own', () => {
    expect(result.checks).toMatchObject({ firstRun: true, sameDueTimeTwice: false, nextDueTime: true, unknownRunState: false });
  });

  it('takes the items and their runs with a Brick that goes for good', () => {
    expect(result.afterBrickGone).toEqual({ items: 0, runs: 0 });
  });
});
