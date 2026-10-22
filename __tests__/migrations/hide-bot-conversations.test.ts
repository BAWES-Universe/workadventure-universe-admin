/**
 * Hide bot conversations (#435) migration: runs the real migrations on a throwaway database, then this one. Every
 * universe starts with the setting off and every bot follows its universe, and nothing already saved changes.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let result: Record<'before' | 'after', Record<string, unknown>> & Record<'settings' | 'fresh', Record<string, unknown>>;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-hide-bot-conversations-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string);
}, 150_000);

describe('hide bot conversations migration', () => {
  it('starts every universe with the setting off and every bot following its universe', () => {
    expect(result.settings.universe).toEqual([{ hide_bot_conversations: false }]);
    expect(result.settings.bot).toEqual([{ hide_conversations: null }]);
  });

  it('starts universes and bots made afterwards the same way', () => {
    expect(result.fresh.universe).toEqual([{ hide_bot_conversations: false }]);
    expect(result.fresh.bot).toEqual([{ hide_conversations: null }]);
  });

  it('changes nothing already saved: universes, bots, transcripts and what the bots remember', () => {
    expect(result.after).toEqual(result.before);
  });

  it('can hold a forget row for everyone (no person) that has not been told to the bot server yet', () => {
    expect(result.fresh.forget).toEqual([{ bot_id: 'bot1', user_uuid: null, reported_at: null }]);
  });
});
