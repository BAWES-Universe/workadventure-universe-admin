import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, type DecipherGCM } from 'node:crypto';
import { PassThrough, Readable, Transform, Writable, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { artifactBucket } from '@/lib/artifact-storage';
import { prisma } from '@/lib/db';
import { derivedKey } from '@/lib/encryption';

/**
 * The saved copy of a Brick computer's home folder (game #2000): what is kept before a machine is deleted, and what Files shows.
 *
 * It is one file per Brick, in the same bucket as artifacts but under its own name and ENCRYPTED, so what is in it is never readable
 * from the bucket's address, whoever learns the name. The key comes from the server's own encryption key and is only for this use.
 * A copy is replaced only when a new one arrived whole: the folder's tar.gz is read to its end and checked as a gzip (a stream that
 * was cut short fails the check), written under a staging name, and copied over the saved one only after that check passed.
 *
 * File layout: "UBC1", a 12-byte nonce, the encrypted tar.gz, a 16-byte tag.
 */

const run = promisify(pipeline);
const MAGIC = Buffer.from('UBC1');
const NONCE = 12;
const TAG = 16;
export const COPY_OVERHEAD = MAGIC.length + NONCE + TAG;
const PURPOSE = 'universe-computer-saved-copy';

/** The longest a save may run. A row of a save that began longer ago than this is stale: its server is gone. */
export const SAVE_WINDOW_MS = 2 * 60 * 60_000;

export const savedCopyKey = (botId: string) => `computer-saves/${botId}.ubc`;
/** Where a copy is written first: it takes the place of the saved one only after the check of the whole stream has passed. */
/** Each save stages its own object, so two saves of one Brick never read or delete each other's bytes. */
const stagingKey = (botId: string, attempt: string) => `computer-saves/${botId}.${attempt}.ubc.new`;

export interface SavedCopyInfo {
  /** The size of the folder's tar.gz. */
  bytes: number;
  savedAt: Date;
}

/** Encrypts what passes through and puts the tag at the end. Counts nothing: the size is read back from the bucket. */
function encryptor(key: Buffer): Transform {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  let started = false;
  return new Transform({
    transform(chunk, _encoding, done) {
      if (!started) {
        started = true;
        this.push(Buffer.concat([MAGIC, nonce]));
      }
      this.push(cipher.update(chunk));
      done();
    },
    flush(done) {
      if (!started) this.push(Buffer.concat([MAGIC, nonce]));
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      done();
    },
  });
}

/** Reads a saved copy back (for a restore and for tests): checks the tag, so a copy that was changed or cut short is refused. */
export function openSavedCopy(file: Buffer): Buffer {
  if (file.length < COPY_OVERHEAD || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a saved copy');
  const nonce = file.subarray(MAGIC.length, MAGIC.length + NONCE);
  const tag = file.subarray(file.length - TAG);
  const decipher = createDecipheriv('aes-256-gcm', derivedKey(PURPOSE), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(file.subarray(MAGIC.length + NONCE, file.length - TAG)), decipher.final()]);
}

export interface Sealed {
  /** The tar.gz's size as it was read, and its SHA-256: what the copy must give back when it is restored. */
  bytes: number;
  sha256: string;
}

/** The copy into place was given up on before it answered: whether it landed, or will, is not known. */
export class CopyOutcomeUnknown extends Error {
  constructor() {
    super('The copy into place gave no answer in time');
    this.name = 'CopyOutcomeUnknown';
  }
}

/** The longest the copy into place may take (a copy is seconds; this is the bound that keeps a write's whole life under its limit). */
export const COPY_REQUEST_MAX_MS = 5 * 60 * 1000;

/**
 * Writes a folder's tar.gz (as Agent37 streams it) into the bucket, encrypted, under `finalKey`, and says its size and SHA-256. The stream is read to its
 * end and checked as a gzip (a stream cut short fails the check) while it is written under `stagingKey`; only a whole one is copied over `finalKey`.
 * Throws when the stream was not a whole gzip or the upload did not finish: what was at `finalKey` is then untouched.
 */
export async function storeSealed(finalKey: string, stagingKey: string, archive: ReadableStream<Uint8Array>, leftNothing: () => void = () => undefined, mayPublish?: () => Promise<boolean>): Promise<Sealed> {
  const { s3, bucket } = artifactBucket();
  const source = Readable.fromWeb(archive as never);
  const toBucket = new PassThrough();
  const toCheck = createGunzip();
  const sealed = encryptor(derivedKey(PURPOSE));
  const hash = createHash('sha256');
  let bytes = 0;
  // Any part that fails takes every other part down with it, so no stream is left paused on a reader that is gone
  const stopAll = (error: Error) => {
    for (const part of [source, toBucket, sealed, toCheck]) part.destroy(error);
  };
  // The same bytes go two ways: to the bucket (encrypted), and through a gzip check that fails when the stream ends early
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  source.pipe(toBucket);
  source.pipe(toCheck);
  source.on('error', stopAll);
  pipeline(toBucket, sealed, (error) => {
    if (error) stopAll(error);
  });
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: stagingKey, Body: sealed, ContentType: 'application/octet-stream', CacheControl: 'private, no-store' },
  });
  const checked = run(toCheck, new Writable({ write: (_chunk, _encoding, done) => done() })).catch((error) => {
    stopAll(error);
    throw error;
  });
  const uploaded = upload.done().catch((error) => {
    stopAll(error);
    throw error;
  });
  // Both must finish; one that fails has ended the others, so this always settles
  const results = await Promise.allSettled([checked, uploaded]);
  const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) {
    await upload.abort().catch(() => undefined);
    // The upload may have finished a moment before the check failed: what it wrote is not a copy, and the saved one is untouched
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey })).then(leftNothing, () => undefined);
    throw failed.reason && typeof failed.reason.message === 'string' ? failed.reason : new Error('The copy of the files could not be saved');
  }
  // The write may have been settled meanwhile (a purge gives a write that ran too long up and calls the files gone): then nothing is published, and what
  // was uploaded is taken out again. Asked right before the copy goes in place, so a save that was slow cannot publish after the purge was done with it.
  if (mayPublish && !(await mayPublish().catch(() => false))) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey })).then(leftNothing, () => undefined);
    throw new Error('The copy was not published: its save is no longer allowed to');
  }
  // The stream was whole and the upload finished: now, and only now, it takes the place of what was there (one copy inside the bucket)
  // Bounded: a copy request that is still out much later could land an object after the row that names it was taken as abandoned (the writer's own limit,
  // `WRITE_MAX_MS` in computer-archives, plus this, stays under the hour after which a row is taken). The request is given up on, and what is there is taken out
  try {
    await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: finalKey, CopySource: `${bucket}/${stagingKey}` }), { abortSignal: AbortSignal.timeout(COPY_REQUEST_MAX_MS) });
  } catch (error) {
    // Given up on by the signal: the request may still finish at the bucket, so the caller is told the outcome is not known (not that it failed)
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new CopyOutcomeUnknown();
    // A copy that failed is not a saved copy, and nothing else would ever remove the staging object (an unknown outcome keeps it: the copy may still be reading it).
    // The save's row is NOT let go of here: a transport error (a reset connection) after the request went out may still let the copy land, so the row stays for the
    // purge to settle once it is stale, and a purge cannot call the files gone while a late copy is still possible
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey })).catch(() => undefined);
    throw error;
  }
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey })).catch(() => undefined);
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Stores the folder's tar.gz (as Agent37 streams it). Throws when the stream was not a whole gzip or the upload did not finish:
 * the previous copy is then still the saved one.
 */
