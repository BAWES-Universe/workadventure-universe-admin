/**
 * Voice settings (#740) migration: runs the real migrations on a throwaway database, then the voice settings one.
 * Every universe that exists today starts with "Allow voice bots here" on and nothing else about it changes.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  before: Record<string, unknown>[];
  once: Record<string, unknown>[];
  created: { allow_voice_bots: boolean };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-voice-settings-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('voice settings migration', () => {
  it('turns "Allow voice bots here" on for every universe that exists today', () => {
    expect(result.once.map((universe) => universe.allow_voice_bots)).toEqual([true, true]);
  });

  it('changes nothing else about those universes', () => {
    expect(result.once.map(({ id, slug, name, hide_bot_conversations }) => ({ id, slug, name, hide_bot_conversations }))).toEqual(result.before);
  });

  it('starts a universe added later with it on', () => {
    expect(result.created).toEqual({ allow_voice_bots: true });
  });
});
