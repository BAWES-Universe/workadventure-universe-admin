/**
 * "Allow more" times (game #1659) migration: runs the real migrations on a throwaway database. Every bot starts with what
 * remembered approvals already last (1 hour quiet, 8 hours at most), and only the offered choices can be saved.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  before: { id: string; name: string; enabled: boolean }[];
  after: { id: string; name: string; enabled: boolean; allow_more_idle_minutes: number; allow_more_max_minutes: number }[];
  checks: Record<string, boolean>;
  saved: { allow_more_idle_minutes: number; allow_more_max_minutes: number };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-allow-more-times-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('allow more times migration', () => {
  it('gives every bot 1 hour quiet and 8 hours at most, and changes nothing else about it', () => {
    for (const bot of result.after) expect(bot).toMatchObject({ allow_more_idle_minutes: 60, allow_more_max_minutes: 480 });
    expect(result.after.map(({ id, name, enabled }) => ({ id, name, enabled }))).toEqual(result.before);
  });

  it('refuses a time that is not offered, and no time at all', () => {
    expect(result.checks).toMatchObject({ badIdle: false, badMax: false, idleNull: false });
  });

  it('saves the other offered choices', () => {
    expect(result.checks).toMatchObject({ goodIdle: true, goodMax: true });
    expect(result.saved).toEqual({ allow_more_idle_minutes: 120, allow_more_max_minutes: 1440 });
  });
});
