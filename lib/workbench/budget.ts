import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { SANDBOX_RUN_MICROS } from '@/lib/composio-rates';
import { getCodeJobLimits, getCodeJobPause } from '@/lib/workbench/state';

/**
 * Code jobs as one of the three Apps lines of the Budget page (connected Apps, Instant Apps, code jobs). The page only shows and saves what is
 * enforced here, under the keys the Limits already have, so nothing is renamed: the month's ceiling is `exposureCeilingMicros`, jobs at once are
 * `atOnceAll` and `atOncePerPerson`, jobs a day are `jobsPerPersonPerDay`. This reads the money side of those Limits.
 */
export interface CodeJobsBudgetLine {
  line: 'code_jobs';
  /** The month's ceiling (Limit `exposureCeilingMicros`), null while empty. */
  budgetMicros: number | null;
  /** Jobs at once, in all and for one person (Limits `atOnceAll`, `atOncePerPerson`). */
  atOnceAll: number | null;
  atOncePerPerson: number | null;
  /** What jobs settled at this month, with their workspaces confirmed gone. */
  settledMicros: number;
  /** Held for jobs going now. */
  heldMicros: number;
  /** Held for jobs that ended but whose workspace is not confirmed deleted: they may still be running, so they stay counted at what was held. */
  owedWhileUncertainMicros: number;
  /** All that counts against the ceiling: settled + held + owed while uncertain. */
  countedMicros: number;
  running: number;
  workspacesNotConfirmedDeleted: number;
  /** Jobs whose provider log has not yet been read after their workspace was confirmed deleted. */
  logsNotYetChecked: number;
  /** What one run is priced at (the saved App price, else the provider's list price). */
  runPriceMicros: number;
  runsThisMonth: number;
  paused: boolean;
  pauseReason: string | null;
  /** A straight-line look ahead from this month's use, with the sample it rests on (never a promise: a burst can reach the ceiling sooner). */
  forecast: { monthMicros: number; sample: { from: string; to: string; jobs: number } } | null;
}

const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const monthEnd = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
const asNumber = (value: bigint | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

export async function readCodeJobsBudget(now: Date = new Date()): Promise<CodeJobsBudgetLine> {
  const from = monthStart(now);
  const [limits, pause, settings, rows, running, notConfirmed, unchecked] = await Promise.all([
    getCodeJobLimits(),
    getCodeJobPause(),
    getMeterSettings(),
    prisma.codeJob.findMany({ where: { createdAt: { gte: from } }, select: { state: true, providerState: true, reservedMicros: true, settledMicros: true, cellsRun: true, preparedRuns: true } }),
    prisma.codeJob.count({ where: { state: { in: ['starting', 'running'] } } }),
    prisma.codeJob.count({ where: { providerState: { in: ['open', 'unknown'] }, state: { notIn: ['starting', 'running'] } } }),
    prisma.codeJob.count({ where: { providerSessionId: { not: null }, nestedCheckedAt: null, state: { notIn: ['starting', 'running'] } } }),
  ]);
  let settled = 0;
  let held = 0;
  let owed = 0;
  let runs = 0;
  for (const row of rows) {
    runs += row.cellsRun + row.preparedRuns;
    const going = row.state === 'starting' || row.state === 'running';
    if (going) held += asNumber(row.reservedMicros);
    else if (row.providerState === 'open' || row.providerState === 'unknown') owed += asNumber(row.reservedMicros);
    else settled += asNumber(row.settledMicros ?? row.reservedMicros);
  }
  const counted = settled + held + owed;
  const elapsed = now.getTime() - from.getTime();
  const forecast = rows.length > 0 && elapsed > 0 ? { monthMicros: Math.round((counted / elapsed) * (monthEnd(now).getTime() - from.getTime())), sample: { from: from.toISOString(), to: now.toISOString(), jobs: rows.length } } : null;
  return {
    line: 'code_jobs',
    budgetMicros: limits.exposureCeilingMicros,
    atOnceAll: limits.atOnceAll,
    atOncePerPerson: limits.atOncePerPerson,
    settledMicros: settled,
    heldMicros: held,
    owedWhileUncertainMicros: owed,
    countedMicros: counted,
    running,
    workspacesNotConfirmedDeleted: notConfirmed,
    logsNotYetChecked: unchecked,
    runPriceMicros: settings.appUseMicros ?? SANDBOX_RUN_MICROS,
    runsThisMonth: runs,
    paused: pause.paused,
    pauseReason: pause.reason,
    forecast,
  };
}
