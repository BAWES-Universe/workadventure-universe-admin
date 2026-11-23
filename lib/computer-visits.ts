import { prisma } from '@/lib/db';
import type { ComputerProvider } from '@/lib/computer-provider';

/**
 * Where a job's computer browsed, kept for the owner to look at later (R06; build handoff v2 section 4: "every navigation and form post is
 * recorded"). The agent's own stream drops what its tools were given on purpose, and on a public site a form can be posted without signing in
 * to anything, so this is how such a visit or post is still seen afterwards.
 *
 * How it is taken: a small listener on the computer (the image's `universe-visits`, on the browser's DevTools, loopback only) writes one line
 * for each page the browser opened and each post it sent. When a job ends, Orbit reads the lines from the job's own time back in one command
 * (`universe-visits read`), checks every one again, and keeps them under the job. HOST AND PATH ONLY: never a query string, a fragment, a
 * sign-in name in the address, a header or a body; and a path part that looks like a one-time code or a private link is not kept. The
 * machine's word is never trusted as it comes: a line that is not exactly this shape is dropped here, whatever the listener wrote.
 *
 * What it cannot be, said plainly: it is a record for review, not a guard. The agent runs as the same user as the listener, so an agent that
 * works at it can stop or blind the listener; the record then says it is partial (a break in the connection lines, a listener that is no
 * longer running, or lines cut to keep the file small) instead of showing a clean record. Open internet on computers stays as it is.
 *
 * This file is pure except for the three database functions at the end. The take-over notes ("hands") are Orbit's own, written when the
 * fence is proved and when control goes back, so a page the person opened during a take-over is shown as theirs, never as Brick's.
 */

/** The most rows kept for one job (after the same thing in a row is made one row); past it the record says it is partial. */
export const VISITS_MAX = 500;
/** A read starts this long before the job did, because the two clocks are not the same clock: the lines are then cut to the job's own time. */
export const READ_PAD_MS = 120_000;
/** A machine clock further from ours than this makes the record partial: the edges of the job's time cannot be told. */
export const CLOCK_SKEW_MS = 60_000;
const READ_MS = 20_000;
/** A line from the machine is at most this long; a longer one is not one of ours. */
const LINE_MAX = 1000;

export type VisitsState = 'complete' | 'partial' | 'unread' | 'none';
export type VisitKind = 'visit' | 'post';

export interface VisitLine {
  kind: VisitKind;
  /** Milliseconds on the machine's clock. */
  at: number;
  method: string;
  host: string;
  path: string;
  count: number;
  failed: boolean;
  form: boolean;
}
export interface StateLine {
  kind: 'on' | 'off' | 'cut';
  at: number;
  /** For an `off`: false when the browser itself was gone (nothing could be opened), otherwise the browser was still there and unwatched. */
  open?: boolean;
}

export interface ReadBack {
  /** The machine's clock when it answered. */
  now: number | null;
  /** The listener's last connection line before the read began. */
  state: 'on' | 'off' | 'none';
  /** The last connection line before the read, when it was an `off`: the browser was still there (see StateLine.open). */
  stateOpen: boolean;
  alive: boolean;
  lines: Array<VisitLine | StateLine>;
  /** Lines the machine left out because there were too many. */
  more: number;
  /** The answer ended the way it is meant to (`end=1`): an answer cut short is partial. */
  ended: boolean;
}

export interface VisitRow {
  kind: VisitKind;
  at: Date;
  by: 'brick' | 'person';
  method: string;
  host: string;
  path: string;
  count: number;
  failed: boolean;
  form: boolean;
}

// The same rule as the listener's, so what it kept is kept and what it cut stays cut (and a part already cut is the same part again)
const HEX = /^(v[0-9]+-)?[0-9a-fA-F-]{20,}$/;
const TOKEN = /^[A-Za-z0-9_-]{24,}$/;
const PLAIN_TOKEN = /^[A-Za-z0-9]{24,}$/;
const CUT_PART = '\u2026';
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(:[0-9]{1,5})?$/;
const NOT_PATH = /[\u0000-\u0020\u007f]/;

function isCode(value: string): boolean {
  if (HEX.test(value)) return true;
  // A long run of mixed case is a random code (a readable address is lower case with hyphens); a long run with no hyphen that mixes letters and digits is one too
  if (TOKEN.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value)) return true;
  return PLAIN_TOKEN.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/** A part is judged as the page reads it: a code written with percent signs (`%41bC...`, or twice over) is the same code, and so is one behind an encoded slash. */
