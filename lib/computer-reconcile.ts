import * as Sentry from '@sentry/nextjs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getComputerProvider, type ComputerProvider, type ProviderDay } from '@/lib/computer-provider';

/**
 * The daily check of our books against the computer provider's own bill (build handoff v2, section 8: "Reconciliation: daily, against
 * Agent37's per-instance usage, using provider ids and watermarks, never by adding totals again. This catches drift. The reserves are what
 * prevent overspend.").
 *
 * It reads and reports. It never writes a cost into the meter, never changes a reservation and never touches a machine: what it finds goes into
 * one row for the day (`computer_reconciles`, the watermark is the newest day written), the readiness page, and Sentry. Four findings:
 *  - `managed_spend`: a Brick machine's bill has money on the provider's own services (model, search, apps). Its managed budget is $0.
 *  - `unknown_machine`: a machine the provider bills as a Brick's that none of our records points to (one we lost track of).
 *  - `unbooked_time`: more minutes awake than our jobs held the machine, beyond the room a start and a stop need.
 *  - `rate_gap`: the bill is higher than the published rates make of those minutes (the rate table in lib/agent37/rates.ts needs a look).
 * Machines on the account that are not Bricks, and machines that are gone, are only counted in the day's total.
 * Booking more than the provider billed is never a finding: our books err on the safe side.
 */

/**
 * How sensitive the check is, not a limit on anyone's use: a job's own start and stop leave a few minutes awake (a copy saved from a resting
 * machine wakes it, auto sleep waits 15 minutes), and a job's seconds are held by its stretch, so this much more awake than booked is normal.
 */
export const UNBOOKED_SLACK_MINUTES = 20;
export const UNBOOKED_SLACK_FRACTION = 0.25;
/** A bill this much over what the published rates make of the minutes (and at least a few thousandths of a cent) is a gap in the rates. */
export const RATE_SLACK_FRACTION = 0.1;
export const RATE_SLACK_MICROS = 5_000;
/** The provider's day is read this long after it ended, so its own roll-up has settled. */
export const REPORT_LAG_MS = 60 * 60 * 1000;
/** Days caught up in one run after the check was missed. */
export const MAX_DAYS_PER_RUN = 7;
/** A failed read is asked again no sooner than this. */
const RETRY_AFTER_MS = 15 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIED_KEY = 'computer-reconcile-tried';

export type FindingKind = 'managed_spend' | 'unknown_machine' | 'unbooked_time' | 'rate_gap';

export interface Finding {
  kind: FindingKind;
  ref: string;
  botId: string | null;
  /** What the provider says (minutes for `unbooked_time`, micros for the rest) and what our books say. */
  theirs: number;
  ours: number;
  /** What the finding comes to, in micros. */
  gapMicros: number;
}

export interface Books {
  /** Provider id of each machine of ours, to the Brick it belongs to. */
  machines: Map<string, string>;
  /** Minutes each Brick's machine was held by a job that day. */
  minutesByBot: Map<string, number>;
}

export interface DayResult {
  findings: Finding[];
  /** The part of the bill that was Brick machines. */
  agentBrickMicros: number;
  ourMinutes: number;
  agentMinutes: number;
  gapMicros: number;
}

