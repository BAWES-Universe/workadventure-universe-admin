import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isOver } from '@/lib/computer-values';
import { agentMayAct } from '@/lib/computer-control';
import { cutoffLockKey, hasFinishIntent, hasPoolCutoff } from '@/lib/computer-faults';
import { epochMatches, lockJobRow, type EpochSaid } from '@/lib/computer-owner';

/**
 * The key a job's computer holds (build handoff v2, section 5). It is the computer's only credential, and it grants nothing by
 * itself: Orbit keeps its digest, and when it is used the job, the Brick, the person who pays and what is allowed are read from
 * Orbit's own records. A name or id the agent supplies is never taken as authority.
 *
 *  - Short-lived: 15 minutes, renewed by the job's own lease (`renewJobTokens`), so a computer that went quiet loses it.
 *  - Revocable: it ends with the job, and when the person takes over (the job's control generation moves), so a call the agent had
 *    in flight is refused after the fence.
 *  - Scoped: "model" is a model call and nothing else; "git" is the computer's login to the git relay and nothing else (it is the same
 *    kind of key, so the take-over, the end of the job and the lease treat both alike). Other scopes are added with the parts that use them.
 */

export type TokenScope = 'model' | 'git';

/** How long a key lives without the job's lease renewing it. */
export const TOKEN_LIFE_MS = 15 * 60 * 1000;
/** How often a runner is told to renew at most: a fraction of the shortest lease it keeps alive (the key), never of the room size, so a key never lapses between two renewals. */
export const TOKEN_RENEW_EVERY_SECONDS = Math.floor((TOKEN_LIFE_MS / 1000) * 0.4);

const PREFIX = 'cjt_';
const digestOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** A job that holds the machine, whoever has the keyboard: only these may have a key. */
const live = (status: string) => status === 'running' || status === 'waiting';

export type Minted = { ok: true; token: string; expiresAt: Date; /** The ownership epoch the key was made under. */ epoch: number } | { ok: false; reason: 'not_found' | 'not_running' | 'finish_pending' | 'superseded' | 'preparing' };

/** Who a key is made for: the worker that owns the job (`epoch`, the one it says; none = a worker that knows none, good only while the job has none), and, for a prepare, the claim it holds. */
export interface MintFor {
  epoch: EpochSaid;
  /** The prepare claim the caller holds (`prepare_claimed_at`): the key is made only while it still holds it, read in the same transaction. */
  prepareClaim?: Date;
}

/**
 * Makes a key for a running job. The key is shown once, here; only its digest is kept. With `under`, the key is only made for the job as
 * it stood when the caller looked (running, the same control generation): a job the person took over meanwhile gets none, and one that
 * was made just before the take-over is ended again.
 *
 * ONE transaction, under the job's cutoff lock with its row locked, decides whether the key is made at all (GPT round 5, E1): the caller owns the job (`owner.epoch` is the job's owner epoch), the control generation is the one it looked at, the prepare
 * claim it holds is still the job's, no finish intent is kept and no pool cutoff is decided. A key that is not made leaves nothing behind (`superseded` when another worker owns the job, `preparing` when the claim moved) and never touches another
 * owner's keys. A key that is made is stamped with the epoch, and a prepare's key ends the older keys of the SAME epoch in the same commit (one key is good at a time for the owner), never the keys of another epoch.
 */
export async function mintJobToken(jobId: string, scope: TokenScope, now: Date = new Date(), under?: { generation: number }, owner: MintFor = { epoch: undefined }): Promise<Minted> {
  const read = () => prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true, status: true, controlGeneration: true } });
  const fits = (job: { status: string; controlGeneration: number }) => (under ? job.status === 'running' && job.controlGeneration === under.generation : live(job.status));
  const job = await read();
  if (!job) return { ok: false, reason: 'not_found' };
  if (!fits(job) || !(await agentMayAct(job.botId))) return { ok: false, reason: 'not_running' };
  const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + TOKEN_LIFE_MS);
  const digest = digestOf(token);
  // A pool cutoff refuses a model key only (the other scopes are not ours to refuse for it); an intent refuses a key of every scope (a git key is a way to act outside too). Database steps only.
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;
      const row = await lockJobRow(tx, jobId);
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      if (!fits(row)) return { ok: false as const, reason: 'not_running' as const };
      if (!epochMatches(row.ownerEpoch, owner.epoch)) return { ok: false as const, reason: 'superseded' as const };
      if (owner.prepareClaim && (await tx.computerJob.count({ where: { id: jobId, prepareClaimedAt: owner.prepareClaim } })) !== 1) return { ok: false as const, reason: 'preparing' as const };
      if (scope === 'model' && (await hasPoolCutoff(tx, jobId))) return { ok: false as const, reason: 'not_running' as const };
      if (await hasFinishIntent(tx, jobId)) return { ok: false as const, reason: 'finish_pending' as const };
      await tx.computerJobToken.create({ data: { jobId, scope, generation: row.controlGeneration, digest, expiresAt, ownerEpoch: row.ownerEpoch } });
      // A prepare's model key is the owner's one good key: this owner's older keys end with it, in the same commit. Another owner's keys are never touched (they are not this one's to end)
      if (owner.prepareClaim) {
        await tx.computerJobToken.updateMany({ where: { jobId, revokedAt: null, digest: { not: digest }, OR: [{ ownerEpoch: row.ownerEpoch }, ...(row.ownerEpoch === 0 ? [{ ownerEpoch: null }] : [])] }, data: { revokedAt: now } });
      }
      return { ok: true as const, epoch: row.ownerEpoch };
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
  if (!result.ok) return result;
  if (under) {
    // A take-over that came between the look and the key ends this key too: the fence only revokes the keys that existed when it ran
    const again = await read();
    if (!again || !fits(again) || !(await agentMayAct(again.botId))) {
      await prisma.computerJobToken.updateMany({ where: { digest, revokedAt: null }, data: { revokedAt: now } });
      return { ok: false, reason: 'not_running' };
    }
  }
  return { ok: true, token, expiresAt, epoch: result.epoch };
}

