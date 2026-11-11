/**
 * "The Brick for guests" (game #1997) migration: runs the real migrations on a throwaway database. Nobody and no bot that
 * exists today is touched and nothing is written for anyone by the migration; from then on a turn is counted once, a
 * guest's chat has at most one account, it goes with that account, and no row holds anything that was said.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { users: Row[]; bots: Row[]; usage: Row[]; windows: Row[] };
  after: { users: Row[]; bots: Row[]; usage: Row[]; windows: Row[] };
  rowsAfterMigration: { replies: number; handovers: number };
  replyDefaults: { failed: boolean; tokens_used: number | null; cost_micros: number | null; has_time: boolean };
  replyColumns: string[];
  checks: Record<string, boolean>;
  secondClaim: Row[];
  handover: Row[];
  handoversAfterAccountGone: number;
  repliesAfterAccountGone: number;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-guest-brick-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('the Brick for guests: the migration', () => {
  it('leaves every account, every bot and every Universe AI count that exists today as it was', () => {
    expect(result.before.users).toHaveLength(3);
    expect(result.before.bots).toHaveLength(1);
    expect(result.after).toEqual(result.before);
  });

  it('writes nothing for anyone: a row appears only when a guest asks for a reply or signs in', () => {
    expect(result.rowsAfterMigration).toEqual({ replies: 0, handovers: 0 });
  });

  it('counts a turn once, for a guest id and a universe, and a reply starts out counted, with no tokens or cost until it is closed', () => {
    expect(result.checks.sameTurnTwice).toBe(false);
    expect(result.checks.outsideUniverse).toBe(true);
    expect(result.replyDefaults).toEqual({ failed: false, tokens_used: null, cost_micros: null, has_time: true });
  });

  it('keeps totals and no words: no column holds anything a guest or the Brick said', () => {
    expect(result.replyColumns).toEqual(['cost_micros', 'created_at', 'failed', 'guest_key', 'id', 'tokens_used', 'turn_id', 'universe_key']);
  });

  it('hands a guest’s chat to one account: a second claim for the same guest takes nothing, and only accounts that exist can take it', () => {
    expect(result.checks.firstHandover).toBe(true);
    expect(result.checks.sameGuestToAnotherAccount).toBe(false);
    expect(result.checks.unknownAccount).toBe(false);
    expect(result.secondClaim).toEqual([]);
    expect(result.handover).toEqual([{ guest_key: 'guest-a', user_id: 'sara', carried_at: null, has_time: true }]);
  });

  it('takes the hand-over with the account, and keeps the totals', () => {
    expect(result.handoversAfterAccountGone).toBe(0);
    expect(result.repliesAfterAccountGone).toBe(2);
  });
});