function part(value: string): string {
  let seen = value;
  for (let round = 0; round < 4; round++) {
    if (seen.split('/').some(isCode)) return CUT_PART;
    let next: string;
    try {
      next = decodeURIComponent(seen);
    } catch {
      // A broken escape: the parts that are whole are judged as they are
      next = seen.replace(/%[0-9a-fA-F]{2}/g, (escape) => {
        try {
          return decodeURIComponent(escape);
        } catch {
          return escape;
        }
      });
    }
    if (next === seen) break;
    seen = next;
  }
  return value;
}

/** A host as the listener writes it (lower case, a port only when it is not the scheme's own), or null for anything else. */
export function cleanHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  const host = value.toLowerCase();
  return host === value && HOST.test(host) ? host : null;
}

/** A path with no query string, no fragment and no one-time code in it, or null for anything that is not a path. */
export function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const bare = value.split('?')[0].split('#')[0];
  if (bare.length === 0 || NOT_PATH.test(bare)) return null;
  return bare.split('/').map(part).join('/').slice(0, 300);
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

function lineOf(text: string): VisitLine | StateLine | null {
  if (text.length > LINE_MAX) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const at = num(entry.at);
  if (at === null) return null;
  if (entry.k === 'on' || entry.k === 'off' || entry.k === 'cut') return entry.k === 'off' ? { kind: 'off', at, open: entry.b !== 0 } : { kind: entry.k, at };
  if (entry.k !== 'visit' && entry.k !== 'post') return null;
  const host = cleanHost(entry.h);
  const path = cleanPath(entry.p);
  const method = typeof entry.m === 'string' && /^[A-Z]{3,8}$/.test(entry.m) ? entry.m : null;
  const count = entry.n === undefined ? 1 : num(entry.n);
  if (!host || !path || !method || !count) return null;
  return { kind: entry.k, at, method, host, path, count: Math.min(count, 1_000_000), failed: entry.f === 1, form: entry.k === 'post' && entry.form === 1 };
}

/** What `universe-visits read` printed. Nothing in it is trusted: a line that is not exactly one of ours is dropped. */
export function parseReadBack(stdout: string): ReadBack {
  const back: ReadBack = { now: null, state: 'none', stateOpen: false, alive: false, lines: [], more: 0, ended: false };
  for (const row of stdout.split('\n')) {
    if (row.startsWith('line=')) {
      const line = lineOf(row.slice(5));
      if (line) back.lines.push(line);
    } else if (row.startsWith('now=')) back.now = num(Number(row.slice(4)));
    else if (row.startsWith('state=')) back.state = row.slice(6) === 'on' ? 'on' : row.slice(6) === 'off' ? 'off' : 'none';
    else if (row.startsWith('open=')) back.stateOpen = row.trim() === 'open=1';
    else if (row.startsWith('alive=')) back.alive = row.trim() === 'alive=1';
    else if (row.startsWith('more=')) back.more = num(Number(row.slice(5))) ?? 0;
    else if (row.trim() === 'end=1') back.ended = true;
  }
  return back;
}

export interface Hands {
  at: Date;
  /** Who has the computer from `at` on. */
  by: 'brick' | 'person';
}

/**
 * The rows a job keeps and how well the record was taken. `before` and `after` are our clock around the read, which tells the machine's clock
 * from ours; the machine's lines are then cut to the job's own time [startedAt, endedAt]. Pure.
 */
