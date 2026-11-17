import { prisma } from '@/lib/db';
import { readFilesList } from '@/lib/computer-files';
import { silentEnding, type WaitingFor } from '@/lib/computer-values';

/**
 * Brick tells the person how a computer job went (the report back), in their own chat with it. Orbit never speaks in a chat: the bot server asks
 * this list now and then, says each item once under its own transaction id, and tells Orbit it was said. What is here is only what the
 * database proves about the job:
 *  - what reached a site, from the job's own effect rows (written before each try, and settled with where it went), never the computer's words;
 *  - the files that appeared on the computer while the job ran, from the list taken when it ended;
 *  - whether the try was given back, from the meter's books (the minutes written against nobody), never assumed;
 *  - the one sentence the computer gave for why it could not go on, cleaned, kept apart from the facts and only on a failure.
 * Nothing here says "done" on the computer's word alone beyond the ending the runner reported, and nothing says a thing was NOT sent unless
 * no effect of that kind is on record.
 */

export type ReportKind = 'done' | 'failed' | 'needs' | 'unanswered' | 'month' | 'rule';

export interface ReportEffect {
  kind: string;
  /** done: it reached the place. planned: it was tried and the outcome is not known. */
  state: 'done' | 'unknown';
  /** Where it went, as the computer named it; empty when it named nothing. */
  where: string | null;
}

export interface Report {
  /** Stays the same for one thing to say, so a retry says it once: the bot server uses it as the message's transaction id. */
  key: string;
  jobId: string;
  botId: string;
  /** The person's chat id on the Matrix server; null when they have no chat to be told in. */
  matrixUserId: string | null;
  kind: ReportKind;
  title: string;
  writes: boolean;
  /** How long the machine was held for the job. */
  seconds: number;
  /** The wait this is about, for `needs` (goes up with each wait); null for an ending. */
  seq: number | null;
  /** `needs`: what it waits for and, for details, what it is ready to put in and where. */
  waitingFor: WaitingFor | null;
  ready: { what: string; where: string } | null;
  /** `unanswered`: what it was waiting for. */
  waitedFor: WaitingFor | null;
  /** `failed` and `rule`: one cleaned sentence about why. */
  why: string | null;
  effects: ReportEffect[];
  /** `done`: files that appeared while the job ran, newest first. */
  files: string[];
  /** The minutes of this try do not count against the person's month (proved in the books, or none were used). */
  givenBack: boolean;
}

/** How long an ending that never finished its own work (its server stopped halfway) waits before it is told as it stands. Its own work takes well under a minute. */
const UNFINISHED_ENDING_MS = 5 * 60 * 1000;
const WHY_MAX = 160;
const WHERE_MAX = 120;
const FILE_NAME_MAX = 80;
const FILES_SHOWN_MAX = 12;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** A long unbroken run of letters and digits with both: what keys and tokens look like, not words. */
const TOKEN_LIKE = /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}/g;

/**
 * What the computer said about why it stopped, or a rule's words, made safe to put in Brick's mouth: no links or markup (a page could make the
 * agent write one), no markers, no key-like strings, one line, short. Null when nothing is left.
 */
