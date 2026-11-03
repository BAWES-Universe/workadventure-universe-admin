/**
 * Universe AI default voice (game #1668) migration: runs the real migrations on a throwaway database. Every provider that exists
 * starts with no default voice, and a voice id and its name can then be saved.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  before: { id: string; default_voice_id: string | null; default_voice_name: string | null }[];
  saved: { default_voice_id: string; default_voice_name: string };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-voice-default-voice-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('voice default voice migration', () => {
  it('starts every existing provider with no default voice', () => {
    expect(result.before).toEqual([{ id: 'server', default_voice_id: null, default_voice_name: null }]);
  });

  it('saves a voice and its name', () => {
    expect(result.saved).toEqual({ default_voice_id: 'nora', default_voice_name: 'Nora' });
  });
});
