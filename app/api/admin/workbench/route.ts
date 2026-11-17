import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { getAdapter } from '@/lib/app-adapter';
import { prisma } from '@/lib/db';
import { getCodeJobLimits, getCodeJobPause, saveCodeJobLimits } from '@/lib/workbench/state';
import { CODE_JOB_LIMIT_LABELS, CODE_JOB_LIMIT_RANGES, CODE_JOB_LIMITS_RECOMMENDED, CODE_JOB_NEEDED, checkCodeJobLimits, missingCodeJobLimits, type CodeJobLimits } from '@/lib/workbench/values';

export const runtime = 'nodejs';

const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

/** Every Limit with its value (null when empty), range, suggested value and words. */
function shape(limits: CodeJobLimits) {
  return Object.fromEntries(
    (Object.keys(CODE_JOB_LIMIT_RANGES) as (keyof CodeJobLimits)[]).map((key) => [
      key,
      {
        value: limits[key],
        range: CODE_JOB_LIMIT_RANGES[key],
        recommended: CODE_JOB_LIMITS_RECOMMENDED[key] ?? null,
        ...CODE_JOB_LIMIT_LABELS[key],
        required: CODE_JOB_NEEDED.includes(key),
      },
    ]),
  );
}

async function answer() {
  const limits = await getCodeJobLimits();
  const [pause, running, unconfirmed] = await Promise.all([
    getCodeJobPause(),
    prisma.codeJob.count({ where: { state: { in: ['starting', 'running'] } } }),
    prisma.codeJob.count({ where: { providerState: { in: ['open', 'unknown'] }, state: { notIn: ['starting', 'running'] } } }),
  ]);
  return {
    limits: shape(limits),
    missing: missingCodeJobLimits(limits),
    pause,
    readiness: { providerAdapterOn: !!getAdapter()?.workbench, running, workspacesNotConfirmedDeleted: unconfirmed },
  };
}

/** GET /api/admin/workbench - the code job Limits (each with value, range, suggested value and words), what is missing, whether code jobs are paused, and how many are running. Super admins only. */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return refused();
  try {
    return NextResponse.json(await answer());
  } catch (error) {
    console.error('[CodeJob] Could not read the limits:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** PATCH /api/admin/workbench { <limit>: number | null, ... } - changes only what it names (null empties one) and answers as GET does. */
export async function PATCH(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return refused();
  const body = await request.json().catch(() => null);
  const checked = checkCodeJobLimits(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    await saveCodeJobLimits(checked.value, user.id);
    return NextResponse.json(await answer());
  } catch (error) {
    console.error('[CodeJob] Could not save the limits:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
