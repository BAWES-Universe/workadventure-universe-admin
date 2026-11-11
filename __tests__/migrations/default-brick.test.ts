/**
 * "The Brick everyone gets" (game #1995) migration: runs the real migrations on a throwaway database. Nobody and no bot
 * that exists today is touched and nobody is handed a Brick by the migration; from then on an account has at most one
 * row, the row outlives a Brick deleted on purpose, and it goes with the account.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { users: Row[]; bots: Row[] };
  after: { users: Row[]; bots: Row[] };
  rowsAfterMigration: Row[];
  secondClaim: Row[];
  checks: Record<string, boolean>;
  rowsWhenMade: Row[];
  madeAtIsSet: number;
  rowsAfterBrickDeleted: Row[];
  claimAfterDelete: Row[];
  rowsAfterAccountGone: Row[];
  botsAfterAccountGone: string[];
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-default-brick-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('the Brick everyone gets: the migration', () => {
  it('leaves every account and every bot that exists today as it was, a room bot and a Brick someone made included', () => {
    expect(result.before.users).toHaveLength(3);
    expect(result.before.bots).toHaveLength(2);
    expect(result.after).toEqual(result.before);
  });

  it('hands nobody a Brick by itself: an account’s row appears only when its Brick is first made', () => {
    expect(result.rowsAfterMigration).toEqual([]);
  });

  it('keeps one row per account, each pointing at that account’s Brick, with the time it was made', () => {
    expect(result.rowsWhenMade).toEqual([
      { user_id: 'omar', bot_id: 'brick-omar' },
      { user_id: 'sara', bot_id: 'brick-sara' },
    ]);
    expect(result.madeAtIsSet).toBe(2);
  });

  it('makes "once" a rule of the database: a second claim for the same account takes nothing', () => {
    expect(result.secondClaim).toEqual([]);
    expect(result.checks.secondRowForTheSameAccount).toBe(false);
  });

  it('never lets two accounts share one Brick, and only knows accounts and bots that exist', () => {
    expect(result.checks).toMatchObject({ oneBrickForTwoAccounts: false, unknownAccount: false, unknownBot: false });
  });

  it('remembers a Brick deleted on purpose: the row stays, points at nothing, and a new claim still takes nothing', () => {
    expect(result.rowsAfterBrickDeleted).toEqual([
      { user_id: 'omar', bot_id: 'brick-omar' },
      { user_id: 'sara', bot_id: null },
    ]);
    expect(result.claimAfterDelete).toEqual([]);
  });

  it('goes with the account, and so does the account’s Brick; everyone else’s stay', () => {
    expect(result.rowsAfterAccountGone).toEqual([{ user_id: 'sara', bot_id: null }]);
    expect(result.botsAfterAccountGone).toEqual(['bot1', 'made1']);
  });
});
