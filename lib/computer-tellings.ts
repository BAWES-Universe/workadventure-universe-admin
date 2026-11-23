import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * What Brick tells the person about a job that their month of computer time, or a spending limit they set, paused (piece 3 of the computer job controls), kept as rows
 * (computer_job_tellings) written in the SAME transaction as the change they are about, and said once each under their own key, the way a report back is:
 *  - `paused`: "I paused “<title>”: this month's computer time is used up…" (why `allowance`) or "…it reached the spending limit you set…" (why `rule`). Once per pause.
 *  - `carried_on`: "I'm carrying on with “<title>”." Once, when it carries on by itself.
 *  - `can_carry_on`: "“<title>” can carry on now. Want me to?" Once per pause, when more time arrived but something about the job changed while it waited, so it does not carry on by itself.
 * The person's own Pause, Resume, Cancel and Stop are never told back to them (they just did it). Orbit never speaks in a chat: the bot server reads these with the reports
 * (it must say it understands the kinds) and says each one; no number and no price is ever in them.
 */

export const TELLING_KINDS = ['paused', 'carried_on', 'can_carry_on'] as const;
export type TellingKind = (typeof TELLING_KINDS)[number];

/** Writes one thing to tell, in the caller's transaction (which holds the job's row lock: the sequence is read and written under it). */
export async function tellIn(tx: Prisma.TransactionClient, jobId: string, kind: TellingKind, why: 'allowance' | 'rule' | null, now: Date, extra: { /** The pause took the screen back from the person */ heldScreen?: boolean } = {}): Promise<number> {
  const last = await tx.computerJobTelling.aggregate({ where: { jobId }, _max: { seq: true } });
  const seq = (last._max.seq ?? 0) + 1;
  await tx.computerJobTelling.create({ data: { jobId, seq, kind, why, heldScreen: !!extra.heldScreen, createdAt: now } });
  return seq;
}

/**
 * A digest of the Apps the Brick has now and what it may do with each (never the Apps, their keys or their settings themselves): a job the month or a limit paused carries on by
 * itself only while this is the same as at its pause. An App added, taken away, switched off, connected to another account or set to do more or less makes it different.
 */
export async function grantsPrintIn(db: Pick<Prisma.TransactionClient, 'botMcpServer'>, botId: string): Promise<string> {
  const rows = await db.botMcpServer.findMany({
    where: { botId, enabled: true },
    select: { id: true, connectionId: true, lookUpSetting: true, makeSetting: true, changeSetting: true, deleteSendSetting: true },
  });
  const lines = rows.map((row) => [row.id, row.connectionId ?? '', row.lookUpSetting, row.makeSetting, row.changeSetting, row.deleteSendSetting].join('|')).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** One thing for Brick to say about a paused job, as the reports list carries it. */
export interface Telling {
  jobId: string;
  seq: number;
  kind: TellingKind;
  why: 'allowance' | 'rule' | null;
  /** The pause took the screen back from the person: Brick says the held-screen line in place of the usual one */
  heldScreen: boolean;
  createdAt: Date;
}

/**
 * The things still to tell, oldest first. One that is no longer true by now is marked stale and never offered: a `paused` or `can_carry_on` for a job that is no longer paused
 * by its month or a limit (it carried on, the person resumed or cancelled it, it ended), and anything about a job that ended (its ending is told instead), or that a newer telling
 * of the same job replaced. Nothing is said about a job of a Brick that was deleted.
 */
export async function tellingsToTell(limit: number, now: Date): Promise<Telling[]> {
  const open = await prisma.computerJobTelling.findMany({
    where: { toldAt: null, undeliverableAt: null, staleAt: null, job: { bot: { deletedAt: null } } },
    orderBy: [{ createdAt: 'asc' }, { jobId: 'asc' }, { seq: 'asc' }],
    take: Math.max(1, Math.min(limit, 200)),
    include: { job: { select: { status: true, queuedFor: true, pausedWhy: true, pausedAt: true } } },
  });
  const out: Telling[] = [];
  for (const one of open) {
    const newer = await prisma.computerJobTelling.count({ where: { jobId: one.jobId, seq: { gt: one.seq } } });
    const job = one.job;
    const ended = job.status === 'done' || job.status === 'stopped' || job.status === 'failed';
    const limitPaused = job.status === 'queued' && job.queuedFor === 'paused' && (job.pausedWhy === 'allowance' || job.pausedWhy === 'rule');
    const stillTrue = !ended && newer === 0 && (one.kind === 'carried_on' ? !limitPaused : limitPaused && !!job.pausedAt && job.pausedAt.getTime() <= one.createdAt.getTime());
    if (!stillTrue) {
      await prisma.computerJobTelling.updateMany({ where: { id: one.id, toldAt: null, undeliverableAt: null, staleAt: null }, data: { staleAt: now } });
      continue;
    }
    out.push({ jobId: one.jobId, seq: one.seq, kind: one.kind as TellingKind, why: one.why === 'allowance' || one.why === 'rule' ? one.why : null, heldScreen: one.heldScreen, createdAt: one.createdAt });
  }
  return out;
}

/** The bot server says what became of one: said (`delivered`) or never to be said (it cannot reach the person). Either way it is not offered again. False when there is no such telling. */
export async function keepTellingTold(jobId: string, seq: number, delivered: boolean, now: Date = new Date()): Promise<boolean> {
  const done = await prisma.computerJobTelling.updateMany({ where: { jobId, seq, toldAt: null, undeliverableAt: null }, data: delivered ? { toldAt: now } : { undeliverableAt: now } });
  if (done.count > 0) return true;
  return (await prisma.computerJobTelling.count({ where: { jobId, seq } })) > 0;
}
