import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Readable, Transform, Writable, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { artifactBucket } from '@/lib/artifact-storage';
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

/**
 * Stores the folder's tar.gz (as Agent37 streams it). Throws when the stream was not a whole gzip or the upload did not finish:
 * the previous copy is then still the saved one.
 */
export async function storeSavedCopy(botId: string, archive: ReadableStream<Uint8Array>): Promise<SavedCopyInfo> {
  const { s3, bucket } = artifactBucket();
  const staging = stagingKey(botId, randomUUID());
  const source = Readable.fromWeb(archive as never);
  const toBucket = new PassThrough();
  const toCheck = createGunzip();
  const sealed = encryptor(derivedKey(PURPOSE));
  // Any part that fails takes every other part down with it, so no stream is left paused on a reader that is gone
  const stopAll = (error: Error) => {
    for (const part of [source, toBucket, sealed, toCheck]) part.destroy(error);
  };
  // The same bytes go two ways: to the bucket (encrypted), and through a gzip check that fails when the stream ends early
  source.pipe(toBucket);
  source.pipe(toCheck);
  source.on('error', stopAll);
  pipeline(toBucket, sealed, (error) => {
    if (error) stopAll(error);
  });
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: staging, Body: sealed, ContentType: 'application/octet-stream', CacheControl: 'private, no-store' },
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
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: staging })).catch(() => undefined);
    throw failed.reason && typeof failed.reason.message === 'string' ? failed.reason : new Error('The copy of the files could not be saved');
  }
  // The stream was whole and the upload finished: now, and only now, it replaces the saved copy (one copy inside the bucket)
  await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: savedCopyKey(botId), CopySource: `${bucket}/${staging}` }));
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: staging })).catch(() => undefined);
  const copy = await savedCopyOf(botId);
  if (!copy) throw new Error('The saved copy cannot be found after it was stored');
  return copy;
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
 * Deletes the saved copy of a Brick's folder for good (a Brick that was deleted keeps nothing of its computer in our storage). Asked for a
 * copy that is not there it is also fine: deleting is the same answer either way. Throws when the bucket would not do it.
 */
export async function deleteSavedCopy(botId: string): Promise<void> {
  const { s3, bucket } = artifactBucket();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: savedCopyKey(botId) }));
}
