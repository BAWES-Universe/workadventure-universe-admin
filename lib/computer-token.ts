import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { isOver } from '@/lib/computer-values';

/**
 * The key a job's computer holds (build handoff v2, section 5). It is the computer's only credential, and it grants nothing by
 * itself: Orbit keeps its digest, and when it is used the job, the Brick, the person who pays and what is allowed are read from
 * Orbit's own records. A name or id the agent supplies is never taken as authority.
 *
 *  - Short-lived: 15 minutes, renewed by the job's own lease (`renewJobTokens`), so a computer that went quiet loses it.
 *  - Revocable: it ends with the job, and when the person takes over (the job's control generation moves), so a call the agent had
 *    in flight is refused after the fence.
 *  - Scoped: "model" is a model call and nothing else. Other scopes are added with the parts that use them.
 */

export type TokenScope = 'model';

/** How long a key lives without the job's lease renewing it. */
export const TOKEN_LIFE_MS = 15 * 60 * 1000;
/** How often a runner is told to renew at most: a fraction of the shortest lease it keeps alive (the key), never of the room size, so a key never lapses between two renewals. */
export const TOKEN_RENEW_EVERY_SECONDS = Math.floor((TOKEN_LIFE_MS / 1000) * 0.4);

const PREFIX = 'cjt_';
const digestOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** A job that holds the machine, whoever has the keyboard: only these may have a key. */
const live = (status: string) => status === 'running' || status === 'waiting';

export type Minted = { ok: true; token: string; expiresAt: Date } | { ok: false; reason: 'not_found' | 'not_running' };

/** Makes a key for a running job. The key is shown once, here; only its digest is kept. */
export async function mintJobToken(jobId: string, scope: TokenScope, now: Date = new Date()): Promise<Minted> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, controlGeneration: true } });
  if (!job) return { ok: false, reason: 'not_found' };
  if (!live(job.status)) return { ok: false, reason: 'not_running' };
  const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + TOKEN_LIFE_MS);
  await prisma.computerJobToken.create({ data: { jobId, scope, generation: job.controlGeneration, digest: digestOf(token), expiresAt } });
  return { ok: true, token, expiresAt };
}

export type Verified =
  | { ok: true; jobId: string; botId: string; personId: string; tokenId: string; generation: number }
  /** Not a key we made, a key that ended, or one for another scope: the same answer for all, so a guess learns nothing. */
  | { ok: false; reason: 'refused' };

/**
 * Whether a key may act now: it exists, is for this scope, was not revoked, has not run out, belongs to a job that still holds the
 * machine, and was made under the job's CURRENT control generation.
 */
export async function verifyJobToken(token: string, scope: TokenScope, now: Date = new Date()): Promise<Verified> {
  if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 200) return { ok: false, reason: 'refused' };
  const row = await prisma.computerJobToken.findUnique({ where: { digest: digestOf(token) }, include: { job: { select: { id: true, botId: true, personId: true, status: true, controlGeneration: true } } } });
  if (!row || row.scope !== scope || row.revokedAt !== null || row.expiresAt <= now) return { ok: false, reason: 'refused' };
  if (isOver(row.job.status) || !live(row.job.status) || row.generation !== row.job.controlGeneration) return { ok: false, reason: 'refused' };
  return { ok: true, jobId: row.job.id, botId: row.job.botId, personId: row.job.personId, tokenId: row.id, generation: row.generation };
}

/** Every key of a job ends: the job is over, or the person took the machine. Safe to say twice. */
export async function revokeJobTokens(jobId: string, now: Date = new Date()): Promise<number> {
  const { count } = await prisma.computerJobToken.updateMany({ where: { jobId, revokedAt: null }, data: { revokedAt: now } });
  return count;
}

/** The job's lease renewed: its keys that are still good live another 15 minutes. A key that ended is not brought back. */
export async function renewJobTokens(jobId: string, now: Date = new Date()): Promise<number> {
  const { count } = await prisma.computerJobToken.updateMany({ where: { jobId, revokedAt: null, expiresAt: { gt: now } }, data: { expiresAt: new Date(now.getTime() + TOKEN_LIFE_MS) } });
  return count;
}

/** Keys that ended long ago are removed so the table stays small. Returns how many. */
export async function forgetOldTokens(now: Date = new Date(), olderThanMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const before = new Date(now.getTime() - olderThanMs);
  const { count } = await prisma.computerJobToken.deleteMany({ where: { OR: [{ revokedAt: { lt: before } }, { expiresAt: { lt: before } }] } });
  return count;
}