export function shapeVisits(input: { back: ReadBack; startedAt: Date; endedAt: Date; before: number; after: number; hands: Hands[] }): { rows: VisitRow[]; state: VisitsState } {
  const { back } = input;
  const offset = back.now === null ? 0 : back.now - Math.round((input.before + input.after) / 2);
  const ours = (at: number) => at - offset;
  const from = input.startedAt.getTime();
  const to = input.endedAt.getTime();
  let partial = !back.ended || back.more > 0 || back.now === null || Math.abs(offset) > CLOCK_SKEW_MS;

  // The listener's connection lines in order: a connection that comes right after a connection is a listener that was stopped and started
  // again without the browser going away, and a cut is lines dropped to keep the file small
  let current = back.state;
  let sawState = back.state !== 'none';
  // While the listener was not connected but the browser was still there, a page could be opened that nobody saw: when that stretch touches
  // the job's time the record is partial. It starts at the `off` line (or before the read, for the state it began with).
  let unseenFrom: number | null = back.state === 'off' && back.stateOpen ? -Infinity : null;
  const hands = [...input.hands].sort((a, b) => a.at.getTime() - b.at.getTime());
  const rows: VisitRow[] = [];
  let lastEra = -1;
  for (const line of back.lines) {
    const at = ours(line.at);
    if (line.kind === 'on' || line.kind === 'off' || line.kind === 'cut') {
      sawState = true;
      if (at >= from && at <= to) {
        if (line.kind === 'cut' || (line.kind === 'on' && current === 'on')) partial = true;
      }
      if (line.kind === 'on' && unseenFrom !== null && at >= from && unseenFrom <= to) partial = true;
      if (line.kind === 'off') unseenFrom = line.open === false ? null : at;
      else if (line.kind === 'on') unseenFrom = null;
      if (line.kind !== 'cut') current = line.kind;
      continue;
    }
    if (at < from || at > to) continue;
    // Only a page or a post is left here (the connection lines were handled above)
    if (line.kind !== 'visit' && line.kind !== 'post') continue;
    let by: 'brick' | 'person' = 'brick';
    // Which stretch between two changes of hands this is: the same page seen on both sides of a take-over is two rows, not one
    let era = 0;
    for (const note of hands) {
      if (note.at.getTime() > at) break;
      by = note.by;
      era++;
    }
    const last = rows[rows.length - 1];
    if (last && era === lastEra && last.kind === line.kind && last.method === line.method && last.host === line.host && last.path === line.path && last.failed === line.failed && last.form === line.form && last.by === by) {
      last.count += line.count;
      continue;
    }
    if (rows.length >= VISITS_MAX) {
      partial = true;
      break;
    }
    lastEra = era;
    rows.push({ kind: line.kind, at: new Date(at), by, method: line.method, host: line.host, path: line.path, count: line.count, failed: line.failed, form: line.form });
  }
  // Still not connected at the end, with the browser there: the rest of the job was not seen
  if (unseenFrom !== null && current === 'off' && unseenFrom <= to) partial = true;
  // A listener that is not running when the job ends was not there for some of it
  if (!back.alive) {
    if (!sawState && rows.length === 0) return { rows, state: 'none' };
    partial = true;
  }
  return { rows, state: partial ? 'partial' : 'complete' };
}

/** What is written for a job that ended: the rows (replacing what an earlier try wrote) and how well the record was taken. */
/** How far a record falls short, so the record of a job that ran in stretches (it was paused) says the worst of its stretches. */
const SHORT_BY: Record<VisitsState, number> = { complete: 0, none: 0, partial: 1, unread: 2 };

async function save(jobId: string, rows: VisitRow[], state: VisitsState, since: Date = new Date(0)): Promise<void> {
  // A job that was paused was read once per stretch: what an earlier stretch kept (before this one began) stays, and the record says the worst of the stretches
  if ((await prisma.computerJobPause.count({ where: { jobId } })) > 0) {
    const kept = (await prisma.computerJob.findUnique({ where: { id: jobId }, select: { visitsState: true } }))?.visitsState as VisitsState | null | undefined;
    if (kept && SHORT_BY[kept] !== undefined && SHORT_BY[kept] > SHORT_BY[state]) state = kept;
  } else {
    since = new Date(0);
  }
  await prisma.$transaction([
    prisma.computerJobVisit.deleteMany({ where: { jobId, kind: { in: ['visit', 'post'] }, at: { gte: since } } }),
    prisma.computerJobVisit.createMany({
      data: rows.map((row) => ({ jobId, kind: row.kind, at: row.at, by: row.by, method: row.method, host: row.host, path: row.path, count: row.count, failed: row.failed, form: row.form })),
    }),
    prisma.computerJob.update({ where: { id: jobId }, data: { visitsState: state } }),
  ]);
}

/**
 * Orbit's own note that control of a Brick's computer changed hands, for every job that is on it: from now on `by` has it. Written once the
 * take-over fence is proved (the person's) and once control goes back (Brick's). Best effort: a note that cannot be written only means a page
 * is shown as Brick's that the person opened, and never stops a change of hands.
 */
