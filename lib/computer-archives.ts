import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { prisma } from '@/lib/db';
import { derivedKey } from '@/lib/encryption';
import { deleteSealed, openSealedStream, storeSealed, type Sealed } from '@/lib/agent37/saved-copies';

/**
 * The versioned copies of a Brick computer's home folder that cold storage keeps (lib/computer-cold.ts).
 *
 * Each copy is one encrypted object (lib/agent37/saved-copies.ts) and one row (`computer_archives`). A copy goes staging -> stored (written whole, its
 * size and SHA-256 known) -> verified (restored on a clean computer and checked file by file). Only a verified copy is ever restored from. The newest
 * two verified copies are kept; everything older, and every copy that failed its check, is deleted. A copy that could not be deleted yet stays as
 * `superseded` and is tried again by the next sweep, so nothing is dropped quietly.
 */

/** How many verified copies a Brick keeps: the newest, and the one before it for the day the newest cannot be restored. */
export const KEEP_VERIFIED = 2;
/** A copy still `staging`, or one that failed, is cleaned up after this long. */
const STALE_MS = 60 * 60 * 1000;
/** A pack-away that said it was alive within this long is still working (kept in step with the pack-away's own take-over time). */
const LIVE_CLAIM_MS = 45 * 60 * 1000;
/** How long a restore address works: one restore on one throwaway or new computer, retries included. */
export const DOWNLOAD_LIFE_MS = 45 * 60 * 1000;

/** Where the objects live. The real one is our encrypted bucket; a test gives an in-memory one. */
export interface ArchiveStore {
  put(finalKey: string, stagingKey: string, archive: ReadableStream<Uint8Array>): Promise<Sealed>;
  open(key: string): Promise<{ stream: Readable; bytes: number }>;
  remove(keys: string[]): Promise<void>;
}

const bucketStore: ArchiveStore = { put: storeSealed, open: openSealedStream, remove: deleteSealed };
let store: ArchiveStore = bucketStore;

/** For tests: keep the copies somewhere else until told otherwise (null puts the bucket back). */
export function setArchiveStoreForTests(replacement: ArchiveStore | null): void {
  store = replacement ?? bucketStore;
}

export type ArchiveState = 'staging' | 'stored' | 'verified' | 'failed' | 'superseded';

export interface ArchiveRow {
  id: string;
  botId: string;
  generation: number;
  state: ArchiveState;
  objectKey: string;
  bytes: number;
  sha256: string | null;
  manifest: unknown;
  imageRevision: number | null;
  createdAt: Date;
  verifiedAt: Date | null;
  proofMs: number | null;
}

type Row = Awaited<ReturnType<typeof prisma.computerArchive.findFirstOrThrow>>;

const view = (row: Row): ArchiveRow => ({
  id: row.id,
  botId: row.botId,
  generation: row.generation,
  state: row.state as ArchiveState,
  objectKey: row.objectKey,
  bytes: Number(row.bytes),
  sha256: row.sha256,
  manifest: row.manifest,
  imageRevision: row.imageRevision,
  createdAt: row.createdAt,
  verifiedAt: row.verifiedAt,
  proofMs: row.proofMs,
});

const objectKeyOf = (botId: string, generation: number, id: string) => `computer-cold/${botId}/${generation}.${id}.ubc`;
const stagingKeyOf = (botId: string, generation: number, id: string) => `computer-cold/${botId}/${generation}.${id}.ubc.new`;

/**
 * Writes the home folder's tar.gz (as the machine streams it) as the Brick's next copy. Throws when the stream was not a whole gzip or the upload did
 * not finish: nothing then stands as a copy, and what was written is deleted. Returns the copy, `stored` (not yet proved).
 */
