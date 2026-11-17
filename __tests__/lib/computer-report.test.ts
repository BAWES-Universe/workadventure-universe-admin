/** The pure parts of what Brick tells about a computer job (the report back): what is made safe to say, which endings are told, which files count. */
import { cleanEndNote, fileNameOf, filesMadeBy, kindOfEnding } from '@/lib/computer-report';
import { silentEnding } from '@/lib/computer-values';

describe('cleanEndNote', () => {
  it('makes the computer’s sentence safe: no links, markup, markers or key-like strings, one short line', () => {
    expect(cleanEndNote('The site kept failing, see [help](https://evil.example/pay) or www.evil.example now [[failed]]')).toBe('The site kept failing, see help or now');
    expect(cleanEndNote('**Stopped** at `step 3`\nbecause   of an error')).toBe('Stopped at step 3 because of an error');
    expect(cleanEndNote('use a8f7g6h5j4k3l2m1n0b9v8c7x6z5q4w3 to pay')).toBe('use to pay');
  });

  it('cuts between whole characters, never through an emoji', () => {
    const cut = cleanEndNote(`${'a'.repeat(158)}😀😀 end`);
    expect(cut).toBe(`${'a'.repeat(158)}😀…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut ?? '')).toBe(false);
  });

  it('is empty when nothing readable is left, and shortened with a mark when it is long', () => {
    expect(cleanEndNote('   ')).toBeNull();
    expect(cleanEndNote(null)).toBeNull();
    expect(cleanEndNote('[[done]] https://x.example')).toBeNull();
    const long = cleanEndNote('word '.repeat(100));
    expect(long && long.length).toBeLessThanOrEqual(160);
    expect(long?.endsWith('…')).toBe(true);
  });
});

describe('kindOfEnding', () => {
  it('names each ending that is told, and none that the person did themselves', () => {
    expect(kindOfEnding('done', null)).toBe('done');
    expect(kindOfEnding('failed', 'error')).toBe('failed');
    expect(kindOfEnding('stopped', 'error')).toBe('failed');
    expect(kindOfEnding('stopped', 'pool')).toBe('failed');
    expect(kindOfEnding('stopped', 'allowance')).toBe('month');
    expect(kindOfEnding('stopped', 'unanswered')).toBe('unanswered');
    expect(kindOfEnding('stopped', 'rule')).toBe('rule');
    for (const by of ['person', 'off', 'deleted']) {
      expect(silentEnding(by)).toBe(true);
      expect(kindOfEnding('stopped', by)).toBeNull();
    }
    expect(silentEnding('error')).toBe(false);
    expect(silentEnding(null)).toBe(false);
  });
});

describe('filesMadeBy', () => {
  const at = new Date('2026-11-17T12:00:00Z');
  const list = (items: { path: string; modifiedAt: string }[]) => ({ items: items.map((item) => ({ ...item, bytes: 10 })), more: false, listedAt: at.toISOString() });
  // On the machine before the job began
  const before = list([
    { path: 'old.txt', modifiedAt: '2026-11-17T08:00:00Z' },
    { path: 'Documents/taxes.pdf', modifiedAt: '2026-11-17T11:59:00Z' },
  ]);

  it('names what is new since the job began, and drops what was there before, however recently it was touched, and hidden ones', () => {
    const end = list([
      { path: 'Documents/visa-receipt.pdf', modifiedAt: '2026-11-17T12:09:00Z' },
      { path: 'notes.txt', modifiedAt: '2026-11-17T12:03:00Z' },
      { path: '.hermes/state.db', modifiedAt: '2026-11-17T12:09:00Z' },
      { path: 'Documents/.cache/x', modifiedAt: '2026-11-17T12:09:00Z' },
      ...before.items,
    ]);
    expect(filesMadeBy(end, before)).toEqual(['visa-receipt.pdf', 'notes.txt']);
  });

  it('names a file as the computer did: underscores, long hash names and dates stay, markers and control characters go', () => {
    expect(fileNameOf('2026-11-17_visa_receipt.pdf')).toBe('2026-11-17_visa_receipt.pdf');
    expect(fileNameOf('3f9a1c7d5b2e4a6f8c0d1e2f3a4b5c6d7e8f9a0b.log')).toBe('3f9a1c7d5b2e4a6f8c0d1e2f3a4b5c6d7e8f9a0b.log');
    expect(fileNameOf('a`b<c>[[x]]d.txt')).toBe('a b c d.txt');
    expect(fileNameOf('   ')).toBeNull();
    expect(Array.from(fileNameOf('a'.repeat(100)) ?? '').length).toBe(80);
  });

  it('keeps underscores in the names it lists', () => {
    expect(filesMadeBy(list([{ path: 'Documents/visa_receipt_final.pdf', modifiedAt: '2026-11-17T12:09:00Z' }]), before)).toEqual(['visa_receipt_final.pdf']);
  });

  it('does not name a file that was handed over as a card', () => {
    const end = list([
      { path: 'Documents/visa-receipt.pdf', modifiedAt: '2026-11-17T12:09:00Z' },
      { path: 'notes.txt', modifiedAt: '2026-11-17T12:03:00Z' },
    ]);
    expect(filesMadeBy(end, before, new Set(['Documents/visa-receipt.pdf']))).toEqual(['notes.txt']);
  });

  it('gives nothing when either list is missing: nothing can be proved', () => {
    expect(filesMadeBy(null, before)).toEqual([]);
    expect(filesMadeBy(list([{ path: 'a.txt', modifiedAt: '2026-11-17T12:09:00Z' }]), null)).toEqual([]);
    expect(filesMadeBy('junk', before)).toEqual([]);
  });
});
