/**
 * The kind line for "New Bricks per hour": the time it names is never before the moment a person can make another Brick.
 */
import { newBricksLine } from '@/lib/brick-new-limit';

jest.mock('@/lib/db', () => ({ prisma: { userPreference: { findUnique: jest.fn() } } }));

describe('newBricksLine', () => {
  const now = new Date('2026-11-21T12:00:00.000Z');

  it('says the next whole minute when the time has seconds, so a try inside the minute is not refused again', () => {
    // 12:40:59 UTC is 3:40:59 PM in Kuwait: "3:40 PM" would be a minute early
    const line = newBricksLine(new Date('2026-11-21T12:40:59.000Z'), 'Asia/Kuwait', now);
    expect(line).toBe("You've made a lot of Bricks this hour. Try again at 3:41 PM.");
  });

  it('keeps an exact minute as it is', () => {
    expect(newBricksLine(new Date('2026-11-21T12:40:00.000Z'), 'Asia/Kuwait', now)).toBe("You've made a lot of Bricks this hour. Try again at 3:40 PM.");
  });

  it('says the minutes, rounded up, when no time zone is kept', () => {
    expect(newBricksLine(new Date('2026-11-21T12:25:01.000Z'), null, now)).toBe("You've made a lot of Bricks this hour. Try again in 26 minutes.");
  });
});
