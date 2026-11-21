import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ORBIT_SOURCE, OWN_KEY_CALL_MARK, RELAY_UNREACHABLE, hasOwnKeyCall } from '@/lib/computer-faults';
import { UNREACHABLE_WORDS, appLabel } from '@/lib/task-receipt-words';
import { readFilesList } from '@/lib/computer-files';
import { refundStatesFor } from '@/lib/computer-refunds';
import { silentEnding, type UndeliverableWhy, type WaitingFor } from '@/lib/computer-values';
import { cardsOfJobs, handedPathsOf, HAND_OVER_ALIVE_MS, HAND_OVER_LATEST_MS, madeInJob, type Card } from '@/lib/computer-file-cards';

/**
 * Brick tells the person how a computer job went (the report back), in their own chat with it. Orbit never speaks in a chat: the bot server asks
 * this list now and then, says each item once under its own transaction id, and tells Orbit it was said. What is here is only what the
 * database proves about the job:
 *  - what reached a site, from the job's own effect rows (written before each try, and settled with where it went), never the computer's words;
 *  - the files that appeared on the computer while the job ran, from the list taken when it ended, and the ones handed over for the chat as cards (a
 *    "done" report waits until that was done, so the cards are never missed);
 *  - whether the try was given back, from the meter's books (the minutes written against nobody), never assumed;
 *  - the one sentence the computer gave for why it could not go on, cleaned, kept apart from the facts and only on a failure.
 * Nothing here says "done" on the computer's word alone beyond the ending the runner reported, and nothing says a thing was NOT sent unless
 * no effect of that kind is on record.
 */

export type ReportKind = 'done' | 'failed' | 'needs' | 'unanswered' | 'month' | 'rule' | 'late';

/** Kinds a reader must say it understands before it is sent one (a reader that does not, an older game, is never sent them). */
export type OptInKind = 'late';
export const OPT_IN_KINDS: readonly OptInKind[] = ['late'];

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
  /** The conversation the job began in (a direct chat, by its id); the result goes back there and nowhere else. Null for a job that began without one: it goes to the person's own direct chat. */
  origin: { kind: 'dm'; ref: string } | null;
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
  /** `done`: names of files that appeared while the job ran and were not handed over (too many, too big, unreadable), newest first. */
  files: string[];
  /** `done`: files handed over for the chat as cards. The bot server fetches each at /api/computer/jobs/:jobId/files/:id. */
  handed: Card[];
  /** The minutes of this try do not count against the person's month (proved in the books, or none were used). */
  givenBack: boolean;
  /**
   * Credit this failed try drew that is owed back to the person and not yet acknowledged by the books, in whole micros (0 when none): a report never promises a refund as made while this is above 0.
   * Optional for older readers; Activity says the same amount ("$0.03 refund pending").
   */
  refundPendingMicros?: number;
  /** `late` only: the display names of the Apps that went out after all (let go unconfirmed, their hold released, confirmed later by the provider's own log), in the order they were confirmed. */
  apps?: string[];
  /** `late` only: the same names under the name the game reads them by (kept equal to `apps`) */
  lateApps?: string[];
  /** `late` only: those Apps' holds were released and nothing was charged for them, then or later. */
  holdReleased?: true;
}

/**
 * How long an ending that never finished its own work (its server stopped halfway) waits before it is told as it stands: its own work takes well under a minute,
 * plus the longest handing over of files can run, so the cards are never written after the message went without them.
 */
const UNFINISHED_ENDING_MS = 5 * 60 * 1000 + HAND_OVER_LATEST_MS;
/** How long a job that was refused by a rule before it began waits before it is listed (the call that asked may be deleting it). */
const NEVER_STARTED_GRACE_MS = 30 * 1000;
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

/**
 * A file's name as it is said: kept exactly as the computer named it (underscores, long hash names and all), minus only what could make the
 * line say something else: markers, backticks and angle brackets, control characters. Cut between whole characters when long.
 */
