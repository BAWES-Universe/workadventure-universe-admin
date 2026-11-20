import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { prisma } from '@/lib/db';
import { derivedKey } from '@/lib/encryption';
import { CopyOutcomeUnknown, deleteSealed, listSealed, openSealedStream, storeSealed, type Sealed } from '@/lib/agent37/saved-copies';

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
/**
 * A write whose copy into place was given up on before it answered keeps its row, marked, for this long from when the write began: the request may still
 * finish at the bucket (it is not known), so a purge does not call the Brick clear of copies until that is long past, and then deletes the row with the
 * keys, which takes a copy that landed meanwhile. Far longer than a request is bounded to.
 */
const UNKNOWN_COPY_HOLD_MS = 4 * 60 * 60 * 1000;
const UNKNOWN_COPY_FAILURE = 'The copy into place gave no answer in time; its outcome is not known';
/**
 * The longest a write of a copy may run. Shorter than `STALE_MS` on purpose: a copy's row is taken for abandoned (by a clean-up or a purge) once it is
 * `STALE_MS` old, so a write that outlasted that could land an object after its row was taken. A write that reaches this is stopped (its stream is
 * cancelled, nothing is published) instead of left to run; the copy into place that follows is bounded to 5 minutes (`COPY_REQUEST_MAX_MS`), so a
 * write's whole life stays under `STALE_MS`.
 */
const WRITE_MAX_MS = 50 * 60 * 1000;
let writeLimitMs = WRITE_MAX_MS;

/** For tests: how long a write may run before it is stopped (null: the real limit). */
export function setWriteLimitForTests(ms: number | null): void {
  writeLimitMs = ms ?? WRITE_MAX_MS;
}

/** A pack-away that said it was alive within this long is still working (kept in step with the pack-away's own take-over time). */
const LIVE_CLAIM_MS = 45 * 60 * 1000;
/** How long a restore address works: one restore on one throwaway or new computer, retries included. */
export const DOWNLOAD_LIFE_MS = 45 * 60 * 1000;

/** Where the objects live. The real one is our encrypted bucket; a test gives an in-memory one. */
export interface ArchiveStore {
  /** `mayPublish` is asked right before the copy goes in place; a no answer publishes nothing and fails the write. */
  put(finalKey: string, stagingKey: string, archive: ReadableStream<Uint8Array>, mayPublish?: () => Promise<boolean>): Promise<Sealed>;
  open(key: string): Promise<{ stream: Readable; bytes: number }>;
  remove(keys: string[]): Promise<void>;
  /** The objects under a prefix and when each was last written, up to `max`, in key order, after `startAfter` when it is given. */
  list(prefix: string, max: number, startAfter?: string): Promise<Array<{ key: string; modifiedAt: Date }>>;
}

const bucketStore: ArchiveStore = { put: (finalKey, stagingKey, archive, mayPublish) => storeSealed(finalKey, stagingKey, archive, undefined, mayPublish), open: openSealedStream, remove: deleteSealed, list: listSealed };
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

/**
 * Writes down that these copies are waiting to be deleted, from now, unless they already say since when (the first time is the one that counts: a deletion
 * that fails again and again is one wait, however many tries). The oldest of these is what the team reads (`storageDeletionsWaiting`).
 */
async function markWaiting(ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await prisma.computerArchive.updateMany({ where: { id: { in: ids }, deletionSince: null }, data: { deletionSince: now } });
}

const objectKeyOf = (botId: string, generation: number, id: string) => `computer-cold/${botId}/${generation}.${id}.ubc`;
const stagingKeyOf = (botId: string, generation: number, id: string) => `computer-cold/${botId}/${generation}.${id}.ubc.new`;

/**
 * Writes the home folder's tar.gz (as the machine streams it) as the Brick's next copy. Throws when the stream was not a whole gzip or the upload did
 * not finish: nothing then stands as a copy, and what was written is deleted. Returns the copy, `stored` (not yet proved).
 */
