import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Brick reports (mock "Brick reports inbox"): when a Brick can't do something, gets something wrong, or has an idea, it sends a short note
 * to the Universe team. Notes that read alike join one problem, and the inbox counts and ranks problems across every Brick. No words from
 * chats: the Brick is told to write in general words, the bot server refuses a note that repeats the person, and Orbit removes emails,
 * phone numbers, links, @names and long numbers before anything is kept. People are counted as a one-way hash, never stored. The Brick
 * is kept only to tell its owner when a fix ships; no screen shows which Brick, owner, world or room sent a note.
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
const LINK = /\b(?:https?:\/\/|www\.)\S+/giu;
const DOMAIN = /\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|io|co|ai|app|dev|me|info|biz|xyz|ly|gg|tv|edu|gov|uk|us|de|fr|sa|kw|ae|th|in|ru|cn|jp|kr|br|au|ca|eu|site|online|store|shop|link|page|so|sh|to|cc)\b(?:\/\S*)?/giu;
const AT_NAME = /(^|[^\p{L}\p{N}_])@[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/gu;
/** Seven or more digits with the spaces, dashes, dots and brackets a phone number is written with. */
const PHONE = /\+?\(?\d[\d\s().-]{5,}\d/g;
const LONG_NUMBER = /\d{5,}/g;

/**
 * A note's text with nothing that points at a person or a place: emails, links (with or without https://), @names, phone numbers and
 * numbers of five digits or more are removed. Spaces are folded and the text is cut to `max` characters, never inside one.
 */
export function cleanReportText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  let text = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  text = text.replace(EMAIL, ' ').replace(LINK, ' ').replace(DOMAIN, ' ').replace(AT_NAME, '$1 ');
  text = text.replace(PHONE, (match) => (match.replace(/\D/g, '').length >= 7 ? ' ' : match)).replace(LONG_NUMBER, ' ');
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

const personHash = (key: string) => createHash('sha256').update(`brick-report:${key}`).digest('hex').slice(0, 32);
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
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { id: true } });
  if (!bot) return { sent: false, reason: 'unknown_brick' };

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
    const problemId = best
      ? (
          await tx.brickReportProblem.update({
            where: { id: best.id },
            data: { lastSeenAt: now, ...(best.state === 'fixed' ? { state: 'new', cameBack: true, stateAt: now } : {}) },
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

/** Takes a note back, for anyone in the chat that holds its key, within TAKE_BACK_MS of sending. Taking it back twice is fine. */
export async function takeBackReportNote(id: string, key: string, now: Date = new Date()): Promise<TakeBackOutcome> {
  const row = await prisma.brickReportNote.findUnique({ where: { id }, select: { takeBackHash: true, takenBackAt: true, createdAt: true } });
  const given = Buffer.from(keyHash(key), 'hex');
  const held = row ? Buffer.from(row.takeBackHash, 'hex') : null;
  if (!row || !held || held.length !== given.length || !timingSafeEqual(held, given)) return { takenBack: false, reason: 'not_found' };
  if (row.takenBackAt) return { takenBack: true };
  if (now.getTime() - row.createdAt.getTime() > TAKE_BACK_MS) return { takenBack: false, reason: 'too_late' };
  // Only a note not taken back yet: a second tap racing the first changes nothing
  await prisma.brickReportNote.updateMany({ where: { id, takenBackAt: null }, data: { takenBackAt: now } });
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

/** The priority of a problem and why, from its counts: 3 a Brick, 2 a person, 5 if it stopped the work, 3 if rising, 6 if it came back. */
export function priorityOf(counts: { bricks: number; people: number; stoppedWork: boolean; thisWeek: number; lastWeek: number; cameBack: boolean }): {
  score: number;
  level: Level;
  rising: boolean;
  reasons: Reason[];
} {
  // Half again more than last week, and last week had some: a problem first seen this week is new, not rising
  const rising = counts.lastWeek > 0 && counts.thisWeek >= counts.lastWeek * 1.5;
  const reasons: Reason[] = [];
  if (counts.stoppedWork) reasons.push({ label: 'Stopped the work', points: 5 });
  if (counts.bricks > 0) reasons.push({ label: plural(counts.bricks, 'Brick', 'Bricks'), points: 3 * counts.bricks });
  if (counts.people > 0) reasons.push({ label: plural(counts.people, 'person', 'people'), points: 2 * counts.people });
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
  people: number;
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
      (COUNT(DISTINCT n.person_key))::int AS people,
      (COUNT(*))::int AS times,
      (COUNT(*) FILTER (WHERE n.created_at >= ${weekAgo}))::int AS this_week,
      (COUNT(*) FILTER (WHERE n.created_at >= ${twoWeeksAgo} AND n.created_at < ${weekAgo}))::int AS last_week,
      COALESCE(BOOL_OR(n.effect = 'stopped'), FALSE) AS stopped
    FROM brick_report_problems p JOIN brick_report_notes n ON n.problem_id = p.id AND n.taken_back_at IS NULL
    WHERE ${where}
    GROUP BY p.id`);
}

function rowOf(row: CountRow): ProblemRow {
  const priority = priorityOf({ bricks: row.bricks, people: row.people, stoppedWork: row.stopped, thisWeek: row.this_week, lastWeek: row.last_week, cameBack: row.came_back });
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
  const priority = priorityOf({ bricks: row.bricks, people: row.people, stoppedWork: row.stopped, thisWeek: row.this_week, lastWeek: row.last_week, cameBack: row.came_back });
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