/** Compares one provider day with our books. Pure: the rule is here, the reading is elsewhere. */
export function compareDay(day: ProviderDay, books: Books, awakeMicrosPerMinute: number | null): DayResult {
  const findings: Finding[] = [];
  let agentBrickMicros = 0;
  let ourMinutes = 0;
  let agentMinutes = 0;
  for (const machine of day.instances) {
    if (machine.kind !== 'brick') continue;
    agentBrickMicros += machine.totalMicros;
    agentMinutes += machine.awakeMinutes;
    const managed = Math.max(0, machine.totalMicros - machine.computeMicros);
    if (managed > 0) findings.push({ kind: 'managed_spend', ref: machine.ref, botId: machine.botId, theirs: managed, ours: 0, gapMicros: managed });
    // A machine nobody wrote down is only ever "unknown": its time cannot be compared with the books of a Brick it does not belong to
    if (!machine.botId || books.machines.get(machine.ref) !== machine.botId) {
      findings.push({ kind: 'unknown_machine', ref: machine.ref, botId: machine.botId, theirs: machine.totalMicros, ours: 0, gapMicros: machine.totalMicros });
      continue;
    }
    const held = Math.round(books.minutesByBot.get(machine.botId) ?? 0);
    ourMinutes += held;
    const allowed = held * (1 + UNBOOKED_SLACK_FRACTION) + UNBOOKED_SLACK_MINUTES;
    if (machine.awakeMinutes > allowed) {
      findings.push({ kind: 'unbooked_time', ref: machine.ref, botId: machine.botId, theirs: machine.awakeMinutes, ours: held, gapMicros: awakeMicrosPerMinute === null ? 0 : Math.round((machine.awakeMinutes - allowed) * awakeMicrosPerMinute) });
    }
    if (machine.expectedMicros !== null && machine.computeMicros > machine.expectedMicros * (1 + RATE_SLACK_FRACTION) + RATE_SLACK_MICROS) {
      findings.push({ kind: 'rate_gap', ref: machine.ref, botId: machine.botId, theirs: machine.computeMicros, ours: machine.expectedMicros, gapMicros: machine.computeMicros - machine.expectedMicros });
    }
  }
  return { findings, agentBrickMicros, ourMinutes, agentMinutes, gapMicros: findings.reduce((sum, finding) => sum + finding.gapMicros, 0) };
}

const dayWord = (at: Date) => at.toISOString().slice(0, 10);

/** One UTC day, midnight to midnight. */
export function dayBounds(day: string): { from: Date; to: Date } {
  const from = new Date(`${day}T00:00:00Z`);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

/** The days to check now: every day after the newest one checked, up to the last whose roll-up has settled. Oldest first; a first run checks only that last day. */
export function daysToCheck(now: Date, lastChecked: string | null): string[] {
  const latest = dayWord(new Date(now.getTime() - REPORT_LAG_MS - DAY_MS));
  const days: string[] = [];
  if (lastChecked === null) return [latest];
  for (let at = new Date(dayBounds(lastChecked).to); dayWord(at) <= latest && days.length < MAX_DAYS_PER_RUN; at = new Date(at.getTime() + DAY_MS)) days.push(dayWord(at));
  return days;
}

/** The minutes each Brick's machine was held by a job on this day: the part of each job's time that falls in it, never more than the seconds it held. */
async function booksFor(day: string, now: Date): Promise<Books> {
  const { from, to } = dayBounds(day);
  const machines = new Map<string, string>();
  for (const row of await prisma.brickComputer.findMany({ where: { NOT: { providerRef: null } }, select: { botId: true, providerRef: true } })) {
    if (row.providerRef) machines.set(row.providerRef, row.botId);
  }
  const jobs = await prisma.computerJob.findMany({
    where: { startedAt: { not: null, lt: to }, OR: [{ endedAt: null }, { endedAt: { gt: from } }] },
    select: { botId: true, startedAt: true, endedAt: true, secondsRun: true, stretchStarted: true },
  });
  const seconds = new Map<string, number>();
  for (const job of jobs) {
    const started = job.startedAt as Date;
    const ended = job.endedAt ?? now;
    const overlap = Math.max(0, (Math.min(ended.getTime(), to.getTime()) - Math.max(started.getTime(), from.getTime())) / 1000);
    // A job that is over held the machine for the seconds it recorded; one still running has its stretch so far besides
    const held = job.endedAt ? job.secondsRun : job.secondsRun + (job.stretchStarted ? Math.max(0, (now.getTime() - job.stretchStarted.getTime()) / 1000) : 0);
    seconds.set(job.botId, (seconds.get(job.botId) ?? 0) + Math.min(overlap, held));
  }
  // A pack-away holds a Brick's computer awake with no job on it: that time is the books' own (written in computer_cold_runs), so it is not "unbooked"
  const packs = await prisma.computerColdRun.findMany({ where: { scratch: false, botId: { not: null }, startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gt: from } }] }, select: { botId: true, startedAt: true, endedAt: true } });
  for (const run of packs) {
    const ended = run.endedAt ?? now;
    const overlap = Math.max(0, (Math.min(ended.getTime(), to.getTime()) - Math.max(run.startedAt.getTime(), from.getTime())) / 1000);
    if (run.botId) seconds.set(run.botId, (seconds.get(run.botId) ?? 0) + overlap);
  }
  const minutesByBot = new Map<string, number>();
  // A machine cannot be awake for more than the day, however many read-only jobs overlapped on it
  for (const [botId, total] of seconds) minutesByBot.set(botId, Math.min(total / 60, 1440));
  return { machines, minutesByBot };
}

