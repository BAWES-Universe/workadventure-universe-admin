/**
 * Call (game #2004) migration: runs the real migrations on a throwaway database, then this one. No role changes (Call is
 * a rule bit, not a role permission), so every bot starts as No, and a per-bot rule may now hold Call.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = { universe_id: string; key: string; permissions: string; built_in: boolean };
type Result = {
  before: Row[];
  once: Row[];
  twice: Row[];
  ruleKept: { allow: string; deny: string };
  call: string;
  everythingAtOnce: string;
  overlap: string;
  outsideBits: string;
  oldOutsideBit: string;
  negative: string;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-call-rule-bit-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

const CALL = 524288; // bit 19 of a bot rule: Call
const table = (rows: Row[]) => Object.fromEntries(rows.map((row) => [`${row.universe_id} ${row.key}${row.built_in ? '' : ' (custom)'}`, Number(row.permissions)]));

describe('call rule bit migration', () => {
  it('changes no role at all: Call is not a role permission, so every bot starts at No for everyone', () => {
    expect(table(result.once)).toEqual(table(result.before));
    for (const permissions of Object.values(table(result.once))) expect(permissions & CALL).toBe(0);
  });

  it('can run again without changing anything', () => {
    expect(table(result.twice)).toEqual(table(result.once));
  });

  it('keeps the rule a bot already had', () => {
    expect(result.ruleKept).toEqual({ allow: '16384', deny: '65536' });
  });

  it('lets a bot rule hold Call next to the six bits it had, never both Yes and No', () => {
    expect(result.call).toBe('accepted');
    expect(result.everythingAtOnce).toBe('accepted');
    expect(result.overlap).toContain('bot_access_rules_bits');
  });

  it('still refuses any other bit and a negative number', () => {
    for (const refused of [result.outsideBits, result.oldOutsideBit, result.negative]) expect(refused).toContain('bot_access_rules_bits');
  });
});
