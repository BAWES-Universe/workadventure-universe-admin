/**
 * Bot permissions (#426) migration, test plan row 18: runs the real migrations on a throwaway database, then the bot
 * permissions one. Everyone and Admin gain the three bits; nothing else changes for anyone.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = { universe_id: string; key: string; permissions: string; built_in: boolean };
type Result = { before: Row[]; once: Row[]; twice: Row[] };

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-bot-permissions-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

const BITS = 114688; // 16384 + 32768 + 65536: Chat with bots nearby, DM bots, Summon bots
const table = (rows: Row[]) => Object.fromEntries(rows.map((row) => [`${row.universe_id} ${row.key}`, Number(row.permissions)]));

describe('bot permissions migration', () => {
  it('turns the three bits on for Everyone in every universe, keeping what the owner already gave it', () => {
    const after = table(result.once);
    expect(after['u1 everyone']).toBe(BITS);
    expect(after['u2 everyone']).toBe(BITS | 512);
    expect(after['u3 everyone']).toBe(BITS);
  });

  it('gives Admin the three bits too, so it still has every permission', () => {
    const after = table(result.once);
    for (const universe of ['u1', 'u2', 'u3']) expect(after[`${universe} admin`]).toBe(16383 | BITS);
    expect(16383 | BITS).toBe(131071);
  });

  it('touches nothing else: Editor, Member and every custom role keep exactly what they had', () => {
    const before = table(result.before);
    const after = table(result.once);
    const others = Object.keys(before).filter((key) => !key.endsWith(' everyone') && !key.endsWith(' admin'));
    expect(others.length).toBe(9);
    for (const key of others) expect(after[key]).toBe(before[key]);
    // And no row went missing or appeared
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it('no role other than Everyone and Admin has a bot bit, so nobody else changed', () => {
    for (const row of result.once) {
      if (row.key === 'everyone' || row.key === 'admin') continue;
      expect(Number(row.permissions) & BITS).toBe(0);
    }
  });

  it('can run again without changing anything', () => {
    expect(table(result.twice)).toEqual(table(result.once));
  });
});
