/** Which extra usage is reported when several run for one person (game #1999): the same one, whatever order the rows come in. */
import { pickRunning } from '@/lib/meter-grants';

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12));
const grant = (grantKey: string, multiplier: number | null, endsAt: Date, noLimit = false) => ({ grantKey, multiplier, noLimit, endsAt });

describe('pickRunning', () => {
  it('is null when nothing runs', () => {
    expect(pickRunning([])).toBeNull();
  });

  it('takes the largest, and no limit beats any multiple', () => {
    expect(pickRunning([grant('a', 2, at(20)), grant('b', 5, at(15)), grant('c', 3, at(25))])?.grantKey).toBe('b');
    expect(pickRunning([grant('a', 5, at(20)), grant('n', null, at(12), true)])?.grantKey).toBe('n');
  });

  it('takes the one that ends later of two the same size', () => {
    expect(pickRunning([grant('soon', 5, at(14)), grant('late', 5, at(18))])?.grantKey).toBe('late');
    expect(pickRunning([grant('late', 5, at(18)), grant('soon', 5, at(14))])?.grantKey).toBe('late');
  });

  it('takes the same one of two that are the same size and end together, in whatever order they come', () => {
    const rows = [grant('k-b', null, at(18), true), grant('k-a', null, at(18), true), grant('k-c', null, at(18), true)];
    expect(pickRunning(rows)?.grantKey).toBe('k-a');
    expect(pickRunning([...rows].reverse())?.grantKey).toBe('k-a');
    expect(pickRunning([rows[1], rows[2], rows[0]])?.grantKey).toBe('k-a');
  });
});