export async function storeArchive(botId: string, archive: ReadableStream<Uint8Array>, details: { imageRevision?: number | null; manifest?: unknown } = {}): Promise<ArchiveRow> {
  try {
    return await writeArchive(botId, archive, details);
  } catch (error) {
    // A failure before the stream was taken up (the Brick was purged, the database did not answer) leaves the machine's answer unread: it is given up on, so
    // its connection is not held open until a timeout. Once taken up, the stream is cancelled or consumed by the write itself
    if (!archive.locked) await archive.cancel().catch(() => undefined);
    throw error;
  }
}

async function writeArchive(botId: string, archive: ReadableStream<Uint8Array>, details: { imageRevision?: number | null; manifest?: unknown }): Promise<ArchiveRow> {
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
    // A write that reaches its limit is stopped: its stream is cancelled, so the upload cannot finish and nothing is published after its row could have been taken
    const startedAt = Date.now();
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(new Error('The copy took longer than a write may')), writeLimitMs);
    timer.unref?.();
    try {
      if (await purged()) throw new Error('The Brick was deleted while its files were being copied');
      const bounded = archive.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: limit.signal });
      // Published only while this write is still the live one: its row is still there as `staging` (a purge that deleted the row has given this write up),
      // the Brick is not purged and the write is within its limit
      const sealed = await store.put(row.objectKey, stagingKeyOf(botId, generation, id), bounded, async () => Date.now() - startedAt < writeLimitMs && (await prisma.computerArchive.count({ where: { id, state: 'staging' } })) === 1 && !(await purged()));
      // A Brick purged while the copy was written: it must not stand (its row may be gone already, and the object is not to stay without one)
      if (await purged()) throw new Error('The Brick was deleted while its files were being copied');
      // Only while the row is still `staging`: a clean-up that took this copy for deletion meanwhile (`superseded`) owns its object, and the copy must not come back as stored
      const sealedRow = await prisma.computerArchive.updateMany({ where: { id, state: 'staging' }, data: { state: 'stored', bytes: BigInt(sealed.bytes), sha256: sealed.sha256 } });
      if (sealedRow.count !== 1) throw new Error('The copy was taken for deletion while it was being written');
      return view(await prisma.computerArchive.findUniqueOrThrow({ where: { id } }));
    } catch (error) {
      // The marker of a copy whose outcome is not known is tried again: it is what keeps the row for the hold. If it cannot be written at all, the row stays
      // `staging` and is taken as abandoned after `STALE_MS`; an object that lands after that has no row, and the purge and the sweep find it by listing
      const failure = error instanceof CopyOutcomeUnknown ? UNKNOWN_COPY_FAILURE : 'The copy could not be written whole';
      for (let attemptAt = 0; attemptAt < (error instanceof CopyOutcomeUnknown ? 3 : 1); attemptAt++) {
        if (await markFailed(id, failure).then(() => true, () => false)) break;
      }
      const removed = await store.remove([row.objectKey, stagingKeyOf(botId, generation, id)]).then(() => true, () => false);
      // An object that could not be deleted keeps a row that says so (made again if a purge deleted it), so the clean-up finds it and tries again
      if (!removed && !(error instanceof CopyOutcomeUnknown)) {
        // If this record cannot be written either (the database and the bucket failed together), the object has no row. It is not lost: a purge is not done
        // while the Brick's part of the bucket holds anything (`removeBrickObjects`), and the sweep finds the rest by listing (`removeStrayCopies`)
        await prisma.computerArchive
          .upsert({ where: { id }, create: { id, botId, generation, state: 'superseded', objectKey: row.objectKey, deletionSince: new Date() }, update: { state: 'superseded' } })
          .then(() => markWaiting([id], new Date()))
          .catch((recordError) => console.error('[Computer] A copy’s object could not be deleted and its record could not be written; the purge and the sweep look for it by listing:', recordError instanceof Error ? recordError.message : 'unknown'));
      }
      throw error;
    } finally {
      clearTimeout(timer);
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
  // A return that is still saying it is alive is reading one of these copies right now: none is deleted under it, whoever asks (a save on a machine
  // that was made for the return, a later clean-up on another server). It is looked at again once the return is over.
  if (packing && packing.machine === 'restoring' && packing.packStage === 'returning' && !!packing.packClaimedAt && now.getTime() - packing.packClaimedAt.getTime() < LIVE_CLAIM_MS) return 0;
  const working = !!packing && packing.machine === 'packing' && (packing.packStage === 'claimed' || packing.packStage === 'stored') && !!packing.packClaimedAt && now.getTime() - packing.packClaimedAt.getTime() < LIVE_CLAIM_MS;
  const drop = rows.filter((row) => {
    if (keep.has(row.id)) return false;
    // A write whose copy into place was given up on before it answered keeps its row while that copy may still land (see `UNKNOWN_COPY_HOLD_MS`)
    if (row.state === 'failed' && row.failure === UNKNOWN_COPY_FAILURE && now.getTime() - row.createdAt.getTime() <= UNKNOWN_COPY_HOLD_MS) return false;
    if (row.state === 'verified' || row.state === 'superseded' || row.state === 'failed') return true;
    // staging or stored and not the one in progress: left behind by a pack-away that stopped
    if (working) return false;
    return now.getTime() - row.createdAt.getTime() > STALE_MS;
  });
  let removed = 0;
  for (const row of drop) {
    // Taken for deletion before its objects are touched, and only as it was read: a copy that a pack-away took over and is proving meanwhile (or a writer
    // that is still uploading) changed the row, so this does not touch it; and once the row is `superseded` nothing proves, publishes or restores from it.
    // A run that stops half way leaves it `superseded`, which every later clean-up deletes
    if (row.state !== 'superseded') {
      const taken = await prisma.computerArchive.updateMany({ where: { id: row.id, state: row.state }, data: { state: 'superseded', deletionSince: row.deletionSince ?? now } });
      if (taken.count !== 1) continue;
    }
    try {
      await store.remove([row.objectKey, `${row.objectKey}.new`]);
    } catch (error) {
      console.error('[Computer] Could not delete an old copy:', error instanceof Error ? error.message : 'unknown');
      // A row left `superseded` by an older version has no time written: its wait begins here, so it can be read like any other
      await markWaiting([row.id], now).catch(() => undefined);
      continue;
    }
    const gone = await prisma.computerArchive.deleteMany({ where: { id: row.id, state: 'superseded' } });
    if (gone.count === 1) removed++;
  }
  return removed;
}

