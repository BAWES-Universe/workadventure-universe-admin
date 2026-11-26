import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Brick reports (mock "Brick reports inbox"): when a Brick can't do something, gets something wrong, or has an idea, it sends a short note
 * to the Universe team. Notes that read alike join one problem, and the inbox counts and ranks problems across every Brick. No words from
 * chats: the Brick is told to write in general words, the bot server refuses a note that repeats the person, and Orbit removes emails,
 * phone numbers, links, @names and long numbers before anything is kept. People are counted as a one-way hash, never stored. The Brick
 * is kept only to tell its owner when a fix ships; no screen shows which Brick, owner, world or room sent a note.
 *
 * Note text is untrusted: anyone can get a Brick to send any words. Whatever reads notes later (the weekly sort, lessons that go into every
 * Brick's rules) must treat them as data inside a fenced block, never as instructions; a lesson may come only from a problem with notes
 * from 3 or more different owners, and never copies a note's words.
 */

export const REPORT_KINDS = ['problem', 'cant_do', 'friction', 'idea'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_AREAS = ['apps', 'computer', 'pages', 'chat', 'voice', 'map', 'memory', 'files', 'credit', 'other'] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];
export const REPORT_EFFECTS = ['stopped', 'slowed', 'idea'] as const;
export type ReportEffect = (typeof REPORT_EFFECTS)[number];
export const REPORT_STATES = ['new', 'working', 'fixed'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export const TITLE_MAX = 80;
export const TEXT_MAX = 280;
/** Notes one Brick sends in a day (UTC), the same for its own key and Universe AI: it keeps one Brick in a loop from filling the inbox. */
export const NOTES_PER_BRICK_PER_DAY = 10;
/** How long the chat can take a note back. */
export const TAKE_BACK_MS = 24 * 60 * 60 * 1000;
/** How close two titles must read (0 to 1) for a note to join a problem. */
const SAME_PROBLEM = 0.42;
/** The problems of one kind and area a new note is compared with, most recently seen first. */
const CANDIDATES = 500;

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

// ---------------------------------------------------------------- cleaning

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** Any scheme with `//` (https, ftp, and written-around ones like hxxps). */
const SCHEME = /\b[a-z][a-z0-9+.-]{1,20}:\/\/\S*/giu;
/** Addresses that need no `//`. */
const URI = /\b(?:mailto|tel|sms|matrix|data|javascript|file):\S+/giu;
const WWW = /\bwww\.\S+/giu;
/** An address written around a filter: example[.]com, example (dot) com. */
const OBF_DOMAIN = /\S+\s*[\[(]\s*(?:\.|dot)\s*[\])]\s*\S+/giu;
/**
 * The endings a file name is kept with. Every other name.ending goes, since any ending can be a web address (.it, .nl, .travel). `.ai`,
 * `.so`, `.io`, `.me`, `.app` and `.dev` are not here: they are web addresses as often as file names.
 */
const FILE_EXT = new Set(['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'htm', 'css', 'md', 'txt', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp3', 'mp4', 'py', 'sh', 'yml', 'yaml', 'zip', 'docx', 'xlsx', 'pptx']);
const DOMAIN = /\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(\p{L}{2,24})\b(?:\/\S*)?/giu;
const AT_NAME = /(^|[^\p{L}\p{N}_])@[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/gu;
/** 16 or more letters, digits and _-+/= mixing letters and digits: keys, tokens and ids. */
const TOKEN = /[A-Za-z0-9_\-+/=]{16,}/g;
/** Seven or more digits with the spaces, dashes, dots and brackets a phone number (or a full date, which can be a birth date) is written with. */
const PHONE = /\+?\(?\p{Nd}[\p{Nd}\s().-]{5,}\p{Nd}/gu;
const LONG_NUMBER = /\p{Nd}{5,}/gu;
/** Where the digits 0 to 9 start in the scripts people write numbers in most (Arabic, Persian, Devanagari, Bengali, Thai, full width). */
const DIGIT_ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10];

/** Digits of other scripts as 0 to 9, so a phone number in Arabic digits is read as one. */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    for (const zero of DIGIT_ZEROS) if (code >= zero && code < zero + 10) return String(code - zero);
    return digit;
  });
}