export async function storeSavedCopy(botId: string, archive: ReadableStream<Uint8Array>): Promise<SavedCopyInfo> {
  // Written down first, and kept until the copy has been checked against the purge marker: a purge looks at these before it calls the saved
  // files gone, so a copy that lands after the purge deleted (or a server that stops right after it landed) is still found and deleted
  const expiresAt = new Date(Date.now() + SAVE_WINDOW_MS);
  const write = await prisma.savedCopyWrite.create({ data: { botId, expiresAt }, select: { id: true } });
  let settled = false;
  try {
    // Purge marker and this row are each written before the other is read, so a save and a purge can never both miss each other: a Brick
    // purged before this point is seen here, and one purged after is seen by the purge, which finds this row
    if ((await prisma.brickPurge.count({ where: { botId } })) > 0) {
      settled = true;
      throw new Error('The Brick was deleted while its files were being saved');
    }
    // Published only while this save is still the live one: inside its window, with its row still there (a purge that settled it deleted it)
    await storeSealed(savedCopyKey(botId), stagingKey(botId, randomUUID()), archive, () => (settled = true), async () => Date.now() < expiresAt.getTime() && (await prisma.savedCopyWrite.count({ where: { id: write.id } })) === 1);
    // A Brick purged while this save was running: the purge wrote its marker before it deleted anything in the bucket, so a marker seen now (after
    // the copy) means the delete either already ran and missed this copy, or will run after it and take it. Either way this copy must not stay
    if ((await prisma.brickPurge.count({ where: { botId } })) > 0) {
      const { s3, bucket } = artifactBucket();
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: savedCopyKey(botId) }));
      settled = true;
      throw new Error('The Brick was deleted while its files were being saved');
    }
    const copy = await savedCopyOf(botId);
    if (!copy) throw new Error('The saved copy cannot be found after it was stored');
    settled = true;
    return copy;
  } finally {
    // Only a save that is certain it left nothing behind lets go of its row; any other leaves it for the purge to settle once it is stale
    if (settled) await prisma.savedCopyWrite.deleteMany({ where: { id: write.id } }).catch(() => undefined);
  }
}