export async function storeArchive(botId: string, archive: ReadableStream<Uint8Array>, details: { imageRevision?: number | null; manifest?: unknown } = {}): Promise<ArchiveRow> {
  // The purge writes its marker before it reads or deletes any copy, and this copy's row is written before the marker is read again: a Brick purged
  // before the row is seen here, and one purged after is seen by the purge, which finds the row. The marker is looked at again after the upload.
  const purged = async () => (await prisma.brickPurge.count({ where: { botId } })) > 0;
  if (await purged()) throw new Error('The Brick was deleted while its files were being copied');
  // Two writers can pick one generation: the unique index refuses the second, which tries the next number
  for (let attempt = 0; ; attempt++) {
    const newest = await prisma.computerArchive.aggregate({ where: { botId }, _max: { generation: true } });
    const generation = (newest._max.generation ?? 0) + 1 + attempt;
    const id = randomUUID();
    let row: Row;
    try {
      row = await prisma.computerArchive.create({
        data: { id, botId, generation, state: 'staging', objectKey: objectKeyOf(botId, generation, id), imageRevision: details.imageRevision ?? null, manifest: (details.manifest ?? undefined) as never },
      });
    } catch (error) {
      if (attempt < 5 && (error as { code?: string }).code === 'P2002') continue;
      throw error;
    }
    try {
      if (await purged()) throw new Error('The Brick was deleted while its files were being copied');
      const sealed = await store.put(row.objectKey, stagingKeyOf(botId, generation, id), archive);
      // A Brick purged while the copy was written: it must not stand (its row may be gone already, and the object is not to stay without one)
      if (await purged()) throw new Error('The Brick was deleted while its files were being copied');
      const stored = await prisma.computerArchive.update({ where: { id }, data: { state: 'stored', bytes: BigInt(sealed.bytes), sha256: sealed.sha256 } });
      return view(stored);
    } catch (error) {
      await markFailed(id, 'The copy could not be written whole').catch(() => undefined);
      const removed = await store.remove([row.objectKey, stagingKeyOf(botId, generation, id)]).then(() => true, () => false);
      // An object that could not be deleted keeps a row that says so (made again if a purge deleted it), so the clean-up finds it and tries again
      if (!removed) {
        await prisma.computerArchive
          .upsert({ where: { id }, create: { id, botId, generation, state: 'superseded', objectKey: row.objectKey }, update: { state: 'superseded' } })
          .catch(() => undefined);
      }
      throw error;
    }
  }
}

/** The copy was restored on a clean computer and every file matched: it may now be restored from. Says how long the restore took. */
export async function markVerified(id: string, proofMs: number, now: Date = new Date()): Promise<ArchiveRow | null> {
  const done = await prisma.computerArchive.updateMany({ where: { id, state: 'stored' }, data: { state: 'verified', verifiedAt: now, proofMs: Math.max(0, Math.trunc(proofMs)), failure: null } });
  if (done.count !== 1) return null;
  return archiveById(id);
}

/**
 * A check failed: this copy is never restored from, and is deleted by the next clean-up. `from` says which states it may be failed from: a proof that
 * ran too long to still be the one in charge fails only a copy that is still just `stored`, never one another run has since proved.
 */
export async function markFailed(id: string, failure: string, from: Array<'staging' | 'stored' | 'verified'> = ['staging', 'stored', 'verified']): Promise<boolean> {
  const done = await prisma.computerArchive.updateMany({ where: { id, state: { in: from } }, data: { state: 'failed', failure: failure.slice(0, 200) } });
  return done.count === 1;
}

export async function archiveById(id: string): Promise<ArchiveRow | null> {
  const row = await prisma.computerArchive.findUnique({ where: { id } });
  return row ? view(row) : null;
}

/** The Brick's verified copies, newest first. */
export async function verifiedArchives(botId: string): Promise<ArchiveRow[]> {
  const rows = await prisma.computerArchive.findMany({ where: { botId, state: 'verified' }, orderBy: { generation: 'desc' } });
  return rows.map(view);
}

/** The bytes the Brick's copies take in our storage (every copy that still exists), for the books. */
export async function archiveBytes(botId: string): Promise<number> {
  const sum = await prisma.computerArchive.aggregate({ where: { botId, state: { not: 'failed' } }, _sum: { bytes: true } });
  return Number(sum._sum.bytes ?? 0);
}

/**
 * Keeps the newest verified copies and deletes the rest of what this Brick has stored: older verified ones, ones that failed, and ones left half
 * written for long. A copy that is `stored` and not yet proved is the pack-away under way and is left alone (`keepId`). An object that could not
 * be deleted keeps its row as `superseded`, so the next clean-up tries it again.
 */
