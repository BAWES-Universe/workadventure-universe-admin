import { groupByBrick } from '@/lib/brick-purge-lock';

describe('grouping a batch of rows by Brick', () => {
  it('keeps the order of the rows, within each Brick and across them', () => {
    const rows = [
      { botId: 'b', n: 1 },
      { botId: 'a', n: 2 },
      { botId: 'b', n: 3 },
      { botId: 'c', n: 4 },
      { botId: 'a', n: 5 },
    ];
    const grouped = groupByBrick(rows);
    expect([...grouped.keys()]).toEqual(['b', 'a', 'c']);
    expect(grouped.get('b')?.map((row) => row.n)).toEqual([1, 3]);
    expect(grouped.get('a')?.map((row) => row.n)).toEqual([2, 5]);
    expect(grouped.get('c')?.map((row) => row.n)).toEqual([4]);
  });

  it('does not copy a growing array for every row: a very large batch of one Brick is grouped at once', () => {
    const rows = Array.from({ length: 200_000 }, (_, n) => ({ botId: 'one', n }));
    const started = Date.now();
    const grouped = groupByBrick(rows);
    // Copying the group for each row would be about twenty billion element copies; this is a few milliseconds
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(grouped.get('one')).toHaveLength(200_000);
    expect(grouped.get('one')?.[199_999].n).toBe(199_999);
  });
});
