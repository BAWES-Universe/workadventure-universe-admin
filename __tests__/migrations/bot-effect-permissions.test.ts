/**
 * Have bots change things, Have bots delete or send (#737) migration: runs the real migrations on a throwaway database,
 * then this one. The built-in roles get their defaults, nothing else changes for anyone, and a per-bot rule may hold
 * the two new bits.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = { universe_id: string; key: string; permissions: string; built_in: boolean };
type Result = {
  before: Row[];
  once: Row[];
  twice: Row[];
  ruleKept: { allow: string; deny: string };
  changeAndDelete: string;
  everythingAtOnce: string;
  overlap: string;
  outsideBits: string;
  oldOutsideBit: string;
  negative: string;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-bot-effect-permissions-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

const CHANGE = 131072; // bit 17: Have bots change things
const DELETE_OR_SEND = 262144; // bit 18: Have bots delete or send
const table = (rows: Row[]) => Object.fromEntries(rows.map((row) => [`${row.universe_id} ${row.key}${row.built_in ? '' : ' (custom)'}`, Number(row.permissions)]));

describe('bot change and delete permissions migration', () => {
  it('gives Admin both, so it still has every permission', () => {
    const after = table(result.once);
    for (const universe of ['u1', 'u2', 'u3']) expect(after[`${universe} admin`]).toBe(131071 | CHANGE | DELETE_OR_SEND);
    expect(131071 | CHANGE | DELETE_OR_SEND).toBe(524287);
  });

  it('gives Editor both, keeping what the owner changed', () => {
    const after = table(result.once);
    expect(after['u1 editor']).toBe(8416 | CHANGE | DELETE_OR_SEND);
    expect(after['u3 editor']).toBe(8416 - 8192 + (CHANGE | DELETE_OR_SEND));
  });

  it('gives Member change things only, keeping what the owner changed', () => {
    const after = table(result.once);
    expect(after['u1 member']).toBe(CHANGE);
    expect(after['u2 member']).toBe(256 | CHANGE);
    expect(after['u3 member']).toBe(CHANGE);
  });

  it('gives Everyone and every custom role neither', () => {
    const before = table(result.before);
    const after = table(result.once);
    const others = Object.keys(before).filter((key) => key.endsWith(' everyone') || key.endsWith('(custom)'));
    expect(others).toHaveLength(6);
    for (const key of others) expect(after[key]).toBe(before[key]);
  });

  it('adds nothing else and takes nothing away', () => {
    const before = table(result.before);
    const after = table(result.once);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) expect(after[key] & before[key]).toBe(before[key]);
    for (const key of Object.keys(before)) expect(after[key] & ~(CHANGE | DELETE_OR_SEND)).toBe(before[key] & ~(CHANGE | DELETE_OR_SEND));
  });

  it('can run again without changing anything', () => {
    expect(table(result.twice)).toEqual(table(result.once));
  });

  it('keeps the rule a bot already had', () => {
    expect(result.ruleKept).toEqual({ allow: '16384', deny: '65536' });
  });

  it('lets a bot rule hold the two new bits next to the four it had, never both Yes and No', () => {
    expect(result.changeAndDelete).toBe('accepted');
    expect(result.everythingAtOnce).toBe('accepted');
    expect(result.overlap).toContain('bot_access_rules_bits');
  });

  it('still refuses any other bit and a negative number', () => {
    for (const refused of [result.outsideBits, result.oldOutsideBit, result.negative]) expect(refused).toContain('bot_access_rules_bits');
  });
});