/**
 * A note's text with nothing that points at a person or a place: emails, links and web addresses (with or without https://, or written
 * around a filter), @names, keys and ids, phone numbers, dates and numbers of five digits or more are removed, in any script's digits
 * and with invisible characters taken out first. A file name stays only with a common file ending. Spaces are folded and the text is cut
 * to `max` characters, never inside one.
 */
export function cleanReportText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  let text = asciiDigits(raw.normalize('NFKC'))
    .replace(/\p{Cf}+/gu, '')
    .replace(/\p{Cc}+/gu, ' ');
  text = text
    .replace(EMAIL, ' ')
    .replace(SCHEME, ' ')
    .replace(URI, ' ')
    .replace(WWW, ' ')
    .replace(OBF_DOMAIN, ' ')
    .replace(DOMAIN, (match: string, ending: string) => (FILE_EXT.has(ending.toLowerCase()) && !match.includes('/') ? match : ' '))
    .replace(AT_NAME, '$1 ');
  text = text.replace(TOKEN, (match) => (/[A-Za-z]/.test(match) && /\d/.test(match) ? ' ' : match));
  text = text.replace(PHONE, (match) => ((match.match(/\p{Nd}/gu)?.length ?? 0) >= 7 ? ' ' : match)).replace(LONG_NUMBER, ' ');
  text = text.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('').trim() : text;
}

// ---------------------------------------------------------------- matching

function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** How alike two titles read, from 0 to 1: shared three-letter pieces over all of them (the measure Postgres' pg_trgm uses). */
export function titleLikeness(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const piece of x) if (y.has(piece)) shared += 1;
  return shared / (x.size + y.size - shared);
}

// ---------------------------------------------------------------- intake

export interface NoteInput {
  botId: string;
  /** Who was in the chat, in the words reply windows use (person:<id>, guest:<id>). Kept only as a one-way hash. */
  personKey?: string | null;
  kind: ReportKind;
  area: ReportArea;
  title: unknown;
  tried?: unknown;
  stopped?: unknown;
  idea?: unknown;
  effect: ReportEffect;
  context?: NoteContext | null;
}

/** What the bot server already knew when the note was sent, with no words in it. */
export interface NoteContext {
  model?: string;
  ownKey?: boolean;
  gameVersion?: string;
  tools?: string[];
}

/** The note as it was kept, after cleaning: what the chat shows under "What was sent". */
export interface SentNote {
  kind: ReportKind;
  area: ReportArea;
  title: string;
  tried: string;
  stopped: string;
  idea: string;
  effect: ReportEffect;
}

export type NoteOutcome =
  | { sent: true; id: string; takeBackKey: string; note: SentNote }
  | { sent: false; reason: 'empty' | 'limit' | 'unknown_brick' };

/** A one-way hash of who was in the chat, marked only `g:` for a guest or `p:` for someone signed in: guests count less, since a guest id is cheap to change. */
const personHash = (key: string) => `${key.startsWith('guest:') ? 'g' : 'p'}:${createHash('sha256').update(`brick-report:${key}`).digest('hex').slice(0, 32)}`;
const keyHash = (key: string) => createHash('sha256').update(`brick-report-take-back:${key}`).digest('hex');
const dayOf = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Keeps one note and counts it into a problem: an open problem of the same kind and area whose title reads alike, or a new one. A note on
 * a problem marked fixed takes it back to New as "came back". At most NOTES_PER_BRICK_PER_DAY a day per Brick. Never says who sent it.
 */
