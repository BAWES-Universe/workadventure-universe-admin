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

/** One line of Activity. `key` is stable across reads (`step:<n>`, `note:<n>`, `pause:<n>`, `resume:<n>`, `paused:now`); `seq` is the line's place in this answer. */
export interface ActivityItem {
  key: string;
  seq: number;
  kind: 'step' | 'note' | 'pause' | 'resume';
  label: string;
  detail: string | null;
  at: Date;
}

export type Activity = { ok: true; job: { id: string; title: string; status: string }; steps: ActivityItem[] } | { ok: false; reason: 'not_found' };

/** The words of a pause line, by who or what paused it (decisions 23 Nov, section 2). Never a number or a price. */
const PAUSED_WORDS: Record<string, string> = {
  person: 'Paused by you',
  allowance: "Paused: this month's computer time is used up",
  rule: 'Paused: it reached the spending limit you set',
};
const pausedWords = (why: string | null | undefined): string => PAUSED_WORDS[why ?? 'person'] ?? PAUSED_WORDS.person;
const ORDER: Record<ActivityItem['kind'], number> = { pause: 0, resume: 1, note: 2, step: 3 };

/**
 * A job's Activity for its Brick's owner (the approved mock, picture 22): what it has done so far, oldest first, with the person's own notes to it and its
 * pauses between the steps. `steps` holds every line: `kind` says which (step, note, pause, resume). Notes are the person's own words, shown to them alone.
 * Only the Brick's owner, and only a job of that Brick: a job id alone is never enough. Read only.
 */
export async function jobActivity(botId: string, ownerId: string, jobId: string): Promise<Activity> {
  const job = await ownersJob(botId, ownerId, jobId);
  if (!job) return { ok: false, reason: 'not_found' };
  const [steps, notes, pauses, now] = await Promise.all([
    stepsOf(job.id),
    prisma.computerJobNote.findMany({ where: { jobId }, orderBy: { seq: 'asc' }, select: { seq: true, text: true, createdAt: true } }),
    prisma.computerJobPause.findMany({ where: { jobId }, orderBy: { n: 'asc' }, select: { n: true, why: true, at: true } }),
    prisma.computerJob.findUnique({ where: { id: jobId }, select: { queuedFor: true, pausedAt: true, pausedWhy: true } }),
  ]);
  const lines: Omit<ActivityItem, 'seq'>[] = [
    ...steps.map((step) => ({ key: `step:${step.seq}`, kind: 'step' as const, label: step.label, detail: null, at: step.at })),
    ...notes.map((note) => ({ key: `note:${note.seq}`, kind: 'note' as const, label: note.text, detail: null, at: note.createdAt })),
    // A job sent back in line because its machine was found asleep under it (post-0.5.0 B) shows no pause line: nobody paused it, it carries on by itself, and that has no words of its own yet
    ...pauses.filter((pause) => pause.why !== 'machine').map((pause) => ({ key: `pause:${pause.n}`, kind: 'pause' as const, label: pausedWords(pause.why), detail: null, at: pause.at })),
  ];
  // A job paused while it was only in line has no pause row (nothing ran): its pause is the job's own mark, while it lasts
  if (now?.queuedFor === 'paused' && now.pausedAt && !pauses.some((pause) => pause.at.getTime() === now.pausedAt!.getTime())) {
    lines.push({ key: 'paused:now', kind: 'pause', label: pausedWords(now.pausedWhy), detail: null, at: now.pausedAt });
  }
  lines.sort((a, b) => a.at.getTime() - b.at.getTime() || ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key));
  return { ok: true, job: { id: job.id, title: job.title, status: job.status }, steps: lines.map((line, index) => ({ ...line, seq: index + 1 })) };
}
