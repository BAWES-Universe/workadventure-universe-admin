/**
 * Brick reports (mock "Brick reports inbox"): the cleaning every note goes through, how alike two titles read, and the priority with its
 * reasons. No database needed.
 */
import { TEXT_MAX, TITLE_MAX, cleanReportText, priorityOf, titleLikeness } from '@/lib/brick-reports';

describe('cleaning a note', () => {
  it.each([
    ['an email', 'Could not mail sara.k+test@example.co.uk today', 'Could not mail today'],
    ['a link', 'The page https://booking.example.com/a?b=1 did not open', 'The page did not open'],
    ['a link with www', 'Opened www.example.org/path fine', 'Opened fine'],
    ['a bare web address', 'Checked bawes.net/about and shop.example.io', 'Checked and'],
    ['an @name', 'Asked @khalid_b about it, and @sara.', 'Asked about it, and.'],
    ['a phone number', 'Called +965 5555-1234 twice', 'Called twice'],
    ['a phone number in brackets', 'Ring (02) 9876 5432 please', 'Ring please'],
    ['a long number', 'Booking 99881234 failed', 'Booking failed'],
  ])('takes out %s', (_what, raw, clean) => {
    expect(cleanReportText(raw, TEXT_MAX)).toBe(clean);
  });

  it('keeps ordinary words, short numbers, years and versions', () => {
    expect(cleanReportText('Replies take over 1 minute since 2026, in version 0.5.1 of Node.js', TEXT_MAX)).toBe('Replies take over 1 minute since 2026, in version 0.5.1 of Node.js');
  });

  it('folds spaces and control characters, and cuts to the limit in whole characters', () => {
    expect(cleanReportText('  a\n\tb   c ', TEXT_MAX)).toBe('a b c');
    expect(cleanReportText('x'.repeat(200), TITLE_MAX)).toHaveLength(TITLE_MAX);
    expect(Array.from(cleanReportText('😀'.repeat(100), TITLE_MAX))).toHaveLength(TITLE_MAX);
  });

  it('anything that is not text is empty', () => {
    expect(cleanReportText(undefined, TEXT_MAX)).toBe('');
    expect(cleanReportText(42, TEXT_MAX)).toBe('');
  });
});

describe('how alike two titles read', () => {
  it('the same problem in other words reads alike; another problem does not', () => {
    expect(titleLikeness("Links inside pages don't open", 'Links inside pages do not open')).toBeGreaterThan(0.42);
    expect(titleLikeness('Page links do not open', 'Page links won’t open when tapped')).toBeGreaterThan(0.42);
    expect(titleLikeness('Page links do not open', 'Voice cuts out after a minute')).toBeLessThan(0.2);
    expect(titleLikeness('', 'Anything')).toBe(0);
  });

  it('case and accents do not matter', () => {
    expect(titleLikeness('Café menu', 'CAFE MENU')).toBe(1);
  });
});

describe('priority', () => {
  it('3 a Brick, 2 a person, 5 if it stopped the work, 3 if rising, 6 if it came back, with the reasons', () => {
    expect(priorityOf({ bricks: 9, people: 14, stoppedWork: true, thisWeek: 15, lastWeek: 7, cameBack: false })).toEqual({
      score: 63,
      level: 'high',
      rising: true,
      reasons: [
        { label: 'Stopped the work', points: 5 },
        { label: '9 Bricks', points: 27 },
        { label: '14 people', points: 28 },
        { label: '15 this week, 7 last week', points: 3 },
      ],
    });
    expect(priorityOf({ bricks: 1, people: 1, stoppedWork: false, thisWeek: 1, lastWeek: 0, cameBack: true })).toMatchObject({
      score: 11,
      level: 'low',
      rising: false,
      reasons: [
        { label: '1 Brick', points: 3 },
        { label: '1 person', points: 2 },
        { label: 'Came back after a fix', points: 6 },
      ],
    });
  });

  it('is rising only when this week has half again more than a week that had some', () => {
    expect(priorityOf({ bricks: 1, people: 0, stoppedWork: false, thisWeek: 5, lastWeek: 0, cameBack: false }).rising).toBe(false);
    expect(priorityOf({ bricks: 1, people: 0, stoppedWork: false, thisWeek: 3, lastWeek: 2, cameBack: false }).rising).toBe(true);
    expect(priorityOf({ bricks: 1, people: 0, stoppedWork: false, thisWeek: 2, lastWeek: 2, cameBack: false }).rising).toBe(false);
  });

  it('medium from 12 points, high from 25', () => {
    expect(priorityOf({ bricks: 2, people: 0, stoppedWork: false, thisWeek: 0, lastWeek: 0, cameBack: false }).level).toBe('low');
    expect(priorityOf({ bricks: 4, people: 0, stoppedWork: false, thisWeek: 0, lastWeek: 0, cameBack: false }).level).toBe('medium');
    expect(priorityOf({ bricks: 5, people: 5, stoppedWork: false, thisWeek: 0, lastWeek: 0, cameBack: false }).level).toBe('high');
  });
});