export async function recordReportNote(input: NoteInput, now: Date = new Date()): Promise<NoteOutcome> {
  const note: SentNote = {
    kind: input.kind,
    area: input.area,
    title: cleanReportText(input.title, TITLE_MAX),
    tried: cleanReportText(input.tried, TEXT_MAX),
    stopped: cleanReportText(input.stopped, TEXT_MAX),
    idea: cleanReportText(input.idea, TEXT_MAX),
    effect: input.effect,
  };
  if (note.title.length < 3) return { sent: false, reason: 'empty' };
  // Only a Brick sends notes: a room bot has no owner, and a deleted Brick is off
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { id: true, ownerId: true, deletedAt: true } });
  if (!bot || !bot.ownerId || bot.deletedAt) return { sent: false, reason: 'unknown_brick' };

  const day = dayOf(now);
  const takeBackKey = randomBytes(24).toString('base64url');
  const context = input.context ? (input.context as Prisma.InputJsonValue) : Prisma.JsonNull;
  return prisma.$transaction(async (tx) => {
    // One Brick's notes, then one kind and area's problems, always in that order: two notes of the same Brick never pass the day's
    // count together, and two alike notes never start two problems
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brick-report-bot:${bot.id}`}, 0))`;
    const today = await tx.brickReportNote.count({ where: { botId: bot.id, day } });
    if (today >= NOTES_PER_BRICK_PER_DAY) return { sent: false as const, reason: 'limit' as const };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brick-report-problem:${note.kind}:${note.area}`}, 0))`;
    const candidates = await tx.brickReportProblem.findMany({
      where: { kind: note.kind, area: note.area },
      orderBy: { lastSeenAt: 'desc' },
      take: CANDIDATES,
      select: { id: true, title: true, state: true },
    });
    let best: { id: string; state: string } | null = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = titleLikeness(note.title, candidate.title);
      if (score >= SAME_PROBLEM && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    const reopened = best?.state === 'fixed';
    const problemId = best
      ? (
          await tx.brickReportProblem.update({
            where: { id: best.id },
            data: { lastSeenAt: now, ...(reopened ? { state: 'new', cameBack: true, stateAt: now } : {}) },
            select: { id: true },
          })
        ).id
      : (await tx.brickReportProblem.create({ data: { kind: note.kind, area: note.area, title: note.title, firstSeenAt: now, lastSeenAt: now }, select: { id: true } })).id;
    const kept = await tx.brickReportNote.create({
      data: {
        problemId,
        botId: bot.id,
        personKey: input.personKey ? personHash(input.personKey) : null,
        ...note,
        context,
        reopened,
        takeBackHash: keyHash(takeBackKey),
        day,
        createdAt: now,
      },
      select: { id: true },
    });
    return { sent: true as const, id: kept.id, takeBackKey, note };
  });
}

export type TakeBackOutcome = { takenBack: true } | { takenBack: false; reason: 'not_found' | 'too_late' };

/**
 * Takes a note back, for anyone in the chat that holds its key, within TAKE_BACK_MS of sending. Taking it back twice is fine. Its words go
 * at once: the row stays, empty, only so the Brick's count for the day still holds it. Its problem then reads as its other notes do (the
 * title of the earliest one left), or goes when none is left. A note that took a fixed problem back to New, taken back while no later note
 * holds the problem open, puts it back to Fixed: what was taken back never counts.
 */
export async function takeBackReportNote(id: string, key: string, now: Date = new Date()): Promise<TakeBackOutcome> {
  const row = await prisma.brickReportNote.findUnique({
    where: { id },
    select: { takeBackHash: true, takenBackAt: true, createdAt: true, reopened: true, problemId: true, kind: true, area: true },
  });
  const given = Buffer.from(keyHash(key), 'hex');
  const held = row ? Buffer.from(row.takeBackHash, 'hex') : null;
  if (!row || !held || held.length !== given.length || !timingSafeEqual(held, given)) return { takenBack: false, reason: 'not_found' };
  if (row.takenBackAt) return { takenBack: true };
  if (now.getTime() - row.createdAt.getTime() > TAKE_BACK_MS) return { takenBack: false, reason: 'too_late' };
  await prisma.$transaction(async (tx) => {
    // The same lock as a new note of this kind and area: a note arriving now either sees the problem as it is after this, or holds it open itself
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brick-report-problem:${row.kind}:${row.area}`}, 0))`;
    // Only a note not taken back yet: a second tap racing the first changes nothing
    const taken = await tx.brickReportNote.updateMany({
      where: { id, takenBackAt: null },
      data: { title: '', tried: '', stopped: '', idea: '', context: Prisma.JsonNull, personKey: null, takenBackAt: now },
    });
    if (taken.count === 0 || !row.problemId) return;
    const live = await tx.brickReportNote.findMany({
      where: { problemId: row.problemId, takenBackAt: null },
      orderBy: { createdAt: 'asc' },
      select: { title: true, createdAt: true },
    });
    if (live.length === 0) {
      // Nothing left: the problem goes, title and all (the emptied notes keep their row for the day's count)
      await tx.brickReportProblem.deleteMany({ where: { id: row.problemId } });
      return;
    }
    const problem = await tx.brickReportProblem.findUnique({ where: { id: row.problemId }, select: { state: true, stateAt: true } });
    if (!problem) return;
    // Moved by hand since (Working on, or Fixed again) is a person's call, and it stands; so does a later note holding it open
    const restore =
      row.reopened && problem.state === 'new' && problem.stateAt?.getTime() === row.createdAt.getTime() && !live.some((note) => note.createdAt >= row.createdAt);
    await tx.brickReportProblem.update({
      where: { id: row.problemId },
      data: { title: live[0].title, lastSeenAt: live[live.length - 1].createdAt, ...(restore ? { state: 'fixed', cameBack: false, stateAt: now } : {}) },
    });
  });
  return { takenBack: true };
}

