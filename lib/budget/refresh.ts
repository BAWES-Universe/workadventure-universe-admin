import { prisma } from '@/lib/db';
import { getBudgetSettings } from '@/lib/budget/numbers';
import { buildReport } from '@/lib/budget/report';

/**
 * Orbit looks at the budgets and the company accounts for something to warn about whenever a super admin has Orbit open (their notices or attention
 * count is asked for), at most once in the saved number of minutes and never in the way of the answer they asked for. Notices are made once for each
 * level and budget in a month, so looking often tells nobody twice.
 */
let lastLookAt = 0;
let looking = false;

export async function refreshBudgetNotices(now: Date = new Date()): Promise<boolean> {
  if (looking) return false;
  const settings = await getBudgetSettings(prisma);
  if (settings.checkMinutes === null) return false;
  if (now.getTime() - lastLookAt < settings.checkMinutes * 60_000) return false;
  looking = true;
  lastLookAt = now.getTime();
  try {
    await buildReport({ now, notify: true });
    return true;
  } finally {
    looking = false;
  }
}

/** For tests: forget when the last look was. */
export function forgetLastLook(): void {
  lastLookAt = 0;
  looking = false;
}
