import { ownerSinceLine, whatMoves, whatMovesCount } from '@/lib/ownership-text';

describe('what moves with a universe (#820)', () => {
  it('names the world when there is one, counts them when there are more', () => {
    expect(whatMoves(['Infinite Void'])).toBe('the world Infinite Void and every room in it');
    expect(whatMoves(['A', 'B', 'C'])).toBe('its 3 worlds and every room in them');
    expect(whatMoves([])).toBe('every room in it');
  });

  it('says the same from a count alone', () => {
    expect(whatMovesCount(1)).toBe('its world and every room in it');
    expect(whatMovesCount(2)).toBe('its 2 worlds and every room in them');
    expect(whatMovesCount(0)).toBe('every room in it');
  });
});

describe('the owner row', () => {
  const day = () => 'today';
  it('says who created the universe unless it was passed on', () => {
    expect(ownerSinceLine({ universeName: 'Autonode Labs', isYou: true, since: null, from: null, day })).toBe('You created Autonode Labs');
    expect(ownerSinceLine({ universeName: 'Autonode Labs', isYou: false, since: null, from: null, day })).toBe('Created Autonode Labs');
  });

  it('says since when and from whom once it was passed on', () => {
    expect(ownerSinceLine({ universeName: 'Autonode Labs', isYou: true, since: '2026-11-05T09:00:00Z', from: 'Yousef', day })).toBe('Since today · from Yousef');
    expect(ownerSinceLine({ universeName: 'Autonode Labs', isYou: true, since: '2026-11-05T09:00:00Z', from: null, day })).toBe('Since today');
  });
});
