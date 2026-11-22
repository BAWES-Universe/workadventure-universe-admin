import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ownersJob } from '@/lib/computer-job-access';
import { getBrickLimits } from '@/lib/bot-limits';
import { cleanStepLabel } from '@/lib/computer-redact';
import type { EpochSaid } from '@/lib/computer-owner';

/**
 * Activity (computers full plan, piece 2): the list of steps a computer job has done so far, beside Watch and Files. Today the bar shows only the
 * step in hand; this keeps each step the runner reports, in order, so the person (and Brick, when asked "how is it going?") can look back over it.
 *
 * A step is the label the runner reports with its progress, cleaned by the same rule as the bar's (never a secret, never markup). A report that
 * repeats the step in hand adds nothing, so a runner that reports the same step every few seconds leaves one line. Only the job's OWNER adds a
 * step: the row is written only while the job's owner epoch is the one the runner names (the same rule as the progress write it follows), so a
 * worker that was replaced never adds a line to its successor's list. How many steps are kept per job is a Limits value (`bricks.computerSteps`):
 * the newest are kept and older ones drop off. A job's steps go when the job is deleted (cascade), never before; an ended job keeps its list.
 */

export interface JobStep {
  seq: number;
  label: string;
  at: Date;
}

type Db = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * Adds the step the job's runner just reported, when it is a new one: the cleaned label is not empty and differs from the job's latest step. Written
 * in ONE statement, conditional on the job still being on (running or waiting) and on its owner epoch being the one the runner names (none = a worker
 * that knows none: only while the job has none). Two reports at the same moment cannot both take a number: the second meets the unique (job, seq)
 * and adds nothing. Then steps older than the kept count drop off. Answers whether a step was added. Never throws: Activity must never fail a progress
 * report, so a failure is logged and answered as nothing added.
 */
export async function appendStep(jobId: string, label: string | null | undefined, owner: { epoch?: EpochSaid } = {}, now: Date = new Date(), db: Db = prisma): Promise<boolean> {
  const cleaned = cleanStepLabel(label ?? null);
  if (!cleaned) return false;
  const epoch = owner.epoch ?? 0;
  try {
    const added = await db.$executeRaw`
      INSERT INTO "computer_job_steps" ("id", "job_id", "seq", "label", "at")
      SELECT ${randomUUID()}, j."id", COALESCE((SELECT MAX(s."seq") FROM "computer_job_steps" s WHERE s."job_id" = j."id"), 0) + 1, ${cleaned}, ${now}
      FROM "computer_jobs" j
      WHERE j."id" = ${jobId}
        AND j."status" IN ('running', 'waiting')
        AND j."owner_epoch" = ${epoch}
        AND ${cleaned} IS DISTINCT FROM (SELECT s."label" FROM "computer_job_steps" s WHERE s."job_id" = j."id" ORDER BY s."seq" DESC LIMIT 1)
      ON CONFLICT ("job_id", "seq") DO NOTHING`;
    if (added !== 1) return false;
    const { computerSteps } = await getBrickLimits();
    await db.$executeRaw`
      DELETE FROM "computer_job_steps"
      WHERE "job_id" = ${jobId}
        AND "seq" <= (SELECT MAX("seq") FROM "computer_job_steps" WHERE "job_id" = ${jobId}) - ${computerSteps}`;
    return true;
  } catch (error) {
    console.error('[Computer] Could not add a step to Activity:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/** The steps of one job, oldest first. Labels are read back through the same cleaning rule they were written with. */
export async function stepsOf(jobId: string): Promise<JobStep[]> {
  const rows = await prisma.computerJobStep.findMany({ where: { jobId }, orderBy: { seq: 'asc' }, select: { seq: true, label: true, at: true } });
  return rows.map((row) => ({ seq: row.seq, label: cleanStepLabel(row.label) ?? '', at: row.at })).filter((step) => step.label !== '');
}

export type Activity = { ok: true; job: { id: string; title: string; status: string }; steps: JobStep[] } | { ok: false; reason: 'not_found' };

/**
 * A job's Activity for its Brick's owner: the job (id, title, status) and its steps, oldest first. Only the Brick's owner, and only a job of that Brick:
 * a job id alone is never enough. Read only.
 */
export async function jobActivity(botId: string, ownerId: string, jobId: string): Promise<Activity> {
  const job = await ownersJob(botId, ownerId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  return { ok: true, job: { id: job.id, title: job.title, status: job.status }, steps: await stepsOf(job.id) };
}