export function cleanEndNote(text: string | null | undefined, max: number = WHY_MAX): string | null {
  if (!text) return null;
  const cleaned = text
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(TOKEN_LIKE, ' ')
    .replace(/[`*_#>|~]/g, ' ')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  if (cleaned.length < 3) return null;
  // Cut between whole characters, never through an emoji
  const letters = Array.from(cleaned);
  return letters.length > max ? `${letters.slice(0, max - 1).join('').trimEnd()}…` : cleaned;
}

const DETAILS_SEPARATOR = '\u001f';

/** Where an effect went, as one short clean phrase. For details the evidence is "what, separator, where": only where is said. */
function whereOf(kind: string, evidence: string | null): string | null {
  if (!evidence) return null;
  const raw = kind === 'details' ? (evidence.split(DETAILS_SEPARATOR)[1] ?? '') : evidence;
  return cleanEndNote(raw, WHERE_MAX);
}

/** The ending a job's endedBy says, or null for one that is never told. */
export function kindOfEnding(status: string, endedBy: string | null): ReportKind | null {
  if (silentEnding(endedBy)) return null;
  if (status === 'done') return 'done';
  if (endedBy === 'allowance') return 'month';
  if (endedBy === 'unanswered') return 'unanswered';
  if (endedBy === 'rule') return 'rule';
  // The machine would not start, a turn broke, the shared room ran out, or the computer said it could not go on
  if (status === 'failed' || endedBy === 'error' || endedBy === 'pool') return 'failed';
  return null;
}

type JobWithEffects = {
  id: string;
  botId: string;
  personId: string;
  title: string;
  status: string;
  endedBy: string | null;
  writes: boolean;
  secondsRun: number;
  startedAt: Date | null;
  endedAt: Date | null;
  waitingFor: string | null;
  readyWhat: string | null;
  readyWhere: string | null;
  handoverSeq: number;
  endNote: string | null;
  endWaitingFor: string | null;
  effects: { effectKey: string; kind: string; state: string; evidence: string | null }[];
};

/** What reached a site or might have: the rows that were done, and the ones tried whose outcome is not known. Rows nobody tried are nothing. */
function effectsOf(job: JobWithEffects): ReportEffect[] {
  const out: ReportEffect[] = [];
  for (const effect of job.effects) {
    if (effect.state === 'done') out.push({ kind: effect.kind, state: 'done', where: whereOf(effect.kind, effect.evidence) });
    else if (effect.state === 'planned') out.push({ kind: effect.kind, state: 'unknown', where: whereOf(effect.kind, effect.evidence) });
  }
  return out;
}

/** Files that appeared while the job ran, from the list taken when a job ended: no hidden folder and no file older than the job. */
export function filesMadeBy(list: unknown, startedAt: Date | null): string[] {
  const files = readFilesList(list);
  if (!files || !startedAt) return [];
  const since = startedAt.getTime() - 60_000;
  const names: string[] = [];
  for (const entry of files.items) {
    if (new Date(entry.modifiedAt).getTime() < since) continue;
    const parts = entry.path.split('/');
    if (parts.some((part) => part.startsWith('.'))) continue;
    const name = cleanEndNote(parts[parts.length - 1], FILE_NAME_MAX);
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= FILES_SHOWN_MAX) break;
  }
  return names;
}

/**
 * Whether the minutes of this try stay off the person's month, from the books: the job's computer-time event is written against nobody and marked as
 * given back, or no minutes were counted at all. A try whose time still counts for the person is never said to be given back.
 */
async function givenBackIn(jobId: string, seconds: number): Promise<boolean> {
  const event = await prisma.meterEvent.findUnique({ where: { eventId: `computer:${jobId}:time` }, select: { personId: true, detail: true } });
  if (!event) return seconds === 0;
  const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail) ? (event.detail as Record<string, unknown>) : {};
  return event.personId === null && detail.givenBack === true;
}

// In the order they were planned, so what is said reads in the order it happened
const EFFECTS = { select: { effectKey: true, kind: true, state: true, evidence: true }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] };

/**
 * What Brick is to tell now, oldest first: endings not told yet, then waits for the person not told yet. A job whose person has no chat is still
 * listed (with no chat id) so the bot server can say it cannot and Orbit stops offering it.
 */
export async function reportsToTell(limit = 50, now: Date = new Date()): Promise<Report[]> {
  const size = Math.max(1, Math.min(limit, 200));
  // An ending is told once everything it does is finished; one a server left half done is told anyway after a while, never held for ever
  const unfinishedBefore = new Date(now.getTime() - UNFINISHED_ENDING_MS);
  const ended = await prisma.computerJob.findMany({
    where: {
      status: { in: ['done', 'stopped', 'failed'] },
      endToldAt: null,
      startedAt: { not: null },
      bot: { deletedAt: null },
      AND: [{ OR: [{ endedBy: null }, { endedBy: { notIn: ['person', 'off', 'deleted'] } }] }, { OR: [{ endClosedAt: { not: null } }, { endedAt: { lte: unfinishedBefore } }] }],
    },
    orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
    take: size,
    include: { effects: EFFECTS },
  });
  const waiting = await prisma.computerJob.findMany({
    // Only while it is Brick's to say: a person who already took over does not need to be told to
    where: { status: 'waiting', control: 'brick', waitingFor: { not: null }, handoverUntold: true, bot: { deletedAt: null } },
    orderBy: [{ stretchStarted: 'asc' }, { id: 'asc' }],
    take: size,
    include: { effects: EFFECTS },
  });
  const jobs = [...ended, ...waiting];
  if (jobs.length === 0) return [];
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(jobs.map((job) => job.personId))] } }, select: { id: true, matrixChatId: true } });
  const chatOf = new Map(people.map((person) => [person.id, person.matrixChatId ?? null]));
  const computers = await prisma.brickComputer.findMany({ where: { botId: { in: [...new Set(ended.map((job) => job.botId))] } }, select: { botId: true, filesList: true } });
  const filesOf = new Map(computers.map((row) => [row.botId, row.filesList]));

  const reports: Report[] = [];
  for (const job of ended) {
    const kind = kindOfEnding(job.status, job.endedBy);
    // An ending that is never told is marked as told, so it is not offered again
    if (!kind) {
      await prisma.computerJob.updateMany({ where: { id: job.id, endToldAt: null }, data: { endToldAt: new Date() } });
      continue;
    }
    reports.push({
      key: `computer-told:${job.id}:${kind}`,
      jobId: job.id,
      botId: job.botId,
      matrixUserId: chatOf.get(job.personId) ?? null,
      kind,
      title: job.title,
      writes: job.writes,
      seconds: job.secondsRun,
      seq: null,
      waitingFor: null,
      ready: null,
      waitedFor: kind === 'unanswered' ? (job.endWaitingFor as WaitingFor | null) : null,
      why: kind === 'failed' || kind === 'rule' ? job.endNote : null,
      effects: effectsOf(job),
      files: kind === 'done' ? filesMadeBy(filesOf.get(job.botId), job.startedAt) : [],
      givenBack: kind === 'failed' ? await givenBackIn(job.id, job.secondsRun) : false,
    });
  }
  for (const job of waiting) {
    reports.push({
      key: `computer-told:${job.id}:needs:${job.handoverSeq}`,
      jobId: job.id,
      botId: job.botId,
      matrixUserId: chatOf.get(job.personId) ?? null,
      kind: 'needs',
      title: job.title,
      writes: job.writes,
      seconds: job.secondsRun,
      seq: job.handoverSeq,
      waitingFor: job.waitingFor as WaitingFor,
      ready: job.readyWhat && job.readyWhere ? { what: job.readyWhat, where: job.readyWhere } : null,
      waitedFor: null,
      why: null,
      effects: effectsOf(job),
      files: [],
      givenBack: false,
    });
  }
  return reports;
}

/**
 * The bot server says this was told. An ending is marked once; a wait is marked only for the wait it said (`seq`), so a later wait that began in
 * between is still to be told. Safe to say twice. False when there is no such job.
 */
export async function keepReportTold(jobId: string, kind: ReportKind, seq?: number | null, now: Date = new Date()): Promise<boolean> {
  if (kind === 'needs') {
    if (typeof seq !== 'number') return false;
    const found = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!found) return false;
    await prisma.computerJob.updateMany({ where: { id: jobId, handoverSeq: seq }, data: { handoverUntold: false } });
    return true;
  }
  const found = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!found) return false;
  await prisma.computerJob.updateMany({ where: { id: jobId, endToldAt: null, status: { in: ['done', 'stopped', 'failed'] } }, data: { endToldAt: now } });
  return true;
}
