import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { sweepStaleReservations, sweepVoiceNoteBuffers } from '@/lib/voice-note-turns';

/**
 * What a listening provider still holds after a voice note was heard (game: every bot hears voice notes, plan v3 section 6): a file
 * and a transcription, each deleted on its own (Soniox deletes neither with the other, and a transcription still being made can't
 * be deleted yet). The bot server adds a job for each, asks for the jobs that are due, deletes, and says what the provider answered:
 * - a 2xx or 404: gone, done;
 * - a 409: still being made, tried again in 30 seconds;
 * - anything else, or no answer: tried again later, waiting twice as long each time, up to an hour.
 * A job still not done after a day is told to the engineers once. A job names the provider, never its key; the key is read when
 * the job is handed out, and a job whose provider or key is gone is set aside. Usage never waits on any of this.
 *
 * A job handed out carries `lease`, the time its hold ends, and only an answer with that same `lease` settles it: a bot server
 * that ran past its hold and answers late can't undo the job another bot server has taken since (409).
 */

export class VoiceNoteCleanupError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

export const CLEANUP_LEASE_MS = 2 * 60_000;
const BUSY_RETRY_MS = 30_000;
const FIRST_RETRY_MS = 30_000;
const LONGEST_RETRY_MS = 60 * 60_000;
const OVERDUE_MS = 24 * 60 * 60_000;

const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new VoiceNoteCleanupError(`${name} is required`, 400);
  return value.trim();
};

/** Adds a job for one object at a provider. The same object twice is one job. */
export async function addVoiceNoteCleanup(input: { providerId?: unknown; region?: unknown; kind?: unknown; objectId?: unknown }): Promise<{ id: string }> {
  const providerId = text(input.providerId, 'providerId', 64);
  const objectId = text(input.objectId, 'objectId', 255);
  if (input.kind !== 'file' && input.kind !== 'transcription') throw new VoiceNoteCleanupError('kind must be file or transcription', 400);
  const region = input.region === undefined || input.region === null ? null : text(input.region, 'region', 50);
  const row = await prisma.voiceNoteCleanup.upsert({
    where: { providerId_kind_objectId: { providerId, kind: input.kind, objectId } },
    create: { providerId, kind: input.kind, objectId, region },
    update: {},
    select: { id: true },
  });
  return row;
}

export interface CleanupJob {
  id: string;
  kind: 'file' | 'transcription';
  objectId: string;
  /** Sent back when settling: only the bot server holding the job now can settle it. */
  lease: string;
  provider: { id: string; adapter: string; endpoint: string | null; region: string | null; apiKeyEncrypted: string };
}

/**
 * Hands out up to `limit` jobs that are due, each held for 2 minutes, transcriptions before files (a file goes once its
 * transcription has). Also deletes the kept answers whose time is over and gives back reservations never started, since the bot
 * server asks here every minute or so.
 */
export async function claimVoiceNoteCleanups(input: { limit?: unknown }, now: Date = new Date()): Promise<CleanupJob[]> {
  const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 10;
  await sweepVoiceNoteBuffers(now);
  await sweepStaleReservations(now);
  const due = await prisma.voiceNoteCleanup.findMany({
    where: { state: 'pending', nextAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    orderBy: [{ kind: 'desc' }, { nextAt: 'asc' }],
    take: limit,
  });
  if (due.length === 0) return [];
  const providers = new Map(
    (await prisma.voiceProvider.findMany({ where: { id: { in: [...new Set(due.map((job) => job.providerId))] } } })).map((row) => [row.id, row])
  );
  const jobs: CleanupJob[] = [];
  for (const job of due) {
    const row = providers.get(job.providerId);
    if (!row || !row.apiKeyEncrypted) {
      // Nobody can delete it with a key that is gone; the provider's own retention ends it
      await prisma.voiceNoteCleanup.updateMany({ where: { id: job.id, state: 'pending' }, data: { state: 'orphaned', leaseUntil: null } });
      continue;
    }
    // Checked again as it is taken: a job another bot server settled since it was read waits for its new time
    const leaseUntil = new Date(now.getTime() + CLEANUP_LEASE_MS);
    const taken = await prisma.voiceNoteCleanup.updateMany({
      where: { id: job.id, state: 'pending', nextAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { leaseUntil },
    });
    if (taken.count === 0) continue;
    jobs.push({
      id: job.id,
      kind: job.kind as CleanupJob['kind'],
      objectId: job.objectId,
      lease: leaseUntil.toISOString(),
      provider: { id: row.id, adapter: row.adapter, endpoint: row.endpoint, region: job.region ?? row.region, apiKeyEncrypted: row.apiKeyEncrypted },
    });
  }
  return jobs;
}

/** What the provider answered a delete with: `status`, or `failed: true` when there was no answer, with the job's `lease`. */
export async function settleVoiceNoteCleanup(id: string, input: { status?: unknown; failed?: unknown; lease?: unknown }, now: Date = new Date()): Promise<{ id: string; state: string; nextAt: string | null }> {
  const job = await prisma.voiceNoteCleanup.findUnique({ where: { id: text(id, 'id', 64) } });
  if (!job) throw new VoiceNoteCleanupError('Cleanup not found', 404);
  if (job.state !== 'pending') return { id: job.id, state: job.state, nextAt: null };
  const status = input.status;
  if (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599)) throw new VoiceNoteCleanupError('status must be an HTTP status', 400);
  if (status === undefined && input.failed !== true) throw new VoiceNoteCleanupError('status or failed is required', 400);
  const lease = new Date(text(input.lease, 'lease', 40));
  if (Number.isNaN(lease.getTime())) throw new VoiceNoteCleanupError('lease must be the time the job was handed out with', 400);
  // Only the bot server holding the job now: the same hold it was handed, still pending
  const held = { id: job.id, state: 'pending', leaseUntil: lease };
  const fenced = (count: number) => {
    if (count === 0) throw new VoiceNoteCleanupError('Another bot server has this cleanup now', 409);
  };

  if (typeof status === 'number' && ((status >= 200 && status < 300) || status === 404)) {
    fenced((await prisma.voiceNoteCleanup.updateMany({ where: held, data: { state: 'done', doneAt: now, leaseUntil: null, lastStatus: status, attempts: { increment: 1 } } })).count);
    return { id: job.id, state: 'done', nextAt: null };
  }
  const attempts = job.attempts + 1;
  const wait = status === 409 ? BUSY_RETRY_MS : Math.min(FIRST_RETRY_MS * 2 ** Math.min(job.attempts, 20), LONGEST_RETRY_MS);
  const nextAt = new Date(now.getTime() + wait);
  const overdue = !job.overdue && now.getTime() - job.createdAt.getTime() > OVERDUE_MS;
  fenced(
    (
      await prisma.voiceNoteCleanup.updateMany({
        where: held,
        data: { attempts, nextAt, leaseUntil: null, lastStatus: typeof status === 'number' ? status : null, ...(overdue ? { overdue: true } : {}) },
      })
    ).count
  );
  if (overdue) {
    const line = `A voice note's ${job.kind} at provider ${job.providerId} is still not deleted after a day (${attempts} tries, last answer ${typeof status === 'number' ? status : 'none'})`;
    console.error(`[VoiceNotes] ${line}`);
    Sentry.captureMessage(line, { level: 'warning', tags: { area: 'voice-notes' } });
  }
  return { id: job.id, state: 'pending', nextAt: nextAt.toISOString() };
}
