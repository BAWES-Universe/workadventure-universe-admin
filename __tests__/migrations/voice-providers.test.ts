/**
 * Voice providers (#740) migration: runs the real migrations on a throwaway database. A provider starts doing nothing and off,
 * and the database itself allows one default for listening and one for speaking.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  first: { recognition: boolean; speech: boolean; enabled: boolean; models: unknown; default_recognition: boolean; default_speech: boolean };
  checks: Record<string, boolean>;
  counts: { recognition: number; speech: number };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-voice-providers-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('voice providers migration', () => {
  it('starts a provider off, doing nothing, with no models and no default', () => {
    expect(result.first).toEqual({ recognition: false, speech: false, enabled: false, models: [], default_recognition: false, default_speech: false });
  });

  it('allows one default for listening and one for speaking', () => {
    expect(result.checks).toMatchObject({
      firstDefaultRecognition: true,
      secondDefaultRecognition: false,
      firstDefaultSpeech: true,
      secondDefaultSpeech: false,
    });
    expect(result.counts).toEqual({ recognition: 1, speech: 1 });
  });

  it('allows any number of providers that are not a default', () => {
    expect(result.checks.manyNotDefault).toBe(true);
  });

  it('lets another provider be the default once it is released', () => {
    expect(result.checks.speechDefaultAfterRelease).toBe(true);
  });
});
