import { askedLine, byRouteLine, costLine, failedWords, sheetLine, usesLine } from '@/lib/app-demand-words';
import { cleanAskName } from '@/lib/app-demand';
import type { AppRow } from '@/lib/app-demand';

const base = { uses: 1, people: 1, kind: 'own' as const, costMicros: null, unpriced: 0, ended: 0, failed: 0 };

describe('the words of Apps: use and demand', () => {
  it('writes a use line the way the mock does', () => {
    expect(usesLine({ uses: 3210, people: 240, kind: 'instant' })).toEqual(['3,210 uses', '240 people', 'Instant']);
    expect(usesLine({ uses: 1, people: 1, kind: 'own' })).toEqual(['1 use', '1 person', 'Their own account']);
  });

  it('never says 0% for a few failures, and says nothing when no ending is known', () => {
    expect(failedWords({ ended: 0, failed: 0 })).toBeNull();
    expect(failedWords({ ended: 1000, failed: 2 })).toBe('<1% failed');
    expect(failedWords({ ended: 100, failed: 4 })).toBe('4% failed');
    expect(failedWords({ ended: 100, failed: 0 })).toBe('0% failed');
  });

  it('says "No price yet" instead of $0.00 for runs with no price, and "Not used yet" for an App with none', () => {
    expect(costLine({ ...base, costMicros: 118_400_000, ended: 100, failed: 4 })).toEqual(['$118.40 to us', '4% failed']);
    expect(costLine({ ...base })).toEqual(['No price yet']);
    expect(costLine({ ...base, uses: 0 })).toEqual(['Not used yet']);
  });

  it('says "all refunded" only when it is true', () => {
    const app = { uses: 412, people: 96, ended: 100, failed: 4, allFailedRefunded: true } as AppRow;
    expect(sheetLine(app)).toBe('412 uses · 96 people · 4% failed, all refunded');
    expect(sheetLine({ ...app, allFailedRefunded: false })).toBe('412 uses · 96 people · 4% failed');
  });

  it('splits the cost by route and lists the asked-for counts', () => {
    const app = { byRoute: { composio: { uses: 400, costMicros: 118_400_000 }, universe: { uses: 12, costMicros: 1_200_000 } } } as AppRow;
    expect(byRouteLine(app)).toBe('$118.40 on Composio (400 uses) · $1.20 on Universe (12 uses)');
    expect(byRouteLine({ byRoute: { composio: { uses: 0, costMicros: 0 }, universe: { uses: 0, costMicros: 0 } } } as AppRow)).toBeNull();
    expect(askedLine({ times: 64, people: 41 })).toBe('64 times · by 41 people');
  });
});

describe('cleanAskName: only an App name is kept', () => {
  it('keeps a short name and tidies its spaces and case for counting', () => {
    expect(cleanAskName('  Talabat   orders ')).toEqual({ name: 'Talabat orders', key: 'talabat orders' });
    expect(cleanAskName('Boubyan bank')).toEqual({ name: 'Boubyan bank', key: 'boubyan bank' });
    expect(cleanAskName('KNET')).toEqual({ name: 'KNET', key: 'knet' });
    expect(cleanAskName('طلبات')).toEqual({ name: 'طلبات', key: 'طلبات' });
    expect(cleanAskName('Stack Exchange.com')).not.toBeNull();
  });

  it('cuts the key to the column and groups the same App typed in different cases and accents', () => {
    // Lowercasing İ makes two characters, so the key is made from the name without its marks and is never longer than the column
    for (const text of ['İ'.repeat(60), 'İ'.repeat(40), 'ǅ'.repeat(60)]) {
      const cleaned = cleanAskName(text);
      expect(cleaned).not.toBeNull();
      expect(Array.from(cleaned!.key).length).toBeLessThanOrEqual(60);
    }
    const keys = ['Café', 'CAFÉ', 'cafe', 'Cafe\u0301'].map((text) => cleanAskName(text)!.key);
    expect(new Set(keys)).toEqual(new Set(['cafe']));
    // A character that NFKC spreads into a whole phrase is measured after that, so it is refused, not cut
    expect(cleanAskName('ﷺ'.repeat(12))).toBeNull();
    // The name is kept as typed (after NFKC), only the key loses its accents
    expect(cleanAskName('Café')!.name).toBe('Café');
    // An emoji is not a name: refused, never a crash
    expect(cleanAskName('Talabat 🍔')).toBeNull();
    // Letters with marks of their own (Arabic, Hindi) stay names
    expect(cleanAskName('طَلَبات')).not.toBeNull();
  });

  it('keeps nothing that is not a name', () => {
    for (const text of [null, 5, '', ' ', 'a', 'x'.repeat(61), 'one two three four five six', 'what is my balance?', 'hello, can you help', 'https://example.com', 'www.example.com', 'me@example.com', '<script>', 'a\nb\nc d e f']) {
      expect(cleanAskName(text)).toBeNull();
    }
  });
});
