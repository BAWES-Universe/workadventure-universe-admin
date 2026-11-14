import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { brickOf } from '@/lib/computer';
import { getComputerProvider } from '@/lib/computer-provider';

/**
 * The desktop gateway's half in Orbit (build handoff v2, section 4). The screen is shown through the bot server, which can hold a
 * WebSocket (Orbit runs on plain `next start` and cannot). Orbit decides, the bot server carries:
 *
 *  - A person's page asks for a TICKET for their own Brick's screen. A ticket is worth 60 seconds to open one socket and nothing else.
 *  - The bot server gives the ticket to `openScreen`, which looks again at everything (who, the job, who has the keyboard) and, only
 *    if all of it still holds, mints Agent37's own 60-second link for the machine. The Agent37 link never reaches a browser.
 *  - While a socket is open the bot server asks `checkScreen` every few seconds: the moment the job is over, the machine is not
 *    working, or the person handed the keyboard back, the answer is no and the socket is closed on both sides.
 *
 * Two modes. WATCH is the default; the bot server drops every key, pointer and clipboard message the viewer sends. INPUT is only for the
 * person who has taken over, and only for that take over: a new take over (or a hand back) moves the job's control generation, so an
 * old input ticket is dead. Nothing here ever wakes a machine: it only looks.
 */

/** A ticket is worth this long for opening a socket. */
export const TICKET_OPEN_MS = 60_000;
/** A socket is never kept longer than this, whatever the state. */
export const SCREEN_MAX_MS = 2 * 60 * 60 * 1000;
/** How often the bot server asks whether an open socket may go on. */
export const CHECK_EVERY_MS = 5_000;

export type ScreenMode = 'watch' | 'input';

interface Payload {
  /** Brick */
  b: string;
  /** The person */
  p: string;
  m: ScreenMode;
  /** Issued at, ms. */
  i: number;
  /** For input: the job the person has taken over, and its control generation. */
  j?: string;
  g?: number;
}

const PREFIX = 'sct1';

function key(): Buffer {
  const secret = (process.env.BOT_SERVICE_TOKEN ?? '').trim();
  if (!secret) throw new Error('No key to sign screen tickets with');
  return createHmac('sha256', 'universe-screen-ticket').update(secret).digest();
}

const sign = (body: string) => createHmac('sha256', key()).update(body).digest('base64url');

function seal(payload: Payload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${PREFIX}.${body}.${sign(body)}`;
}

function unseal(ticket: unknown): Payload | null {
  if (typeof ticket !== 'string' || ticket.length > 1000) return null;
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const expected = Buffer.from(sign(parts[1]));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Payload;
    if (typeof value.b !== 'string' || typeof value.p !== 'string' || (value.m !== 'watch' && value.m !== 'input') || typeof value.i !== 'number') return null;
    if (value.m === 'input' && (typeof value.j !== 'string' || typeof value.g !== 'number')) return null;
    return value;
  } catch {
    return null;
  }
}

type Looked =
  | { ok: true; ref: string; mode: ScreenMode }
  | { ok: false; reason: 'not_found' | 'resting' | 'not_taken_over' };

/** What is true now about a Brick's screen for this person and mode. Reads only. */
async function look(botId: string, personId: string, mode: ScreenMode, input?: { jobId: string; generation: number }): Promise<Looked> {
  if (!(await brickOf(botId, personId))) return { ok: false, reason: 'not_found' };
  const row = await prisma.brickComputer.findUnique({ where: { botId } });
  if (!row || !row.enabled || !row.providerRef || row.machine !== 'working') return { ok: false, reason: 'resting' };
  if (mode === 'input') {
    const jobs = await prisma.computerJob.findMany({ where: { botId, status: 'waiting', control: 'person' }, select: { id: true, controlGeneration: true } });
    const mine = input ? jobs.find((job) => job.id === input.jobId && job.controlGeneration === input.generation) : jobs[0];
    return mine ? { ok: true, ref: row.providerRef, mode } : { ok: false, reason: 'not_taken_over' };
  }
  if ((await prisma.computerJob.count({ where: { botId, status: { in: ['running', 'waiting'] } } })) === 0) return { ok: false, reason: 'resting' };
  return { ok: true, ref: row.providerRef, mode };
}

export type Ticketed = { ok: true; ticket: string; mode: ScreenMode; expiresAt: Date } | { ok: false; reason: 'not_found' | 'resting' | 'not_taken_over' };

/** A ticket for the owner's own Brick: watch by default, input only while they have taken over. */
export async function screenTicket(botId: string, personId: string, mode: ScreenMode = 'watch', now: Date = new Date()): Promise<Ticketed> {
  let jobId: string | undefined;
  let generation: number | undefined;
  if (mode === 'input') {
    const mine = await prisma.computerJob.findFirst({ where: { botId, status: 'waiting', control: 'person' }, orderBy: { createdAt: 'asc' }, select: { id: true, controlGeneration: true } });
    jobId = mine?.id;
    generation = mine?.controlGeneration;
  }
  const looked = await look(botId, personId, mode, jobId && generation !== undefined ? { jobId, generation } : undefined);
  if (!looked.ok) return looked;
  const payload: Payload = { b: botId, p: personId, m: mode, i: now.getTime(), ...(mode === 'input' ? { j: jobId, g: generation } : {}) };
  return { ok: true, ticket: seal(payload), mode, expiresAt: new Date(now.getTime() + TICKET_OPEN_MS) };
}

export type Opened = { ok: true; upstream: string; mode: ScreenMode; checkEveryMs: number; maxMs: number } | { ok: false; reason: 'invalid' | 'expired' | 'not_found' | 'resting' | 'not_taken_over' };

/** The bot server opens a socket with a ticket: everything is looked at again, and Agent37's own link is made here, for this socket only. */
export async function openScreen(ticket: unknown, now: Date = new Date()): Promise<Opened> {
  const payload = unseal(ticket);
  if (!payload) return { ok: false, reason: 'invalid' };
  if (now.getTime() - payload.i > TICKET_OPEN_MS || payload.i - now.getTime() > 5_000) return { ok: false, reason: 'expired' };
  const looked = await look(payload.b, payload.p, payload.m, payload.m === 'input' ? { jobId: payload.j as string, generation: payload.g as number } : undefined);
  if (!looked.ok) return looked;
  const provider = getComputerProvider();
  // Looking never wakes: a machine that is not running has no link
  const session = provider ? await provider.watch(looked.ref).catch(() => null) : null;
  if (!session) return { ok: false, reason: 'resting' };
  return { ok: true, upstream: session.url, mode: payload.m, checkEveryMs: CHECK_EVERY_MS, maxMs: SCREEN_MAX_MS };
}

export type Checked = { ok: true; mode: ScreenMode } | { ok: false; reason: 'invalid' | 'too_long' | 'not_found' | 'resting' | 'not_taken_over' };

/** Asked while a socket is open. A no closes it. The ticket's own 60 seconds do not apply any more: it was opened in time. */
export async function checkScreen(ticket: unknown, now: Date = new Date()): Promise<Checked> {
  const payload = unseal(ticket);
  if (!payload) return { ok: false, reason: 'invalid' };
  if (now.getTime() - payload.i > TICKET_OPEN_MS + SCREEN_MAX_MS) return { ok: false, reason: 'too_long' };
  const looked = await look(payload.b, payload.p, payload.m, payload.m === 'input' ? { jobId: payload.j as string, generation: payload.g as number } : undefined);
  return looked.ok ? { ok: true, mode: payload.m } : looked;
}
