/**
 * Personal voice keys (#749) migration: runs the real migrations on a throwaway database. The server's voice providers are left as
 * they were, a key someone owns can't be a default, a key is lent once to a universe, and everything that hangs on a key,
 * a universe or a person goes with it.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Provider = { id: string; adapter: string; name: string; enabled: boolean; default_speech: boolean };
type Result = {
  before: Provider[];
  server: (Provider & { owner_id: string | null })[];
  checks: Record<string, boolean>;
  allModels: unknown;
  afterUniverse: number;
  afterKey: number;
  left: { keys: number; lends: number; server: number };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-personal-voice-keys-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('personal voice keys migration', () => {
  it('leaves the server’s own providers as they were, with no owner', () => {
    expect(result.server).toEqual(result.before.map((provider) => ({ ...provider, owner_id: null })));
  });

  it('lets a person own a key, but only one that belongs to someone', () => {
    expect(result.checks).toMatchObject({ personalKey: true, keyForNoOne: false });
  });

  it('never lets a key someone owns be a default, and still lets a server provider be one', () => {
    expect(result.checks).toMatchObject({ personalDefaultListening: false, personalDefaultSpeaking: false, serverKeyStillDefault: true });
  });

  it('lends a key once to a universe, to any number of universes, with all models when none are named', () => {
    expect(result.checks).toMatchObject({ lend: true, sameLendTwice: false, sameKeyAnotherUniverse: true });
    expect(result.allModels).toBeNull();
  });

  it('lends only real keys to real universes', () => {
    expect(result.checks).toMatchObject({ lendOfNoKey: false, lendToNoUniverse: false });
  });

  it('takes the lends with a universe, a key or a person, and leaves the server’s providers', () => {
    expect(result.afterUniverse).toBe(1);
    expect(result.afterKey).toBe(1);
    expect(result.left).toEqual({ keys: 0, lends: 0, server: 1 });
  });
});
