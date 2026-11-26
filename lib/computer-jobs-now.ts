import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { cleanStepLabel } from '@/lib/computer-redact';
import { cleanEndNote, fileNameOf, filesMadeBy } from '@/lib/computer-report';
import { handedPathsOf } from '@/lib/computer-file-cards';

/**
 * What a Brick is told, with every message of its owner, about the jobs on its own computer (the Brick chat audit, 26 Nov, findings 3 and 4): the jobs that are working, waiting for
 * the person or in line now, and the few that ended lately with how they ended and what they left. Read fresh from Orbit's own record, never from the chat: a Brick that only saw
 * the jobs still going said "there was no job" about one that had finished, and spoke of a second job that was never started.
 *
 * What it says is only what the record proves: the state, the step the runner reported (cleaned as the page shows it), the files the job handed over or that appeared while it ran
 * (names only), and for a job that could not go on the one sentence it gave, cleaned of links and markup. No id, no price, no machine. Reads only: it never makes or wakes anything.
 */

/** The most ended jobs told, newest first. */
export const JOBS_NOW_ENDED_MAX = 3;
/** Ended jobs older than this are not told: the person moved on. */
export const JOBS_NOW_ENDED_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
/** The most file names told for one ended job. */
export const JOBS_NOW_FILES_MAX = 5;

export interface LiveJobNow {
  title: string;
  /** running: it has the computer now. waiting: it waits for the person (`waitingFor`). queued: it has not started, or it is paused (`queuedFor`). */
  status: 'running' | 'waiting' | 'queued';
  queuedFor: string | null;
  waitingFor: string | null;
  /** Who has the mouse and keyboard: the Brick, or the person who took over. */
  control: 'brick' | 'person';
  stepDone: number;
  stepTotal: number | null;
  stepLabel: string | null;
  askedAt: Date;
  startedAt: Date | null;
}

export interface EndedJobNow {
  title: string;
  status: 'done' | 'failed' | 'stopped';
  /** Why it stopped, in Orbit's words (person, allowance, pool, off, deleted, error, unanswered, rule), or null (a job that finished, or a failure the computer gave). */
  endedBy: string | null;
  endedAt: Date | null;
  /** The files it handed over and the ones that appeared while it ran, by name only. */
  files: string[];
  /** For a job that could not go on: the one sentence it gave, cleaned. Null otherwise. */
  why: string | null;
}

export interface JobsNow {
  live: LiveJobNow[];
  ended: EndedJobNow[];
}

const LIVE = ['running', 'waiting', 'queued'];

/** The jobs of `personId` on `botId` now: the live ones in the order the line takes them, then the latest few that ended (within a week), newest first. */
export async function jobsNow(botId: string, personId: string, now: Date = new Date()): Promise<JobsNow> {
  // Both lists from one snapshot: a job that ends between two reads must not show as both working and finished
  const [liveRows, endedRows] = await prisma.$transaction(
    [
      prisma.computerJob.findMany({
        where: { botId, personId, status: { in: LIVE } },
        orderBy: [{ queueRank: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { title: true, status: true, queuedFor: true, waitingFor: true, control: true, stepDone: true, stepTotal: true, stepLabel: true, createdAt: true, startedAt: true },
      }),
      prisma.computerJob.findMany({
        where: { botId, personId, status: { in: ['done', 'failed', 'stopped'] }, endedAt: { gte: new Date(now.getTime() - JOBS_NOW_ENDED_WITHIN_MS) } },
        orderBy: [{ endedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: JOBS_NOW_ENDED_MAX,
        select: { id: true, title: true, status: true, endedBy: true, endedAt: true, endNote: true, writes: true, endFiles: true, startFiles: true },
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  // A job that holds the computer comes first, as the bar shows it
  const holding = (status: string) => (status === 'running' || status === 'waiting' ? 0 : 1);
  const live: LiveJobNow[] = liveRows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => holding(a.row.status) - holding(b.row.status) || a.at - b.at)
    .map(({ row }) => ({
      title: row.title,
      status: row.status as LiveJobNow['status'],
      queuedFor: row.status === 'queued' ? row.queuedFor : null,
      waitingFor: row.status === 'waiting' ? row.waitingFor : null,
      control: row.control === 'person' ? 'person' : 'brick',
      stepDone: row.stepDone,
      stepTotal: row.stepTotal,
      stepLabel: cleanStepLabel(row.stepLabel),
      askedAt: row.createdAt,
      startedAt: row.startedAt,
    }));
  const handedRows =
    endedRows.length === 0
      ? []
      : await prisma.computerJobFile.findMany({ where: { jobId: { in: endedRows.map((row) => row.id) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { jobId: true, name: true } });
  const handedPaths = await handedPathsOf(endedRows.map((row) => row.id));
  const ended: EndedJobNow[] = endedRows.map((row) => {
    const files: string[] = [];
    for (const one of handedRows) {
      if (one.jobId !== row.id) continue;
      const name = fileNameOf(one.name);
      if (name && !files.includes(name)) files.push(name);
    }
    if (row.status === 'done' && row.writes) {
      for (const name of filesMadeBy(row.endFiles, row.startFiles, new Set(handedPaths.get(row.id) ?? []))) if (!files.includes(name)) files.push(name);
    }
    return {
      title: row.title,
      status: row.status as EndedJobNow['status'],
      endedBy: row.endedBy,
      endedAt: row.endedAt,
      files: files.slice(0, JOBS_NOW_FILES_MAX),
      // Only a job that could not go on gives a reason; the person's own Stop needs none
      why: row.status === 'done' || row.endedBy === 'person' || row.endedBy === 'off' || row.endedBy === 'deleted' ? null : cleanEndNote(row.endNote),
    };
  });
  return { live, ended };
}