/**
 * Deletes every copy of this Brick for good (the Brick was deleted). Throws when one cannot be deleted, so the Brick is kept for the next try.
 * A copy that is still being written (its row is `staging` and younger than a write can last) is not taken: that row is the durable record that a
 * writer is still out. The writer settles it itself (the purge marker, written first, makes it give up and say so in its row, and take its objects out),
 * or it goes stale and the next try takes it with its objects, so a purge that finds a row left is not done and an object that lands late is never missed.
 */
export async function deleteAllArchives(botId: string, now: Date = new Date()): Promise<void> {
  const rows = (await prisma.computerArchive.findMany({ where: { botId } })).filter((row) => {
    const age = now.getTime() - row.createdAt.getTime();
    if (row.state === 'staging' && age <= STALE_MS) return false;
    // A write whose copy into place may still finish at the bucket: its row stays until that is long past
    if (row.state === 'failed' && row.failure === UNKNOWN_COPY_FAILURE && age <= UNKNOWN_COPY_HOLD_MS) return false;
    return true;
  });
  if (rows.length === 0) return;
  try {
    await store.remove(rows.flatMap((row) => [row.objectKey, `${row.objectKey}.new`]));
  } catch (error) {
    // The rows stay (the purge is not done), and each says since when its deletion has been waiting
    for (let at = 0; at < rows.length; at += 500) await markWaiting(rows.slice(at, at + 500).map((row) => row.id), now).catch(() => undefined);
    throw error;
  }
  // Only the rows whose objects were just deleted, and only as they were when they were read: a copy that began being written meanwhile keeps its
  // row, and so does a row its writer changed meanwhile (a writer that published after the objects were deleted and could not take its object back
  // out says so in the row, `superseded`), so the next try finds it and deletes the object
  for (let at = 0; at < rows.length; at += 200) {
    const page = rows.slice(at, at + 200);
    await prisma.computerArchive.deleteMany({ where: { OR: page.map((row) => ({ id: row.id, state: row.state })) } });
  }
}

