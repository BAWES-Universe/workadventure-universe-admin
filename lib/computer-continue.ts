import { prisma } from '@/lib/db';
import { continuableEnding, isOver } from '@/lib/computer-values';

/**
 * "Try again" carries on (piece 8 of the computer controls). After a job that failed (ours or the agent's own) or that we ended (`continuableEnding`), the person's "try again" is a NEW job that carries
 * on in the old job's agent conversation, so the agent knows what it already did. It is a new job in every other way: its own reservation, its own receipt, its own start key and
 * attempt, its own runner claim and keys. Only the conversation (`agent_session_id`) and the link (`continues_job_id`) come from the old job. One continuation per old job, ever (a unique
 * index): asking again finds the job the first ask made. After the person's own Stop or Cancel, a computer turned off or deleted, or a job that finished, the
 * ask makes NOTHING (GPT round 6, finding 6): the start answers `cannot_continue` with why, and Brick offers "Start a new job" as a separate choice (an ordinary start, under a new key, with no
 * continuation header). A "try again" never authorizes unrelated fresh paid work. The game asks for a continuation only for words like "try again" (bots/ai/ComputerTryAgain.ts); Orbit decides here, on every ask, from its own record.
 *
 * Nothing here imports lib/computer (the start imports this file).
 */

/** Why an ask to carry on a job cannot carry it on: the job is not there, is another Brick's or person's, is still going on, ended in a way that does not carry on, or has no conversation to carry on. */
export type FreshBecause = 'not_found' | 'not_theirs' | 'live' | 'not_continuable' | 'no_conversation';

/** The job an ask named, as Brick needs it to say why it cannot carry on (its title, and how it stands or ended). Only ever the asker's own job on this Brick: never for `not_found` / `not_theirs`. */
export interface NamedJob {
  title: string;
  status: string;
  endedBy: string | null;
}

/** What a start that asks to carry on a job gets: the link and the conversation for the new job, the job that already carries it on, or why it cannot (the start then makes nothing). */
export type CarryOn = { link: { continuesJobId: string; agentSessionId: string } } | { existing: { id: string } } | { fresh: FreshBecause; job?: NamedJob };

type Db = Pick<typeof prisma, 'computerJob'>;

/** Decides, from Orbit's record, what a start of `personId` on `botId` that asks to carry on `fromJobId` makes. Reads only. */
export async function carryOnFrom(botId: string, personId: string, fromJobId: string, db: Db = prisma): Promise<CarryOn> {
  const old = await db.computerJob.findUnique({
    where: { id: fromJobId },
    select: { id: true, botId: true, personId: true, title: true, status: true, endedBy: true, agentSessionId: true, continuedBy: { select: { id: true } } },
  });
  if (!old) return { fresh: 'not_found' };
  // Another Brick's job, or another person's, is never carried on (and never said to exist)
  if (old.botId !== botId || old.personId !== personId) return { fresh: 'not_theirs' };
  // A job that is still going on is never carried on: it is in line, working or waiting for its person
  const job: NamedJob = { title: old.title, status: old.status, endedBy: old.endedBy };
  if (!isOver(old.status)) return { fresh: 'live', job };
  // One continuation per job, ever: the one that was made is the answer, whatever it came to
  if (old.continuedBy) return { existing: { id: old.continuedBy.id } };
  if (!continuableEnding(old.status, old.endedBy)) return { fresh: 'not_continuable', job };
  // A job that never reached its agent has no conversation to carry on
  if (!old.agentSessionId) return { fresh: 'no_conversation', job };
  return { link: { continuesJobId: old.id, agentSessionId: old.agentSessionId } };
}

/** The job "try again" would carry on now, as the game asks before it starts one. */
export interface RetryCandidate {
  id: string;
  title: string;
  /** How it ended, in Orbit's words (`error`, `pool`, `unanswered`, `allowance`, `rule`), or `agent` for a failure the agent itself gave. */
  how: string;
  endedAt: Date | null;
  /** When Brick told the person how it ended (the report back), or null while it has not. */
  toldAt: Date | null;
}

/**
 * The job of this person on this Brick that "try again" would carry on: their LATEST job that is over, only when it ended in a way that carries on, has a conversation and was not
 * carried on yet. A newer job that finished (or any newer ending that is a fresh job) means there is none: the person moved on. Reads only, never wakes anything.
 */
export async function retryCandidate(botId: string, personId: string, db: Db = prisma): Promise<RetryCandidate | null> {
  const latest = await db.computerJob.findFirst({
    where: { botId, personId, status: { in: ['done', 'failed', 'stopped'] } },
    orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, title: true, status: true, endedBy: true, endedAt: true, endToldAt: true, agentSessionId: true, continuedBy: { select: { id: true } } },
  });
  if (!latest || latest.continuedBy || !latest.agentSessionId || !continuableEnding(latest.status, latest.endedBy)) return null;
  return { id: latest.id, title: latest.title, how: latest.endedBy ?? 'agent', endedAt: latest.endedAt, toldAt: latest.endToldAt };
}

/** One of the person's ended jobs, as the game lists them to ask "Which job?" (round 8, E). `continuable`: "try again" would carry it on (the same test as `carryOnFrom`). */
export interface EndedJob {
  id: string;
  title: string;
  how: string;
  endedAt: Date | null;
  continuable: boolean;
}

/** The most ended jobs one look lists. */
export const ENDED_MAX = 5;

/** The person's ended jobs on this Brick, NEWEST ENDED first (the order `retryCandidate` reads; a contract with the game, GPT eighth note E2), at most `ENDED_MAX`. Every job carries `endedAt` (an ISO 8601 UTC string in the answer; null only for an old row with no end time, which sorts last). Reads only. */
export async function endedJobs(botId: string, personId: string, count: number, db: Db = prisma): Promise<EndedJob[]> {
  const take = Math.max(1, Math.min(ENDED_MAX, Math.floor(count)));
  const rows = await db.computerJob.findMany({
    where: { botId, personId, status: { in: ['done', 'failed', 'stopped'] } },
    orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: { id: true, title: true, status: true, endedBy: true, endedAt: true, agentSessionId: true, continuedBy: { select: { id: true } } },
  });
  return rows.map((row) => ({ id: row.id, title: row.title, how: row.endedBy ?? 'agent', endedAt: row.endedAt, continuable: !row.continuedBy && !!row.agentSessionId && continuableEnding(row.status, row.endedBy) }));
}

/**
 * The jobs a job carries on from, nearest first (its old job, that one's old job, and so on), by id. Their turns are in the same agent conversation, so the machine's model address may
 * find their tag in a call (it reads the FIRST tagged message of the conversation): the prepare of a continuation writes this job's key under their ids too, so every call of the
 * conversation goes with THIS job's key (lib/computer-broker). A link that loops is followed once.
 */
export async function carriedOnFrom(jobId: string, db: Db = prisma): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>([jobId]);
  let at = (await db.computerJob.findUnique({ where: { id: jobId }, select: { continuesJobId: true } }))?.continuesJobId ?? null;
  while (at && !seen.has(at)) {
    seen.add(at);
    chain.push(at);
    at = (await db.computerJob.findUnique({ where: { id: at }, select: { continuesJobId: true } }))?.continuesJobId ?? null;
  }
  return chain;
}
