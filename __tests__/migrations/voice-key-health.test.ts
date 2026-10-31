/**
 * Voice key health (#749) migration: runs the real migrations on a throwaway database. Every key that exists starts out
 * Working, with no failed calls and nothing checked, and a key can then be saved as Down with its reason and the job.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  health: { id: string; down_since: string | null; down_reason: string | null; down_part: string | null; failed_recognition: number; failed_speech: number; health_checked_at: string | null }[];
  down: { down_reason: string; down_part: string; failed_speech: number };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-voice-key-health-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('voice key health migration', () => {
  it('starts every existing key Working, with no failed calls and nothing checked', () => {
    expect(result.health).toEqual([
      { id: 'mine', down_since: null, down_reason: null, down_part: null, failed_recognition: 0, failed_speech: 0, health_checked_at: null },
      { id: 'server', down_since: null, down_reason: null, down_part: null, failed_recognition: 0, failed_speech: 0, health_checked_at: null },
    ]);
  });

  it('saves a key as Down with its reason', () => {
    expect(result.down).toEqual({ down_reason: 'errors', down_part: 'speech', failed_speech: 2 });
  });
});
