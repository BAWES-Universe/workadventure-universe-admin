import { parseFilesList, readFilesList, FILES_LIST_MAX } from '@/lib/computer-files';

const NOW = new Date('2026-11-15T12:00:00Z');

describe('the list of files on a computer', () => {
  it('reads what the machine printed, newest first as it came, with days as ISO times', () => {
    const list = parseFilesList('12\t1794679965.9\tvisa/form.pdf\n3\t1794679000.1\tnotes.txt\n', NOW);
    expect(list).toEqual({
      items: [
        { path: 'visa/form.pdf', bytes: 12, modifiedAt: new Date(1794679965 * 1000).toISOString() },
        { path: 'notes.txt', bytes: 3, modifiedAt: new Date(1794679000 * 1000).toISOString() },
      ],
      more: false,
      listedAt: NOW.toISOString(),
    });
  });

  it('keeps nothing it does not trust: bad numbers, paths that leave the folder, control characters, long paths, odd lines', () => {
    const lines = ['x\t1794679965\ta', '1\tnope\tb', '1\t1794679965\t/etc/passwd', '1\t1794679965\t../up', '1\t1794679965\ta/../b', '1\t1794679965\tbad\u0007name', `1\t1794679965\t${'p'.repeat(301)}`, 'only one', '-5\t1794679965\tneg', '1\t1794679965\tgood.txt'];
    expect(parseFilesList(lines.join('\n'), NOW).items.map((entry) => entry.path)).toEqual(['good.txt']);
  });

  it('lists 200 and says there is more when there were more', () => {
    const many = Array.from({ length: FILES_LIST_MAX + 1 }, (_, i) => `1\t1794679965\tf${i}`).join('\n');
    const list = parseFilesList(many, NOW);
    expect(list.items).toHaveLength(FILES_LIST_MAX);
    expect(list.more).toBe(true);
    expect(parseFilesList(many.split('\n').slice(0, FILES_LIST_MAX).join('\n'), NOW).more).toBe(false);
  });

  it('reads a stored list back safely: anything else is no list', () => {
    expect(readFilesList(null)).toBeNull();
    expect(readFilesList('x')).toBeNull();
    expect(readFilesList({ items: 'no', listedAt: 'x' })).toBeNull();
    expect(readFilesList({ items: [{ path: 'a', bytes: 1, modifiedAt: 'x' }, { path: 5 }], more: true, listedAt: 'y' })).toEqual({ items: [{ path: 'a', bytes: 1, modifiedAt: 'x' }], more: true, listedAt: 'y' });
  });
});