let strayPassMax = 20_000;
/** Where the sweep for copies no row points at writes down how far it has looked: it is the database's, so a restart between passes does not send it back to the top. */
export const STRAY_CURSOR_KEY = 'computer-stray-sweep-cursor';
/** A test makes a pass small so that the bucket is longer than one. */
export function setStrayPassForTests(max: number): void {
  strayPassMax = max;
}
async function readStrayState(): Promise<{ after?: string; failingSince: Date | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: STRAY_CURSOR_KEY } }).catch(() => null);
  const value = row?.value as { after?: unknown; failingSince?: unknown } | null | undefined;
  const since = typeof value?.failingSince === 'string' ? new Date(value.failingSince) : null;
  return { after: typeof value?.after === 'string' ? value.after : undefined, failingSince: since && !Number.isNaN(since.getTime()) ? since : null };
}
async function readStrayCursor(): Promise<string | undefined> {
  return (await readStrayState()).after;
}
/** A pass that could not delete what it found says since when (the first time counts), keeping where it was; a pass that deleted everything writes the place alone, which clears it. */
async function noteStrayFailure(now: Date): Promise<void> {
  const state = await readStrayState();
  const value = { after: state.after ?? null, failingSince: (state.failingSince ?? now).toISOString() };
  await prisma.appSetting.upsert({ where: { key: STRAY_CURSOR_KEY }, create: { key: STRAY_CURSOR_KEY, value }, update: { value } }).catch(() => undefined);
}
async function writeStrayCursor(after: string | null): Promise<void> {
  const value = { after };
  await prisma.appSetting
    .upsert({ where: { key: STRAY_CURSOR_KEY }, create: { key: STRAY_CURSOR_KEY, value }, update: { value } })
    .catch((error) => console.error('[Computer] Could not write down how far the sweep for stray copies has looked:', error instanceof Error ? error.message : 'unknown'));
}
const COPY_OBJECT = /^computer-cold\/[^/]+\/\d+\.([0-9a-f-]{36})\.ubc(?:\.new)?$/;

/**
 * Deletes copy objects that no row points at. A writer whose process stopped after a purge took its row (between the check that let it publish and
 * the copy into place, or after its upload) leaves an object that a purge, which works from rows, can never find. Every object here is named after its
 * row, so an object whose row is gone and that is older than any write can last (`STALE_MS`, the time a half-written copy is given up on) belongs to
 * nobody and is deleted. A younger one may be a write that is still running. A bucket longer than one pass is looked at over several passes (each goes
 * on where the one before stopped, which is written down in the database, so a restart does not send it back), so an object that lands late is reached however many there are before it. Returns how many were deleted.
 */