// ---------------------------------------------------------------- the inbox

export type Level = 'high' | 'medium' | 'low';

export interface Reason {
  /** What earned the points, in words for the screen ("9 Bricks", "Stopped the work"). */
  label: string;
  points: number;
}

export interface ProblemRow {
  id: string;
  kind: ReportKind;
  area: ReportArea;
  title: string;
  state: ReportState;
  cameBack: boolean;
  bricks: number;
  people: number;
  times: number;
  thisWeek: number;
  lastWeek: number;
  rising: boolean;
  stoppedWork: boolean;
  score: number;
  level: Level;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Inbox {
  state: ReportState;
  counts: Record<ReportState, number>;
  problems: ProblemRow[];
}

const HIGH_FROM = 25;
const MEDIUM_FROM = 12;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The priority of a problem and why, from its counts: 3 a Brick, 2 a person, 5 if it stopped the work, 3 if rising, 6 if it came back.
 * One person can't make a problem High alone: Bricks of one owner count once (`owners`, never shown), and guests, whose id is cheap to
 * change, count 1 each and 2 at most.
 */
export function priorityOf(counts: {
  bricks: number;
  owners?: number;
  people: number;
  guests?: number;
  stoppedWork: boolean;
  thisWeek: number;
  lastWeek: number;
  cameBack: boolean;
}): {
  score: number;
  level: Level;
  rising: boolean;
  reasons: Reason[];
} {
  // Half again more than last week, and last week had some: a problem first seen this week is new, not rising
  const rising = counts.lastWeek > 0 && counts.thisWeek >= counts.lastWeek * 1.5;
  const reasons: Reason[] = [];
  if (counts.stoppedWork) reasons.push({ label: 'Stopped the work', points: 5 });
  const guests = Math.min(counts.guests ?? 0, counts.people);
  if (counts.bricks > 0) reasons.push({ label: plural(counts.bricks, 'Brick', 'Bricks'), points: 3 * Math.min(counts.bricks, counts.owners ?? counts.bricks) });
  if (counts.people > 0) reasons.push({ label: plural(counts.people, 'person', 'people'), points: 2 * (counts.people - guests) + Math.min(guests, 2) });
  if (rising) reasons.push({ label: `${counts.thisWeek} this week, ${counts.lastWeek} last week`, points: 3 });
  if (counts.cameBack) reasons.push({ label: 'Came back after a fix', points: 6 });
  const score = reasons.reduce((sum, reason) => sum + reason.points, 0);
  return { score, level: score >= HIGH_FROM ? 'high' : score >= MEDIUM_FROM ? 'medium' : 'low', rising, reasons };
}

type CountRow = {
  id: string;
  kind: string;
  area: string;
  title: string;
  state: string;
  came_back: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
  bricks: number;
  owners: number;
  people: number;
  guests: number;
  times: number;
  this_week: number;
  last_week: number;
  stopped: boolean;
};

/** Every problem with at least one note not taken back, with its counts. A note from a deleted Brick still counts, as one Brick for all of them. */
async function countedProblems(where: Prisma.Sql, now: Date): Promise<CountRow[]> {
  const weekAgo = new Date(now.getTime() - WEEK);
  const twoWeeksAgo = new Date(now.getTime() - 2 * WEEK);
  return prisma.$queryRaw<CountRow[]>(Prisma.sql`
    SELECT p.id, p.kind, p.area, p.title, p.state, p.came_back, p.first_seen_at, p.last_seen_at,
      ((COUNT(DISTINCT n.bot_id)) + (CASE WHEN BOOL_OR(n.bot_id IS NULL) THEN 1 ELSE 0 END))::int AS bricks,
      (COUNT(DISTINCT COALESCE(b.owner_id, n.bot_id, '')))::int AS owners,
      (COUNT(DISTINCT n.person_key))::int AS people,
      (COUNT(DISTINCT n.person_key) FILTER (WHERE n.person_key LIKE 'g:%'))::int AS guests,
      (COUNT(*))::int AS times,
      (COUNT(*) FILTER (WHERE n.created_at >= ${weekAgo}))::int AS this_week,
      (COUNT(*) FILTER (WHERE n.created_at >= ${twoWeeksAgo} AND n.created_at < ${weekAgo}))::int AS last_week,
      COALESCE(BOOL_OR(n.effect = 'stopped'), FALSE) AS stopped
    FROM brick_report_problems p JOIN brick_report_notes n ON n.problem_id = p.id AND n.taken_back_at IS NULL
      LEFT JOIN bots b ON b.id = n.bot_id
    WHERE ${where}
    GROUP BY p.id`);
}

const countsOf = (row: CountRow) =>
  priorityOf({
    bricks: row.bricks,
    owners: row.owners,
    people: row.people,
    guests: row.guests,
    stoppedWork: row.stopped,
    thisWeek: row.this_week,
    lastWeek: row.last_week,
    cameBack: row.came_back,
  });

function rowOf(row: CountRow): ProblemRow {
  const priority = countsOf(row);
  return {
    id: row.id,
    kind: row.kind as ReportKind,
    area: row.area as ReportArea,
    title: row.title,
    state: row.state as ReportState,
    cameBack: row.came_back,
    bricks: row.bricks,
    people: row.people,
    times: row.times,
    thisWeek: row.this_week,
    lastWeek: row.last_week,
    rising: priority.rising,
    stoppedWork: row.stopped,
    score: priority.score,
    level: priority.level,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

/** One tab of the inbox, highest priority first (then the most recently seen), and how many problems each tab holds. */
export async function reportInbox(state: ReportState, now: Date = new Date()): Promise<Inbox> {
  const rows = (await countedProblems(Prisma.sql`TRUE`, now)).map(rowOf);
  const counts: Record<ReportState, number> = { new: 0, working: 0, fixed: 0 };
  for (const row of rows) if (row.state in counts) counts[row.state] += 1;
  const problems = rows.filter((row) => row.state === state).sort((a, b) => b.score - a.score || b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { state, counts, problems };
}

export interface ProblemDetail extends ProblemRow {
  reasons: Reason[];
  /** Two notes picked at random each time (their order never hints at who sent them): only what the Brick wrote, cleaned. */
  sample: Array<{ tried: string; stopped: string; idea: string }>;
  /** Notes with an idea, out of all. */
  ideas: number;
}

/** One problem, with why it ranks where it does and two notes picked at random. Null when it has no note left. */
export async function reportProblem(id: string, now: Date = new Date()): Promise<ProblemDetail | null> {
  const [row] = await countedProblems(Prisma.sql`p.id = ${id}`, now);
  if (!row) return null;
  const base = rowOf(row);
  const priority = countsOf(row);
  const [sample, ideas] = await Promise.all([
    prisma.$queryRaw<Array<{ tried: string; stopped: string; idea: string }>>(Prisma.sql`
      SELECT tried, stopped, idea FROM brick_report_notes
      WHERE problem_id = ${id} AND taken_back_at IS NULL AND (tried <> '' OR stopped <> '' OR idea <> '')
      ORDER BY random() LIMIT 2`),
    prisma.brickReportNote.count({ where: { problemId: id, takenBackAt: null, idea: { not: '' } } }),
  ]);
  return { ...base, reasons: priority.reasons, sample, ideas };
}

/** Moves a problem to another tab. Moving it to Fixed clears "came back": a note after that marks it again. */
export async function setReportState(id: string, state: ReportState, now: Date = new Date()): Promise<boolean> {
  const moved = await prisma.brickReportProblem.updateMany({
    where: { id },
    data: { state, stateAt: now, ...(state === 'fixed' ? { cameBack: false } : {}) },
  });
  return moved.count > 0;
}
