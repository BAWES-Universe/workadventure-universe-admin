/**
 * "A Brick keeps what its template needs" (game #2008) migration: runs the real migrations on a throwaway database. Bricks
 * already made from a template take the needs of the version they took, nothing else about them changes, and the needs stay
 * after the template goes.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
  needs: Record<string, unknown>;
  fresh: unknown;
  afterSourceGone: Record<string, { templateId: string | null; needs: unknown }>;
  gmail: unknown;
  calendar: unknown;
};
let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-brick-template-use-needs-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('a Brick keeps what its template needs: the migration', () => {
  it('leaves every Brick made from a template as it was', () => {
    expect(result.before).toHaveLength(3);
    expect(result.after).toEqual(result.before);
  });

  it('gives each one the needs of the version it took, and nothing for one whose template was already gone', () => {
    expect(result.needs.made1).toEqual(result.calendar);
    expect(result.needs.made2).toEqual(result.gmail);
    expect(result.needs.made3).toEqual([]);
  });

  it('starts a new one with no needs until they are saved, and keeps them when the template goes for good', () => {
    expect(result.fresh).toEqual([]);
    expect(result.afterSourceGone.made1).toEqual({ templateId: null, needs: result.calendar });
    expect(result.afterSourceGone.made2).toEqual({ templateId: null, needs: result.gmail });
  });
});