export async function removeStrayCopies(now: Date = new Date()): Promise<number> {
  // A pass that was full may have left objects unlooked at: the next one starts after the last it saw (written down below, once this page is dealt with),
  // and after the end it starts again from the top
  const found = await store.list('computer-cold/', strayPassMax, await readStrayCursor());
  const next = found.length >= strayPassMax ? found[found.length - 1].key : null;
  const old = found
    .filter((object) => now.getTime() - object.modifiedAt.getTime() >= STALE_MS)
    .flatMap((object) => {
      const id = COPY_OBJECT.exec(object.key)?.[1];
      return id ? [{ key: object.key, id }] : [];
    });
  const stray: string[] = [];
  for (let at = 0; at < old.length; at += 500) {
    const page = old.slice(at, at + 500);
    const known = new Set((await prisma.computerArchive.findMany({ where: { id: { in: page.map((object) => object.id) } }, select: { id: true } })).map((row) => row.id));
    for (const object of page) if (!known.has(object.id)) stray.push(object.key);
  }
  if (stray.length > 0) {
    try {
      await store.remove(stray);
    } catch (error) {
      await noteStrayFailure(now);
      throw error;
    }
  }
  // Only now that everything on the page was looked at and what had to go is gone: a pass that failed is looked at again by the next
  await writeStrayCursor(next);
  return stray.length;
}

const BRICK_OBJECTS_MAX = 2_000;

/**
 * Looks in the bucket, by listing, for anything of one Brick's copies still there, and deletes what belongs to nobody. A purge works from rows, so an object
 * whose row was never written (a writer whose upload could not be taken back and whose record could not be written either) is found only here. An object with
 * no row that is older than any write can last (`STALE_MS`) is deleted; one with a row, or a younger one that may be a write still running, is not touched
 * and counts as left. Returns how many are left: a purge is not done until it is none. Throws when the bucket cannot be listed or an object cannot be deleted.
 */
export async function removeBrickObjects(botId: string, now: Date = new Date()): Promise<number> {
  const found = await store.list(`computer-cold/${botId}/`, BRICK_OBJECTS_MAX);
  if (found.length === 0) return 0;
  const ids = found.flatMap((object) => {
    const id = COPY_OBJECT.exec(object.key)?.[1];
    return id ? [id] : [];
  });
  const known = new Set((await prisma.computerArchive.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((row) => row.id));
  const stray: string[] = [];
  let left = 0;
  for (const object of found) {
    const id = COPY_OBJECT.exec(object.key)?.[1];
    const old = now.getTime() - object.modifiedAt.getTime() >= STALE_MS;
    if ((!id || !known.has(id)) && old) stray.push(object.key);
    else left++;
  }
  if (stray.length > 0) await store.remove(stray);
  // A listing cut at its end may hide more: nothing is called clear until a listing that is not full says so
  return found.length >= BRICK_OBJECTS_MAX ? left + 1 : left;
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

/** How long a deletion may wait before the team is told (a bucket that is only slow clears it long before; one that has stopped accepting deletes does not). */
export const STORAGE_DELETION_ALERT_MS = 24 * 60 * 60 * 1000;

export interface DeletionsWaiting {
  /** Copies taken for deletion whose object is not deleted yet. */
  count: number;
  /** Since when the oldest deletion has waited (a copy's, or a pass for stray objects that could not delete what it found), and for how long. Null when nothing waits. */
  oldestSince: Date | null;
  ageMs: number | null;
  /** Since when the pass for copies no row points at has failed to delete, when it has. */
  strayCopiesSince: Date | null;
}

/** What the team reads to tell eventual clean-up from a bucket that has stopped accepting deletes: how many deletions wait, and since when the oldest has. */
export async function storageDeletionsWaiting(now: Date = new Date()): Promise<DeletionsWaiting> {
  const [rows, stray] = await Promise.all([
    prisma.computerArchive.aggregate({ where: { deletionSince: { not: null } }, _count: { _all: true }, _min: { deletionSince: true } }),
    readStrayState(),
  ]);
  const times = [rows._min.deletionSince, stray.failingSince].filter((at): at is Date => at !== null);
  const oldestSince = times.length > 0 ? new Date(Math.min(...times.map((at) => at.getTime()))) : null;
  return { count: rows._count._all, oldestSince, ageMs: oldestSince ? Math.max(0, now.getTime() - oldestSince.getTime()) : null, strayCopiesSince: stray.failingSince };
}
