import type { QuestRecurrence } from '@prisma/client';

export interface AttemptWindow {
  startsAt: Date;
  /** Null for a one-shot quest: its single attempt never ends. */
  endsAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The attempt an action at `at` belongs to. Boundaries are UTC midnight; a week starts on Monday. */
export function attemptWindow(recurrence: QuestRecurrence, at: Date): AttemptWindow {
  switch (recurrence) {
    case 'ONCE':
      return { startsAt: new Date(0), endsAt: null };
    case 'DAILY': {
      const startsAt = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
      return { startsAt, endsAt: new Date(startsAt.getTime() + DAY_MS) };
    }
    case 'WEEKLY': {
      const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
      const sinceMonday = (day.getUTCDay() + 6) % 7;
      const startsAt = new Date(day.getTime() - sinceMonday * DAY_MS);
      return { startsAt, endsAt: new Date(startsAt.getTime() + 7 * DAY_MS) };
    }
  }
}

export function inWindow(window: AttemptWindow, at: Date): boolean {
  return at.getTime() >= window.startsAt.getTime() && (window.endsAt === null || at.getTime() < window.endsAt.getTime());
}