export interface ReconcileResult {
  checked: string[];
  drift: string[];
  skipped: 'no_bill' | 'not_yet' | 'waiting' | null;
  failed: boolean;
}

/**
 * Checks every day that is due, once each (a day already written is never written again; two runs at once write it once). Asked by the sweep.
 * A bill that cannot be read is tried again later and never stops the sweep, never writes a day it did not read.
 */
export async function reconcileComputers(now: Date = new Date(), provider: ComputerProvider | null = getComputerProvider()): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: [], drift: [], skipped: null, failed: false };
  if (!provider || !provider.dayUsage) return { ...result, skipped: 'no_bill' };
  const newest = await prisma.computerReconcile.findFirst({ orderBy: { day: 'desc' }, select: { day: true } });
  const days = daysToCheck(now, newest?.day ?? null);
  if (days.length === 0) return { ...result, skipped: 'not_yet' };
  const tried = await prisma.appSetting.findUnique({ where: { key: TRIED_KEY } });
  const last = typeof tried?.value === 'string' ? Date.parse(tried.value) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < RETRY_AFTER_MS && now.getTime() >= last) return { ...result, skipped: 'waiting' };
  for (const day of days) {
    let bill: ProviderDay;
    try {
      bill = await provider.dayUsage(day);
    } catch (error) {
      await prisma.appSetting.upsert({ where: { key: TRIED_KEY }, create: { key: TRIED_KEY, value: now.toISOString() }, update: { value: now.toISOString() } });
      console.error('[Computer] The provider’s bill for', day, 'could not be read:', error instanceof Error ? error.message : 'unknown');
      return { ...result, failed: true };
    }
    const compared = compareDay(bill, await booksFor(day, now), provider.microsPerMinute());
    const status = compared.findings.length === 0 ? 'ok' : 'drift';
    try {
      await prisma.computerReconcile.create({
        data: {
          day,
          agentTotalMicros: BigInt(bill.totalMicros),
          agentBrickMicros: BigInt(compared.agentBrickMicros),
          ourMinutes: compared.ourMinutes,
          agentMinutes: compared.agentMinutes,
          status,
          gapMicros: BigInt(compared.gapMicros),
          findings: compared.findings as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Another run wrote this day first: it stands, and this one writes nothing and says nothing twice
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
    result.checked.push(day);
    if (status === 'drift') {
      result.drift.push(day);
      const kinds = [...new Set(compared.findings.map((finding) => finding.kind))].join(', ');
      console.error(`[Computer] The books and the provider's bill for ${day} do not match (${kinds}); see computer_reconciles`);
      Sentry.captureMessage(`Computer books do not match the provider's bill for ${day}`, { level: 'warning', tags: { area: 'computer', kinds }, extra: { day, gapMicros: compared.gapMicros, findings: compared.findings } });
    }
  }
  return result;
}

/** What the team's readiness page says about the check: the newest day, and whether it matched. Reads only. */
export async function reconcileCheck(): Promise<{ name: string; ok: boolean; detail: string } | null> {
  const newest = await prisma.computerReconcile.findFirst({ orderBy: { day: 'desc' } });
  if (!newest) return { name: 'books and bill', ok: true, detail: 'The books have not been compared with the provider’s bill yet (the first check is made the day after a computer first runs)' };
  const dollars = (micros: bigint) => `$${(Number(micros) / 1_000_000).toFixed(2)}`;
  if (newest.status === 'ok') return { name: 'books and bill', ok: true, detail: `On ${newest.day} our books and the provider’s bill matched (it billed ${dollars(newest.agentTotalMicros)} in all)` };
  const kinds = [...new Set(((newest.findings as unknown as Finding[]) ?? []).map((finding) => finding.kind))].join(', ');
  return { name: 'books and bill', ok: false, detail: `On ${newest.day} our books and the provider’s bill did not match (${kinds}; ${dollars(newest.gapMicros)} not explained)` };
}