export async function pruneArchives(botId: string, keepId: string | null = null, now: Date = new Date(), keepVerified: number = KEEP_VERIFIED): Promise<number> {
  const rows = await prisma.computerArchive.findMany({ where: { botId }, orderBy: { generation: 'desc' } });
  const verified = rows.filter((row) => row.state === 'verified');
  const keep = new Set(verified.slice(0, keepVerified).map((row) => row.id));
  if (keepId) keep.add(keepId);
  // A pack-away that is still saying it is alive owns the copy it is writing or proving, however long that takes (another server's sweep comes here too)
  const packing = await prisma.brickComputer.findUnique({ where: { botId }, select: { machine: true, packStage: true, packClaimedAt: true } });
  const working = !!packing && packing.machine === 'packing' && (packing.packStage === 'claimed' || packing.packStage === 'stored') && !!packing.packClaimedAt && now.getTime() - packing.packClaimedAt.getTime() < LIVE_CLAIM_MS;
  const drop = rows.filter((row) => {
    if (keep.has(row.id)) return false;
    if (row.state === 'verified' || row.state === 'superseded' || row.state === 'failed') return true;
    // staging or stored and not the one in progress: left behind by a pack-away that stopped
    if (working) return false;
    return now.getTime() - row.createdAt.getTime() > STALE_MS;
  });
  let removed = 0;
  for (const row of drop) {
    try {
      await store.remove([row.objectKey, `${row.objectKey}.new`]);
    } catch (error) {
      console.error('[Computer] Could not delete an old copy:', error instanceof Error ? error.message : 'unknown');
      await prisma.computerArchive.updateMany({ where: { id: row.id }, data: { state: 'superseded' } });
      continue;
    }
    await prisma.computerArchive.deleteMany({ where: { id: row.id } });
    removed++;
  }
  return removed;
}

/** Deletes every copy of this Brick for good (the Brick was deleted). Throws when one cannot be deleted, so the Brick is kept for the next try. */
export async function deleteAllArchives(botId: string): Promise<void> {
  const rows = await prisma.computerArchive.findMany({ where: { botId } });
  if (rows.length === 0) return;
  await store.remove(rows.flatMap((row) => [row.objectKey, `${row.objectKey}.new`]));
  // Only the rows whose objects were just deleted: a copy that began being written meanwhile keeps its row, so the next try finds and deletes it
  await prisma.computerArchive.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
}

/** Opens a stored copy decrypted, as a stream, for the download route. */
export function openArchive(row: Pick<ArchiveRow, 'objectKey'>): Promise<{ stream: Readable; bytes: number }> {
  return store.open(row.objectKey);
}

// ---------- The address a computer restores from ----------

const PURPOSE = 'universe-computer-restore-token';

const sign = (archiveId: string, ref: string, expires: number) => createHmac('sha256', derivedKey(PURPOSE)).update(`${archiveId}\n${ref}\n${expires}`).digest('base64url');

/** A key for one copy and one computer that stops working after a short while. Several requests may use it (a restore that is retried). */
export function mintDownloadToken(archiveId: string, ref: string, now: number = Date.now()): string {
  const expires = Math.floor((now + DOWNLOAD_LIFE_MS) / 1000);
  return `${expires}.${Buffer.from(ref).toString('base64url')}.${sign(archiveId, ref, expires)}`;
}

/** The computer the key was made for, when the key is for this copy and has not run out; null otherwise. */
export function verifyDownloadToken(token: string | null | undefined, archiveId: string, now: number = Date.now()): { ref: string } | null {
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) return null;
  const expires = Number(parts[0]);
  if (!Number.isInteger(expires) || expires * 1000 < now || expires * 1000 > now + DOWNLOAD_LIFE_MS + 60_000) return null;
  const ref = Buffer.from(parts[1], 'base64url').toString();
  if (!ref) return null;
  const wanted = Buffer.from(sign(archiveId, ref, expires));
  const given = Buffer.from(parts[2]);
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? { ref } : null;
}

/** The address a computer fetches a copy from (Orbit's own public address; no new setting). */
export function downloadUrl(archiveId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.NEXT_PUBLIC_API_URL || env.ADMIN_API_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/api/computer/archives/${encodeURIComponent(archiveId)}/download` : null;
}
