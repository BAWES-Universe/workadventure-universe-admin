/**
 * Call bots (game #2004) migration: runs the real migrations on a throwaway database, then this one. Only the built-in
 * Admin role gains the new bit (it always had every permission), so every bot starts as No for everyone else, and a
 * per-bot rule may now hold Call.
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
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-call-bots-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

const CALL = 524288; // bit 19: Call bots
const table = (rows: Row[]) => Object.fromEntries(rows.map((row) => [`${row.universe_id} ${row.key}${row.built_in ? '' : ' (custom)'}`, Number(row.permissions)]));

describe('call bots permission migration', () => {
  it('gives Admin the permission, so it still has every permission', () => {
    const after = table(result.once);
    for (const universe of ['u1', 'u2', 'u3']) expect(after[`${universe} admin`]).toBe(524287 | CALL);
    expect(524287 | CALL).toBe(1048575);
  });

  it('starts every other role at No: Editor, Member, Everyone and custom roles keep exactly what they had', () => {
    const before = table(result.before);
    const after = table(result.once);
    const others = Object.keys(before).filter((key) => !key.endsWith(' admin'));
    expect(others.length).toBe(12);
    for (const key of others) expect(after[key]).toBe(before[key]);
    for (const key of others) expect(after[key] & CALL).toBe(0);
  });

  it('adds nothing else and takes nothing away', () => {
    const before = table(result.before);
    const after = table(result.once);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) expect(after[key] & before[key]).toBe(before[key]);
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