export type Verified =
  | { ok: true; jobId: string; botId: string; personId: string; tokenId: string; generation: number; /** The owner epoch the key was made under (the job's own, by the check below). */ epoch: number }
  /** Not a key we made, a key that ended, or one for another scope: the same answer for all, so a guess learns nothing. */
  | { ok: false; reason: 'refused' };

/**
 * Whether a key may act now: it exists, is for this scope, was not revoked, has not run out, belongs to a job that still holds the
 * machine, and was made under the job's CURRENT control generation. `db` is the caller's transaction when it asks while holding one, so the look never waits for a second connection.
 */
export async function verifyJobToken(token: string, scope: TokenScope, now: Date = new Date(), db: Pick<Prisma.TransactionClient, 'computerJobToken' | 'brickComputer'> = prisma): Promise<Verified> {
  if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 200) return { ok: false, reason: 'refused' };
  const row = await db.computerJobToken.findUnique({ where: { digest: digestOf(token) }, include: { job: { select: { id: true, botId: true, personId: true, status: true, controlGeneration: true, ownerEpoch: true } } } });
  if (!row || row.scope !== scope || row.revokedAt !== null || row.expiresAt <= now) return { ok: false, reason: 'refused' };
  if (isOver(row.job.status) || !live(row.job.status) || row.generation !== row.job.controlGeneration) return { ok: false, reason: 'refused' };
  // A key made under another owner (an older epoch) is not good: the job has one owner, and its keys are the owner's (a key that predates epochs counts as epoch 0)
  if ((row.ownerEpoch ?? 0) !== row.job.ownerEpoch) return { ok: false, reason: 'refused' };
  // Control is not Brick's while it changes hands (or while the person holds it): a key made earlier does nothing then
  if (!(await agentMayAct(row.job.botId, db))) return { ok: false, reason: 'refused' };
  return { ok: true, jobId: row.job.id, botId: row.job.botId, personId: row.job.personId, tokenId: row.id, generation: row.generation, epoch: row.job.ownerEpoch };
}

/** Every key of a job ends: the job is over, or the person took the machine. Safe to say twice. */
export async function revokeJobTokens(jobId: string, now: Date = new Date(), onlyWhile?: { prepareClaim?: Date; /** Only the keys of this owner epoch (a key that predates epochs counts as 0): another owner's keys are not this caller's to end. */ epoch?: number }, db: Pick<Prisma.TransactionClient, 'computerJobToken'> = prisma): Promise<number> {
  // `onlyWhile`: a prepare that holds the job's claim ends the keys only while it still holds it, in the same statement as the check, so one that
  // paused past its claim (another took it and made a key) never ends the key that was made since
  const { count } = await db.computerJobToken.updateMany({ where: { jobId, revokedAt: null, ...(onlyWhile?.prepareClaim ? { job: { prepareClaimedAt: onlyWhile.prepareClaim } } : {}), ...(onlyWhile?.epoch !== undefined ? { OR: [{ ownerEpoch: onlyWhile.epoch }, ...(onlyWhile.epoch === 0 ? [{ ownerEpoch: null }] : [])] } : {}) }, data: { revokedAt: now } });
  return count;
}

/** Ends one key by itself (the one a caller made and must not leave good). Safe to say twice. */
export async function revokeToken(token: string, now: Date = new Date()): Promise<void> {
  await prisma.computerJobToken.updateMany({ where: { digest: digestOf(token), revokedAt: null }, data: { revokedAt: now } });
}

/** The job's lease renewed: its keys that are still good live another 15 minutes. A key that ended is not brought back. */
export async function renewJobTokens(jobId: string, now: Date = new Date(), epoch?: number, db: Pick<Prisma.TransactionClient, 'computerJobToken'> = prisma): Promise<number> {
  // Only the keys of the owner's epoch live on: with `epoch` named, a key of another epoch is never renewed by this owner's lease
  const { count } = await db.computerJobToken.updateMany({ where: { jobId, revokedAt: null, expiresAt: { gt: now }, ...(epoch === undefined ? {} : { OR: [{ ownerEpoch: epoch }, ...(epoch === 0 ? [{ ownerEpoch: null }] : [])] }) }, data: { expiresAt: new Date(now.getTime() + TOKEN_LIFE_MS) } });
  return count;
}

/** Keys that ended long ago are removed so the table stays small. Returns how many. */
export async function forgetOldTokens(now: Date = new Date(), olderThanMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const before = new Date(now.getTime() - olderThanMs);
  const { count } = await prisma.computerJobToken.deleteMany({ where: { OR: [{ revokedAt: { lt: before } }, { expiresAt: { lt: before } }] } });
  return count;
}
