/**
 * "Paused by a template" (game #2008) migration: runs the real migrations on a throwaway database. No goal or task that exists
 * today is touched; from then on a routine that came with a Brick template can be paused by it, and nothing else new is
 * accepted, and nothing paused is ever due.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = { before: Record<string, unknown>[]; after: Record<string, unknown>[]; checks: Record<string, boolean> };
let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-brick-item-paused-by-template-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('paused by a template: the migration', () => {
  it('leaves every goal and task that exists today as it was', () => {
    expect(result.before).toHaveLength(4);
    expect(result.after).toEqual(result.before);
  });

  it('accepts "template" beside the old reasons, nothing else, and never a time due while paused', () => {
    expect(result.checks).toEqual({ pausedByTemplate: true, pausedByOwner: true, pausedByNothing: true, pausedByAnythingElse: false, templateRoutineWithATimeDue: false });
  });
});