export async function noteHands(botId: string, by: 'brick' | 'person', now: Date = new Date()): Promise<void> {
  try {
    const jobs = await prisma.computerJob.findMany({ where: { botId, status: { in: ['running', 'waiting'] } }, select: { id: true } });
    if (jobs.length === 0) return;
    await prisma.computerJobVisit.createMany({ data: jobs.map((job) => ({ jobId: job.id, kind: 'hands', at: now, by })) });
  } catch (error) {
    console.error('[Computer] Could not note who had the computer:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * The job ended while its computer was awake: read where the browser went during it and keep that. Never throws and never holds up the end
 * of the job; a computer that cannot be read leaves "unread", and one from before the recorder existed leaves "none".
 */
export async function recordVisits(job: { id: string; startedAt: Date | null }, provider: ComputerProvider, ref: string, endedAt: Date): Promise<VisitsState | null> {
  if (!job.startedAt) return null;
  try {
    const since = Math.max(0, job.startedAt.getTime() - READ_PAD_MS);
    const before = Date.now();
    const done = await provider.exec(ref, `universe-visits read ${since}`, { timeoutMs: READ_MS });
    const after = Date.now();
    // The program is not on the machine (it was made before this existed): there is no record, and that is said
    if (done.exitCode === 127 || /universe-visits: (command )?not found|No such file or directory/.test(done.stderr)) {
      await save(job.id, [], 'none');
      return 'none';
    }
    if (done.exitCode !== 0 && !/(^|\n)end=1\s*$/.test(done.stdout)) {
      await prisma.computerJob.update({ where: { id: job.id }, data: { visitsState: 'unread' } });
      return 'unread';
    }
    const back = parseReadBack(done.stdout);
    if (done.truncated) back.ended = false;
    const notes = await prisma.computerJobVisit.findMany({ where: { jobId: job.id, kind: 'hands' }, select: { at: true, by: true } });
    const hands: Hands[] = notes.map((note) => ({ at: note.at, by: note.by === 'person' ? 'person' : 'brick' }));
    const shaped = shapeVisits({ back, startedAt: job.startedAt, endedAt, before, after, hands });
    await save(job.id, shaped.rows, shaped.state, new Date(since));
    return shaped.state;
  } catch (error) {
    console.error('[Computer] Could not read where a job’s computer browsed:', error instanceof Error ? error.message : 'unknown');
    await prisma.computerJob.updateMany({ where: { id: job.id, visitsState: null }, data: { visitsState: 'unread' } }).catch(() => undefined);
    return 'unread';
  }
}

/** The most take-over notes one job's view carries; past it the view says it was cut and the record is shown as partial. */
export const HANDS_MAX = 1000;

export interface VisitsView {
  /** How well the record was taken: complete, partial, unread or none; null while the job has not ended. */
  state: VisitsState | null;
  /** True when more notes were kept than are shown here (then `state` is never `complete`). */
  truncated?: boolean;
  items: Array<{ kind: VisitKind | 'hands'; at: Date; by: 'brick' | 'person'; method: string | null; host: string | null; path: string | null; count: number; failed: boolean; form: boolean }>;
}

/** What the owner sees for one job of theirs, oldest first: where the computer's browser went, with the person's take-overs marked. Null when it is not their job. */
export async function visitsFor(botId: string, jobId: string): Promise<VisitsView | null> {
  const job = await prisma.computerJob.findFirst({ where: { id: jobId, botId }, select: { visitsState: true } });
  if (!job) return null;
  // Pages and posts are at most VISITS_MAX when kept; the take-over notes have their own bound, so one kind never pushes the other out of the answer
  const order = [{ at: 'asc' as const }, { id: 'asc' as const }];
  const [seen, handed] = await Promise.all([
    prisma.computerJobVisit.findMany({ where: { jobId, kind: { not: 'hands' } }, orderBy: order, take: VISITS_MAX + 1 }),
    prisma.computerJobVisit.findMany({ where: { jobId, kind: 'hands' }, orderBy: order, take: HANDS_MAX + 1 }),
  ]);
  const truncated = seen.length > VISITS_MAX || handed.length > HANDS_MAX;
  const rows = [...seen.slice(0, VISITS_MAX), ...handed.slice(0, HANDS_MAX)].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = job.visitsState === 'complete' || job.visitsState === 'partial' || job.visitsState === 'unread' || job.visitsState === 'none' ? job.visitsState : null;
  const state = truncated && kept === 'complete' ? 'partial' : kept;
  return {
    state,
    ...(truncated ? { truncated } : {}),
    items: rows.map((row) => ({
      kind: row.kind === 'post' ? 'post' : row.kind === 'hands' ? 'hands' : 'visit',
      at: row.at,
      by: row.by === 'person' ? 'person' : 'brick',
      method: row.method,
      host: row.host,
      path: row.path,
      count: row.count,
      failed: row.failed,
      form: row.form,
    })),
  };
}
