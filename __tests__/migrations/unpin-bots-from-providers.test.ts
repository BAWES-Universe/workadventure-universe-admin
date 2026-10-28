/**
 * Unpin bots from providers (game #1446) migration: runs the real migrations on a throwaway database, then this one. A bot
 * pinned to one of the server's own providers moves to Universe AI with its model cleared; everything else stays as it was.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Bot = { id: string; ai_provider_ref: string | null; ai_model: string | null; touched: boolean };
let result: { before: { bots: Bot[]; providers: unknown[] }; after: { bots: Bot[]; providers: unknown[] } };

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-unpin-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string);
}, 150_000);

const after = (id: string) => result.after.bots.find((bot) => bot.id === id) as Bot;
const before = (id: string) => result.before.bots.find((bot) => bot.id === id) as Bot;

describe('unpin bots from providers migration', () => {
  it('starts with bots pinned to a provider, which the migration then finds', () => {
    expect(before('pinned-default').ai_provider_ref).toBe('deepseek-flash');
    expect(before('pinned-other').ai_provider_ref).toBe('claude-sonnet');
  });

  it('moves a bot pinned to a server provider, the Default or not, to Universe AI and clears its model', () => {
    expect(after('pinned-default')).toMatchObject({ ai_provider_ref: 'universe-ai', ai_model: null, touched: true });
    expect(after('pinned-other')).toMatchObject({ ai_provider_ref: 'universe-ai', ai_model: null, touched: true });
  });

  it('leaves a bot on Universe AI, on a person’s key, with no provider, or with a provider that is gone exactly as it was', () => {
    for (const id of ['universe-ai', 'on-key', 'no-ref', 'provider-gone', 'key-gone']) {
      expect(after(id)).toEqual({ ...before(id), touched: false });
    }
    expect(after('on-key')).toMatchObject({ ai_provider_ref: 'key-1', ai_model: 'anthropic/claude-haiku-5-5' });
  });

  it('changes no provider or key', () => {
    expect(result.after.providers).toEqual(result.before.providers);
  });
});