/** Decrypts what `encryptor` wrote, as it streams. The tag is the last 16 bytes, so it is only known at the end: a copy that was changed or cut short fails there, and the stream errors. */
function decryptor(key: Buffer): Transform {
  let head = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let tail = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        let data = chunk;
        if (!decipher) {
          head = Buffer.concat([head, data]);
          if (head.length < MAGIC.length + NONCE) return done();
          if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a saved copy');
          decipher = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length, MAGIC.length + NONCE)) as DecipherGCM;
          data = head.subarray(MAGIC.length + NONCE);
        }
        const all = Buffer.concat([tail, data]);
        const keep = Math.min(TAG, all.length);
        tail = all.subarray(all.length - keep);
        const body = all.subarray(0, all.length - keep);
        if (body.length > 0) this.push(decipher.update(body));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      try {
        if (!decipher || tail.length !== TAG) throw new Error('The saved copy is cut short');
        decipher.setAuthTag(tail);
        this.push(decipher.final());
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

/** A stored copy, decrypted as a stream, and its size. Nothing is checked until the end: a copy that fails its tag ends the stream with an error. */
export async function openSealedStream(key: string): Promise<{ stream: Readable; bytes: number }> {
  const { s3, bucket } = artifactBucket();
  const found = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!found.Body) throw new Error('The saved copy could not be read');
  const bytes = Math.max(0, (found.ContentLength ?? 0) - COPY_OVERHEAD);
  const body = found.Body as Readable;
  const stream = body.pipe(decryptor(derivedKey(PURPOSE)));
  body.on('error', (error) => stream.destroy(error));
  // A download that is cancelled, or that fails its check, destroys the decrypted stream; pipe() does not pass that back, so the response from the bucket is let go here
  // (otherwise its connection stays checked out of the pool until the bucket's idle timeout)
  stream.on('close', () => {
    if (!body.destroyed) body.destroy();
  });
  return { stream, bytes };
}

/** The size of a stored copy's tar.gz and when it was written; null when nothing is stored there. */
export async function sealedInfo(key: string): Promise<SavedCopyInfo | null> {
  const { s3, bucket } = artifactBucket();
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { bytes: Math.max(0, (head.ContentLength ?? 0) - COPY_OVERHEAD), savedAt: head.LastModified ?? new Date() };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === 'NotFound') return null;
    throw error;
  }
}

/** Deletes stored copies for good. A key that is not there is no error. */
export async function deleteSealed(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const { s3, bucket } = artifactBucket();
  for (let at = 0; at < keys.length; at += 1000) {
    const batch = keys.slice(at, at + 1000);
    const answer = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
    if (answer.Errors && answer.Errors.length > 0) throw new Error('A saved copy could not be deleted');
  }
}

/**
 * The objects under a prefix with the time each was last written, up to `max`, in key order, starting after `startAfter` when it is given (the rest is looked at by a later pass). Used to find objects that no
 * row points at (a writer that stopped after a purge took its row).
 */
export async function listSealed(prefix: string, max: number, startAfter?: string): Promise<Array<{ key: string; modifiedAt: Date }>> {
  const { s3, bucket } = artifactBucket();
  const found: Array<{ key: string; modifiedAt: Date }> = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, ...(token ? {} : { StartAfter: startAfter }) }));
    for (const object of page.Contents ?? []) {
      if (object.Key && object.LastModified) found.push({ key: object.Key, modifiedAt: object.LastModified });
    }
    token = page.IsTruncated && found.length < max ? page.NextContinuationToken : undefined;
  } while (token);
  return found.slice(0, max);
}

/** What is saved for this Brick, or null when nothing is. */
export async function savedCopyOf(botId: string): Promise<SavedCopyInfo | null> {
  const { s3, bucket } = artifactBucket();
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: savedCopyKey(botId) }));
    return { bytes: Math.max(0, (head.ContentLength ?? 0) - COPY_OVERHEAD), savedAt: head.LastModified ?? new Date() };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === 'NotFound') return null;
    throw error;
  }
}

/**
 * Deletes everything kept of a Brick's folder in our storage for good: the saved copy, and any object a save of it staged and did not finish
 * (a server that stopped half way leaves one, see `stagingKey`). Everything under the Brick's name goes, found by listing, so no generation
 * is missed. A Brick that has none is also fine: deleting is the same answer either way. Throws when the bucket would not do it, so the
 * caller tries again.
 */
export async function deleteSavedCopy(botId: string): Promise<void> {
  const { s3, bucket } = artifactBucket();
  const prefix = `computer-saves/${botId}.`;
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      if (object.Key) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  // The saved copy itself, by its name, in case the list was not complete (a bucket that lists late): deleting a missing object is not an error
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: savedCopyKey(botId) }));
}
