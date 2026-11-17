import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { refused, superAdmin } from '@/lib/budget/auth';
import { COMPANIES } from '@/lib/budget/accounts';
import { buildReport } from '@/lib/budget/report';
import { lookAgain } from '@/lib/budget/verify';
import { clearBudgetNotices } from '@/lib/budget/warnings';

export const runtime = 'nodejs';

/**
 * POST /api/admin/budget/accounts/<company>/verify (super admins only)
 * "I topped up, check again": reads that company's account once more and, only when it now has money, asks the backend to look again at the work
 * that was waiting for it. Nothing is resumed on a guess: a company still empty answers that, and the waiting work stays saved. The backend resumes each
 * piece once (its own checks of permissions, payer and cancellation come first), so asking twice never does anything twice.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const user = await superAdmin(request);
  if (!user) return refused();
  const { key } = await context.params;
  if (!COMPANIES.some((company) => company.key === key)) return NextResponse.json({ error: 'That company is not on this page' }, { status: 404 });
  try {
    const report = await buildReport({ onlyCompany: key, userId: user.id });
    const account = report.accounts.find((entry) => entry.key === key)!;
    const looked = await lookAgain(key, account, user.id);
    if (looked.looked) await clearBudgetNotices(`account:${key}:`).catch(() => undefined);
    return NextResponse.json({ account, looked }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'budget' } });
    console.error('[Budget] Could not verify a company:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
