/**
 * Bot voice (#740) migration: runs the real migrations on a throwaway database, then the bot voice one. Every bot that exists
 * today has voice off and no revision, and nothing else about it changes.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  before: Record<string, unknown>[];
  once: Record<string, unknown>[];
  checks: Record<string, boolean>;
  draftDefault: { profile: unknown };
  left: { drafts: number; revisions: number };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-bot-voice-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('bot voice migration', () => {
  it('turns voice off for every bot that exists today, with no revision', () => {
    for (const bot of result.once) expect(bot).toMatchObject({ voice_enabled: false, voice_revision: null });
  });

  it('changes nothing else about those bots', () => {
    expect(result.once.map(({ id, name, enabled }) => ({ id, name, enabled }))).toEqual(result.before);
  });

  it('keeps one draft for a bot, starting empty, and numbers its revisions once each', () => {
    expect(result.checks).toMatchObject({ draft: true, secondDraftForABot: false, revision: true, sameNumberTwice: false, sameNumberOnAnotherBot: true });
    expect(result.draftDefault.profile).toEqual({});
  });

  it('only keeps drafts and revisions of bots that exist, and removes a bot\'s with it', () => {
    expect(result.checks).toMatchObject({ draftForNoBot: false, revisionForNoBot: false });
    // Nora's draft and revision go with her; Atlas's revision stays
    expect(result.left).toEqual({ drafts: 0, revisions: 1 });
  });
});
