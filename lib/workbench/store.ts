import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { artifactFiles } from '@/lib/artifact-storage';
import { derivedKey } from '@/lib/encryption';

/**
 * Where the files a code job made are kept: Universe's own storage, written by Orbit alone, and ENCRYPTED, so a file is never readable
 * from the bucket's address whatever anyone learns of its name (the bucket also serves public artifacts). Only Orbit's own route opens
 * one, and only for the job's owner. The provider's copy is gone within a day; this one is what the person keeps.
 *
 * File layout: "UCJ1", a 12-byte nonce, the encrypted file, a 16-byte tag.
 */

const MAGIC = Buffer.from('UCJ1');
const NONCE = 12;
const TAG = 16;
const PURPOSE = 'universe-code-job-output';

export interface OutputStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The file as it was put; throws when it is not there or was changed. */
  get(key: string): Promise<Uint8Array>;
  remove(keys: string[]): Promise<void>;
}

export const outputKeyFor = (jobId: string, outputId: string): string => `code-jobs/${jobId}/${outputId}.ucj`;

export function seal(bytes: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(PURPOSE), nonce);
  return Buffer.concat([MAGIC, nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

export function open(file: Uint8Array): Buffer {
  const whole = Buffer.from(file);
  if (whole.length < MAGIC.length + NONCE + TAG || !whole.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a kept file');
  const decipher = createDecipheriv('aes-256-gcm', derivedKey(PURPOSE), whole.subarray(MAGIC.length, MAGIC.length + NONCE));
  decipher.setAuthTag(whole.subarray(whole.length - TAG));
  return Buffer.concat([decipher.update(whole.subarray(MAGIC.length + NONCE, whole.length - TAG)), decipher.final()]);
}

async function collect(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The real store: the artifacts bucket, under a prefix of its own. */
export const bucketOutputStore: OutputStore = {
  async put(key, bytes) {
    await artifactFiles.put(key, seal(bytes), 'application/octet-stream');
  },
  async get(key) {
    return open(await collect(await artifactFiles.read(key)));
  },
  async remove(keys) {
    await artifactFiles.remove(keys);
  },
};

let override: OutputStore | undefined;

/** For tests: a fake in place of the bucket. Call with undefined to go back. */
export function setOutputStoreForTests(store: OutputStore | undefined): void {
  override = store;
}

export const getOutputStore = (): OutputStore => override ?? bucketOutputStore;
