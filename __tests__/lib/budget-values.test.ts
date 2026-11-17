/**
 * The page's own settings (warning levels, how a forecast is read), the change lines a save writes, and the rule that no money, limit or warning
 * level is a constant in the page's code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUDGET_RANGES, checkBudgetSettings, readBudgetSettings, type BudgetSettings } from '@/lib/budget/values';
import { changesBetween } from '@/lib/budget/history';
import { NUMBER_DEFS, rangeOf, available } from '@/lib/budget/numbers';
import { METER_RANGES } from '@/lib/meter-values';

const saved: BudgetSettings = readBudgetSettings({ warnFirstPercent: 50, warnSecondPercent: 80, warnThirdPercent: 95, sampleDays: 7, sparseDays: 3, burstPercent: 50, raiseRoomPercent: 110, raiseHeadroomPercent: 150, idleDays: 30, checkMinutes: 15 });

describe('the page’s settings', () => {
  it('reads what is saved and leaves the rest empty, never a built-in value', () => {
    expect(saved.warnSecondPercent).toBe(80);
    const empty = readBudgetSettings({});
    expect(Object.values(empty).every((value) => value === null)).toBe(true);
    expect(readBudgetSettings(null).sampleDays).toBeNull();
  });

  it('ignores a saved value outside its range', () => {
    expect(readBudgetSettings({ warnFirstPercent: 500 }).warnFirstPercent).toBeNull();
    expect(readBudgetSettings({ sampleDays: 1.5 }).sampleDays).toBeNull();
  });

  it('refuses a number outside its range with the range in the line, and an unknown name', () => {
    const outside = checkBudgetSettings({ warnFirstPercent: 0 }, saved);
    expect(outside.ok).toBe(false);
    expect(!outside.ok && outside.error).toContain(`from ${BUDGET_RANGES.warnFirstPercent.min} to ${BUDGET_RANGES.warnFirstPercent.max}`);
    expect(checkBudgetSettings({ nope: 1 }, saved).ok).toBe(false);
  });

  it('keeps the three warning levels in order', () => {
    expect(checkBudgetSettings({ warnFirstPercent: 90 }, saved).ok).toBe(false);
    expect(checkBudgetSettings({ warnThirdPercent: 60 }, saved).ok).toBe(false);
    expect(checkBudgetSettings({ warnFirstPercent: 40, warnSecondPercent: 70, warnThirdPercent: 99 }, saved).ok).toBe(true);
  });
});

describe('the change lines of a save', () => {
  it('names the numbers that really changed, with the old and the new value', () => {
    const lines = changesBetween('meter', ['poolCeilingMicros', 'reserveMicros'], { poolCeilingMicros: 2_000_000, reserveMicros: 500_000 }, { poolCeilingMicros: 90_000_000, reserveMicros: 500_000 });
    expect(lines).toEqual([{ store: 'meter', key: 'poolCeilingMicros', oldValue: 2_000_000, newValue: 90_000_000 }]);
  });

  it('records a number that was not set, and one that was emptied', () => {
    expect(changesBetween('meter', ['atOnceAll'], {}, { atOnceAll: 10 })).toEqual([{ store: 'meter', key: 'atOnceAll', oldValue: null, newValue: 10 }]);
    expect(changesBetween('instant', ['maxRunMicros'], { maxRunMicros: 30_000 }, {})).toEqual([{ store: 'instant', key: 'maxRunMicros', oldValue: 30_000, newValue: null }]);
  });

  it('writes nothing for a save that changes nothing', () => {
    expect(changesBetween('meter', ['atOnceAll'], { atOnceAll: 10 }, { atOnceAll: 10 })).toEqual([]);
  });
});

describe('the list of numbers', () => {
  it('has every meter number a super admin could not reach before', () => {
    const ids = NUMBER_DEFS.map((def) => def.id);
    for (const key of ['speechMemberCeilingSeconds', 'appUseCeilingMicros', 'appUseMemberCeilingMicros', 'poolCeilingMicros', 'reserveMicros', 'atOnceMember', 'atOnceAll', 'storageMicrosPerGbMonth']) expect(ids).toContain(`meter:${key}`);
  });

  it('takes each range from its own store, and leaves out a number its store does not hold', () => {
    const pool = NUMBER_DEFS.find((def) => def.key === 'poolCeilingMicros')!;
    expect(rangeOf(pool)).toEqual(METER_RANGES.poolCeilingMicros);
    for (const def of NUMBER_DEFS) expect(available(def)).toBe(rangeOf(def) !== null);
  });

  it('gives every number an id that is its store and its name, once', () => {
    const ids = NUMBER_DEFS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of NUMBER_DEFS) expect(def.id).toBe(`${def.store}:${def.key}`);
  });
});

describe('nothing fixed in code', () => {
  const root = path.resolve(__dirname, '../..');
  const files = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const mine = [...files('lib/budget'), ...files('app/admin/ai-providers/budget'), ...files('app/api/admin/budget')].filter((file) => /\.(ts|tsx)$/.test(file));

  it('finds no money, limit, price or warning level held as a constant in the Budget code', () => {
    // A name that says money, a limit, a price or a level, assigned a number
    const named = /\b(?:const|let)\s+[A-Za-z_]*(?:MICROS|CEILING|BUDGET|LIMIT|PRICE|RATE|PERCENT|LEVEL|WARN|SECONDS|DOLLARS)[A-Za-z_]*\s*(?::[^=]+)?=\s*[\d_.]+\s*[;,]/i;
    // A literal dollar amount in a sentence the page shows
    const amount = /\$\d/;
    const found: string[] = [];
    for (const file of mine) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      text.split('\n').forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '');
        if (named.test(code) || (amount.test(code) && !code.trim().startsWith('*') && !code.includes('${'))) found.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
