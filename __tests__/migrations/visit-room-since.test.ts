/**
 * "A visit moves only on a newer sighting" (game #2005) migration: runs the real migrations on a throwaway database. The
 * visit that exists today is left exactly as it was, with nothing in the new column (so it moves on its first sighting, as it
 * always did), and the column takes a time.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = { clientBefore: unknown; client: string; before: unknown[]; after: unknown[]; since: unknown; nullable: string; written: string };

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-visit-room-since-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('visit room_since: the migration', () => {
  it('leaves the visit that exists today as it was, with nothing in the new column', () => {
    expect(result.before).toHaveLength(1);
    expect(result.after).toEqual(result.before);
    expect(result.since).toBeNull();
    expect(result.clientBefore).toBeNull();
  });

  it('is an optional column that takes a time', () => {
    expect(result.nullable).toBe('YES');
    expect(result.written).toMatch(/^2026-11-12T10:00:00/);
    expect(result.client).toBe('page-laptop-0001');
  });
});