export function fileNameOf(raw: string | null | undefined, max: number = FILE_NAME_MAX): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/[`<>]/g, ' ')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
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

/**
 * Files the job made, named, from the list taken when THIS job ended and the one taken before it began (both kept on the job, never the computer's latest
 * list): what is new in the end list, no hidden folder. Nothing when the job writes nothing or has no list from before it began (nothing can be proved).
 */
export function filesMadeBy(end: unknown, start: unknown, skip: ReadonlySet<string> = new Set()): string[] {
  const names: string[] = [];
  for (const entry of madeInJob(readFilesList(end), readFilesList(start))) {
    // A file handed over as a card is not named again
    if (skip.has(entry.path)) continue;
    const parts = entry.path.split('/');
    if (parts.some((part) => part.startsWith('.'))) continue;
    const name = fileNameOf(parts[parts.length - 1]);
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

const originOf = (job: { originKind: string | null; originRef: string | null }): Report['origin'] => (job.originKind === 'dm' && job.originRef ? { kind: 'dm', ref: job.originRef } : null);

// In the order they were planned, so what is said reads in the order it happened
const EFFECTS = { select: { effectKey: true, kind: true, state: true, evidence: true }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] };

/** Where the deploy that made the follow-up possible is kept (the migration writes it once): only a confirmation that came after it can be offered, so no job corrected earlier is ever told about. */
const LATE_SINCE_KEY = 'computer_late_report_since';
/** How far back a let-go run is looked at (a little over the days its provider log is waited for). */
const LATE_LOOK_DAYS = 36;
/** Jobs read per page, and the most pages one look reads (a look that finds `size` reports stops at once; the cap only bounds a window of thousands that are all waiting on something). */
const LATE_PAGE = 200;
const LATE_MAX_PAGES = 25;

async function lateReportSince(now: Date): Promise<Date> {
  const row = await prisma.appSetting.findUnique({ where: { key: LATE_SINCE_KEY } });
  const at = typeof row?.value === 'string' ? new Date(row.value) : null;
  if (at && !Number.isNaN(at.getTime())) return at;
  // Kept at the first look when the deploy's own record is missing: nothing earlier than now is ever offered
  await prisma.appSetting.upsert({ where: { key: LATE_SINCE_KEY }, update: {}, create: { key: LATE_SINCE_KEY, value: now.toISOString() } });
  return now;
}

/**
 * The one follow-up for a job whose App was let go unconfirmed (its hold released, nothing charged) and that the provider's own log CONFIRMED later: the first report could only say it was not confirmed.
 * Offered once per job, and only when everything is already true that the receipt says: the first report was DELIVERED (a person who never got it is never told this), the confirmation came AFTER the deploy
 * that made this possible, the App's hold is released and nothing was ever charged for it, the job is Universe-paid (a job with a call on the person's own key is never told this), and the computer part was
 * given back and the books acknowledged it (no refund still pending). Told by `keepReportTold` with the kind `late`, which is the only thing that marks it.
 */
async function lateReports(size: number, now: Date): Promise<Report[]> {
  const since = await lateReportSince(now);
  const lookBack = new Date(now.getTime() - LATE_LOOK_DAYS * 24 * 60 * 60 * 1000);
  const out: Report[] = [];
  // Jobs are read a page at a time, oldest confirmation first, until `size` reports are found or there are none left: a job that is dropped below (a refund still pending, books not yet given back) is never
  // marked, so a fixed window would let enough of them crowd out every newer job for good. What can never change (the decision is not a give-back, a call on the person's own key, a deleted Brick) is dropped in the
  // query, so such a job is never read at all; only what may still change is checked below
  let after: { at: Date; id: string } = { at: new Date(0), id: '' };
  for (let page = 0; page < LATE_MAX_PAGES && out.length < size; page++) {
    const found = await prisma.$queryRaw<Array<{ job_id: string; first_at: Date; toolkits: string[] }>>(Prisma.sql`
      SELECT i."task_key" AS job_id, MIN((i."detail"->'lateEvidence'->>'at')::timestamptz) AS first_at,
             array_agg(i."toolkit" ORDER BY (i."detail"->'lateEvidence'->>'at')::timestamptz ASC, i."id" ASC) AS toolkits
      FROM "instant_runs" i
        JOIN "computer_jobs" j ON j."id" = i."task_key" AND j."person_id" = i."person_id" AND j."bot_id" = i."bot_id"
        JOIN "computer_give_back_decisions" d ON d."job_id" = j."id" AND d."state" = 'given'
        JOIN "bots" b ON b."id" = j."bot_id" AND b."deleted_at" IS NULL
      WHERE i."state" = 'failed' AND i."reason" = 'unclear' AND i."created_at" >= ${lookBack}
        AND i."detail"->'lateEvidence'->>'status' = 'success'
        AND i."customer_state" = 'released' AND COALESCE(i."customer_micros", 0) = 0
        AND (i."detail"->'lateEvidence'->>'at')::timestamptz >= ${since}
        AND j."status" IN ('done', 'stopped', 'failed') AND j."ended_told_at" IS NOT NULL AND j."late_told_at" IS NULL AND j."end_undeliverable_at" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "computer_job_faults" f WHERE f."job_id" = j."id" AND f."call_id" = ${OWN_KEY_CALL_MARK} AND f."source" = ${ORBIT_SOURCE})
      GROUP BY i."task_key"
      HAVING (MIN((i."detail"->'lateEvidence'->>'at')::timestamptz), i."task_key") > (${after.at}::timestamptz, ${after.id})
      ORDER BY first_at ASC, i."task_key" ASC
      LIMIT ${LATE_PAGE}`);
    if (found.length === 0) break;
    const last = found[found.length - 1];
    after = { at: last.first_at, id: last.job_id };
    const appsOf = new Map<string, string[]>();
    for (const row of found) {
      const names: string[] = [];
      for (const toolkit of row.toolkits) {
        const label = appLabel(toolkit);
        if (!names.includes(label)) names.push(label);
      }
      appsOf.set(row.job_id, names);
    }
    const jobs = await prisma.computerJob.findMany({ where: { id: { in: [...appsOf.keys()] }, bot: { deletedAt: null } } });
    const jobOf = new Map(jobs.map((job) => [job.id, job]));
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set(jobs.map((job) => job.personId))] } }, select: { id: true, matrixChatId: true } });
    const chatOf = new Map(people.map((person) => [person.id, person.matrixChatId ?? null]));
    const owed = await refundStatesFor(jobs.map((job) => job.id));
    // In the order the query found them (the oldest confirmation first)
    for (const row of found) {
      if (out.length >= size) break;
      const job = jobOf.get(row.job_id);
      if (!job) continue;
      // The computer part was given back, in the books, with no refund still pending (both may still change); and no call on the person's own key was ever made (their own bill is not ours to speak of)
      if (!(await givenBackIn(job.id, job.secondsRun)) || (owed.get(job.id)?.pendingMicros ?? 0) > 0) continue;
      if (await hasOwnKeyCall(prisma, job.id)) continue;
      // Only a computer that was given back by a decision (the query keeps those): a job that ended well has nothing "given back" to say
      out.push({
        key: `computer-told:${job.id}:late`,
        jobId: job.id,
        botId: job.botId,
        matrixUserId: chatOf.get(job.personId) ?? null,
        origin: originOf(job),
        kind: 'late',
        title: job.title,
        writes: job.writes,
        seconds: job.secondsRun,
        seq: null,
        waitingFor: null,
        ready: null,
        waitedFor: null,
        why: null,
        effects: [],
        files: [],
        handed: [],
        givenBack: true,
        apps: appsOf.get(job.id) ?? [],
        lateApps: appsOf.get(job.id) ?? [],
        holdReleased: true,
      });
    }
    if (found.length < LATE_PAGE) break;
  }
  return out;
}

/**
 * What Brick is to tell now, oldest first: endings not told yet, then waits for the person not told yet. A job whose person has no chat is still
 * listed (with no chat id) so the bot server can say it cannot and Orbit stops offering it.
 */
export async function reportsToTell(limit = 50, now: Date = new Date(), options: { accepts?: readonly string[] } = {}): Promise<Report[]> {
  const size = Math.max(1, Math.min(limit, 200));
  // An ending is told once everything it does is finished; one a server left half done is told anyway after a while, never held for ever
  const unfinishedBefore = new Date(now.getTime() - UNFINISHED_ENDING_MS);
  const staleClaimBefore = new Date(now.getTime() - HAND_OVER_LATEST_MS);
  const staleAliveBefore = new Date(now.getTime() - HAND_OVER_ALIVE_MS);
  const ended = await prisma.computerJob.findMany({
    where: {
      status: { in: ['done', 'stopped', 'failed'] },
      endToldAt: null,
      endUndeliverableAt: null,
      bot: { deletedAt: null },
      AND: [
        // A job that never began is only reported when a rule stopped it while it waited in line (nobody else says so); one the caller was told "a rule stopped this" at the
        // moment of asking is deleted by that call, so it is given a moment before it is listed
        { OR: [{ startedAt: { not: null } }, { endedBy: 'rule', endedAt: { lte: new Date(now.getTime() - NEVER_STARTED_GRACE_MS) } }] },
        { OR: [{ endedBy: null }, { endedBy: { notIn: ['person', 'off', 'deleted'] } }] },
        {
          OR: [
            { endClosedAt: { not: null } },
            // Not while a hand-over on its Brick's computer is live: the job may be waiting in line for it, and its cards are not made yet
            {
              endedAt: { lte: unfinishedBefore },
              AND: [
                // Not while it is itself waiting in line for its hand-over, however long that takes (it beats while it waits: the moment between two hand-overs has no claim on
                // the machine). One whose server stopped stops beating, and a claim not renewed for the longest hand-over is long past: both are recovered, so nothing is held for ever.
                { OR: [{ handOverAliveAt: null }, { handOverAliveAt: { lt: staleAliveBefore } }] },
                // (a plain NOT would drop a computer whose claim is empty: a comparison with nothing is neither true nor false)
                { bot: { OR: [{ computer: { is: null } }, { computer: { filesClaimedAt: null } }, { computer: { filesClaimedAt: { lt: staleClaimBefore } } }] } },
              ],
            },
          ],
        },
      ],
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
  // The follow-up for an App that went out after all is offered only to a reader that said it understands it (an older game never sees the kind)
  const late = options.accepts?.includes('late') ? await lateReports(size, now) : [];
  if (jobs.length === 0) return late;
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(jobs.map((job) => job.personId))] } }, select: { id: true, matrixChatId: true } });
  const chatOf = new Map(people.map((person) => [person.id, person.matrixChatId ?? null]));
  const cardsOf = await cardsOfJobs(ended.filter((job) => job.status === 'done').map((job) => job.id));
  // Every file a job handed over is not "left on the computer": the ones the chat already took, and the ones the person has deleted since, as much as the ones still to send
  const handedPaths = await handedPathsOf(ended.filter((job) => job.status === 'done').map((job) => job.id));

  // What a failed try drew from credit and is still owed back (one read for the page): said with the report, never promised as made while the books have not acknowledged it
  // Every job told as `failed` (a failed try, and one our own pool cut off, which stays `stopped` but is reported as failed too and can owe a refund as well)
  const failedIds = ended.filter((job) => kindOfEnding(job.status, job.endedBy) === 'failed').map((job) => job.id);
  const owedBack = await refundStatesFor(failedIds);
  // A job Orbit gave back because its computer could not reach our own model service says that, in the words a receipt uses, rather than the computer's own sentence about a model that never answered
  const unreachable = new Set(failedIds.length === 0 ? [] : (await prisma.computerGiveBackDecision.findMany({ where: { jobId: { in: failedIds }, state: 'given', reason: RELAY_UNREACHABLE }, select: { jobId: true } })).map((one) => one.jobId));
  const reports: Report[] = [];
  for (const job of ended) {
    const kind = kindOfEnding(job.status, job.endedBy);
    // An ending that is never told is marked as told, so it is not offered again
    if (!kind) {
      await prisma.computerJob.updateMany({ where: { id: job.id, endToldAt: null }, data: { endToldAt: new Date() } });
      continue;
    }
    const givenBack = kind === 'failed' ? await givenBackIn(job.id, job.secondsRun) : false;
    // A credit still owed back is said only for a job that IS being given back: one that was refused (the person's, or over the bound) keeps its credit, so nothing is owed to it
    const pendingRefund = kind === 'failed' && givenBack ? (owedBack.get(job.id)?.pendingMicros ?? 0) : 0;
    reports.push({
      key: `computer-told:${job.id}:${kind}`,
      jobId: job.id,
      botId: job.botId,
      matrixUserId: chatOf.get(job.personId) ?? null,
      origin: originOf(job),
      kind,
      title: job.title,
      writes: job.writes,
      seconds: job.secondsRun,
      seq: null,
      waitingFor: null,
      ready: null,
      waitedFor: kind === 'unanswered' ? (job.endWaitingFor as WaitingFor | null) : null,
      why: kind === 'failed' && givenBack && pendingRefund === 0 && unreachable.has(job.id) ? UNREACHABLE_WORDS : kind === 'failed' || kind === 'rule' ? job.endNote : null,
      effects: effectsOf(job),
      files: kind === 'done' && job.writes ? filesMadeBy(job.endFiles, job.startFiles, new Set(handedPaths.get(job.id) ?? [])) : [],
      handed: kind === 'done' ? (cardsOf.get(job.id) ?? []).map((card) => ({ id: card.id, name: card.name, bytes: card.bytes, mime: card.mime })) : [],
      givenBack,
      ...(pendingRefund > 0 ? { refundPendingMicros: pendingRefund } : {}),
    });
  }
  for (const job of waiting) {
    reports.push({
      key: `computer-told:${job.id}:needs:${job.handoverSeq}`,
      jobId: job.id,
      botId: job.botId,
      matrixUserId: chatOf.get(job.personId) ?? null,
      origin: originOf(job),
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
      handed: [],
      givenBack: false,
    });
  }
  return [...reports, ...late];
}

export type ReportOutcome = { delivered: true } | { delivered: false; why: UndeliverableWhy };

/**
 * The bot server says what became of a report. Only a DELIVERED report is "told" (ending: `ended_told_at`; wait: its own wait only, by `seq`, so a later
 * wait that began in between is still to be told). One that can never be delivered is marked so and never offered again, and is never called told. A
 * report that has not been confirmed either way is still to be tried. The files a job made stay the person's in Files whichever it was. Safe to say
 * twice. False when there is no such job.
 */
export async function keepReportTold(jobId: string, kind: ReportKind, seq?: number | null, outcome: ReportOutcome = { delivered: true }, now: Date = new Date()): Promise<boolean> {
  if (kind === 'needs') {
    if (typeof seq !== 'number') return false;
    const found = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!found) return false;
    // A wait that can never be said is not offered again either (the person still sees it in the bar and in Files), and it is not recorded as said
    await prisma.computerJob.updateMany({ where: { id: jobId, handoverSeq: seq }, data: { handoverUntold: false } });
    return true;
  }
  if (kind === 'late') {
    const there = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!there) return false;
    // Told, or never to be told (it can never reach them): either way it is never offered again. It never touches the ending's own marks
    await prisma.computerJob.updateMany({ where: { id: jobId, lateToldAt: null }, data: { lateToldAt: now } });
    return true;
  }
  const found = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!found) return false;
  const over = { status: { in: ['done', 'stopped', 'failed'] } };
  if (outcome.delivered) await prisma.computerJob.updateMany({ where: { id: jobId, endToldAt: null, endUndeliverableAt: null, ...over }, data: { endToldAt: now } });
  else await prisma.computerJob.updateMany({ where: { id: jobId, endToldAt: null, endUndeliverableAt: null, ...over }, data: { endUndeliverableAt: now, endUndeliverableWhy: outcome.why } });
  return true;
}
