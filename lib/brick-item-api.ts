import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import type { Refused } from '@/lib/brick-items';

/** What every goals and tasks route answers when something unexpected went wrong: 401 for a bad service token, else a plain 500. */
export function itemsFailed(error: unknown, what: string) {
  if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  Sentry.captureException(error, { tags: { area: 'brick-items' } });
  console.error(`[BrickItems] ${what} failed:`, error instanceof Error ? error.message : 'unknown');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** A refusal as the answer: the words, and the code and setting the Brick can say plainly. */
export const itemsRefused = (refused: Refused) =>
  NextResponse.json({ error: refused.error, ...(refused.code ? { code: refused.code } : {}), ...(refused.limit !== undefined ? { limit: refused.limit } : {}) }, { status: refused.status });
