/**
 * Per-bot rules (#427) migration, test plan row 18: runs the real migrations on a throwaway database, then the per-bot
 * rules one. Every bot that exists keeps working as it does (open, no rows, no owner line), and the database itself
 * refuses a row that makes no sense.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let result: Record<string, unknown> & {
  botsBefore: { id: string; name: string; enabled: boolean; behavior_type: string }[];
  botsAfter: Record<string, unknown>[];
};

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-bot-access-rules-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string);
}, 150_000);

describe('bot access rules migration', () => {
  it('leaves every existing bot open, with no owner line and the same daily cap, and changes nothing else about it', () => {
    expect(result.botsAfter).toHaveLength(2);
    for (const bot of result.botsAfter) {
      expect(bot).toMatchObject({ private_bot: false, refusal_reply: null, daily_reply_cap: 50 });
    }
    expect(result.botsAfter.map(({ id, name, enabled, behavior_type }) => ({ id, name, enabled, behavior_type }))).toEqual(result.botsBefore);
  });

  it('accepts a row for a role and a row for a person', () => {
    expect(result.roleRow).toBe('accepted');
    expect(result.personRow).toBe('accepted');
  });

  it.each([
    ['a row for both a role and a person', 'bothSubjects', 'bot_access_rules_one_subject'],
    ['a row for neither', 'noSubject', 'bot_access_rules_one_subject'],
    ['a bit that is both Yes and No', 'overlap', 'bot_access_rules_bits'],
    ['a bit that is not one of the four bot bits', 'outsideBits', 'bot_access_rules_bits'],
    ['a negative number', 'negative', 'bot_access_rules_bits'],
    ['two rows for the same role on one bot', 'twoRowsSameRole', 'bot_access_rules_bot_id_role_id_key'],
    ['two rows for the same person on one bot', 'twoRowsSamePerson', 'bot_access_rules_bot_id_user_id_key'],
    ['a row for a bot that does not exist', 'unknownBot', 'bot_access_rules_bot_id_fkey'],
    ['a daily cap of zero', 'capZero', 'bots_daily_reply_cap_range'],
    ['a daily cap over 10000', 'capTooBig', 'bots_daily_reply_cap_range'],
  ])('refuses %s', (_name, key, constraint) => {
    expect(String(result[key])).toContain(constraint);
  });

  it('accepts the biggest daily cap', () => {
    expect(result.capOk).toBe('accepted');
  });

  it('takes a row away with its role, its person or its bot', () => {
    expect([result.rowsBeforeDeletes, result.afterRoleDeleted, result.afterPersonDeleted]).toEqual([2, 1, 0]);
    expect([result.beforeBotDeleted, result.afterBotDeleted]).toEqual([1, 0]);
  });
});
