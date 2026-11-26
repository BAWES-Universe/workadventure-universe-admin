/**
 * Research Apps on by default (26 Nov 2026): the migration, run on a throwaway database built from every migration before it (the launch
 * defaults included). A deploy that still has the seeded values moves to the money calls of 26 Nov ($2.00 a month for each person, a $200.00
 * monthly ceiling for everyone together, at most 8 runs for one question); anything a super admin saved is never overwritten, and running it
 * twice changes nothing.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { missingInstantLimits, readInstantLimits } from '@/lib/instant/values';

type Rule = { id: string; program_id: string; version: number; state: string; funding_account_id: string; covers: string[]; benefit_kind: string; amount: string; schedule: string; share: string; recipient_type: string; settlement: string; created_by_id: string; superseded: boolean; started: boolean };
type State = { limits: Record<string, unknown> | null; rules: Rule[]; index: string[] };
type Scenario = { before: State; once: State; twice: State };
type Result = { seeded: Scenario; own: Scenario; ended: Scenario; emptied: Scenario; savedSame: Scenario; kuwait: { startsAt: string | null; createdAt: string | null; supersededAt: string | null; checkedAt: string } };

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-research-defaults-migration.mjs')], { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 320_000);

describe('research on by default: a deploy that still has the seeded values', () => {
  it('starts from the launch defaults ($0.10 once, a $1.00 ceiling), so these tests fail without the migration', () => {
    expect(result.seeded.before.limits).toMatchObject({ exposureCeilingMicros: 1_000_000 });
    expect(result.seeded.before.rules.map((rule) => [rule.id, rule.state, rule.amount, rule.schedule])).toEqual([['seed-default-instant_apps-v1', 'current', '100000', 'once']]);
  });

  it('gives each signed-in person $2.00 of Instant Apps credit every month from now, as a new version of the same default, funded as before', () => {
    const [v1, v2] = result.seeded.once.rules;
    expect(v1).toMatchObject({ id: 'seed-default-instant_apps-v1', state: 'superseded', superseded: true, amount: '100000', schedule: 'once' });
    expect(v2).toMatchObject({
      id: 'seed-default-instant_apps-v2',
      program_id: 'seed-default-instant_apps',
      version: 2,
      state: 'current',
      funding_account_id: v1.funding_account_id,
      covers: ['instant_apps'],
      benefit_kind: 'replace',
      amount: '2000000',
      schedule: 'monthly',
      share: 'each',
      recipient_type: 'all',
      settlement: 'free',
      superseded: false,
      started: true,
    });
    expect(result.seeded.once.rules.filter((rule) => rule.state === 'current')).toHaveLength(1);
  });

  it('scales the ceiling for everyone together to $200.00 a month and bounds one question at 8 runs; Instant still has every value it needs', () => {
    const limits = readInstantLimits(result.seeded.once.limits);
    expect(limits).toMatchObject({ exposureCeilingMicros: 200_000_000, maxRunsPerQuestion: 8, maxRunMicros: 30_000, pauseFailureRateBps: 2_000, pauseMinRuns: 10 });
    expect(missingInstantLimits(limits)).toEqual([]);
  });

  it('adds the index one question’s runs are counted by', () => {
    expect(result.seeded.before.index).toEqual([]);
    expect(result.seeded.once.index).toEqual([expect.stringContaining('(person_id, task_key)')]);
  });

  it('changes nothing when run a second time', () => {
    for (const scenario of [result.seeded, result.own, result.ended, result.emptied, result.savedSame]) expect(scenario.twice).toEqual(scenario.once);
  });
});

describe('research on by default: what a super admin saved stays', () => {
  it('their own ceiling, their own most runs for a question, and their own version of the default are left exactly as they were', () => {
    expect(result.own.once.limits).toEqual(result.own.before.limits);
    expect(result.own.once.rules).toEqual(result.own.before.rules);
  });

  it('a default they ended stays ended: nobody is given credit by this migration', () => {
    expect(result.ended.once.rules).toEqual(result.ended.before.rules);
  });

  it('a ceiling they emptied stays empty (Instant then waits for one), while the seeded default still moves to $2.00 a month', () => {
    expect(result.emptied.once.limits).not.toHaveProperty('exposureCeilingMicros');
    expect(result.emptied.once.rules.find((rule) => rule.state === 'current')).toMatchObject({ amount: '2000000', schedule: 'monthly' });
  });
});

describe('research on by default: a database whose own time zone is not UTC', () => {
  it('writes UTC times (as the columns hold), so the $2.00 a month starts now and the old $0.10 stops now, not hours later', () => {
    const { startsAt, createdAt, supersededAt, checkedAt } = result.kuwait;
    const checked = Date.parse(checkedAt);
    for (const at of [startsAt, createdAt, supersededAt]) {
      expect(at).not.toBeNull();
      // Written moments before the check, never three hours ahead of it
      expect(Date.parse(at as string)).toBeLessThanOrEqual(checked);
      expect(checked - Date.parse(at as string)).toBeLessThan(10 * 60 * 1000);
    }
  });
});

describe('research on by default: a ceiling a super admin saved at the seeded number', () => {
  it('is their choice and stays $1.00 (the row says who saved it); the question bound is still added and the default still moves', () => {
    expect(result.savedSame.before.limits).toMatchObject({ exposureCeilingMicros: 1_000_000 });
    expect(result.savedSame.once.limits).toMatchObject({ exposureCeilingMicros: 1_000_000, maxRunsPerQuestion: 8 });
    expect(result.savedSame.once.rules.map((rule) => [rule.id, rule.state])).toEqual([['seed-default-instant_apps-v1', 'superseded'], ['seed-default-instant_apps-v2', 'current']]);
  });
});
