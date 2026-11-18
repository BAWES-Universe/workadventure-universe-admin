import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const stored = new Map<string, Buffer>();
let abortCalled = false;
let failUpload = false;

let purged = false;
const writes = new Map<string, { botId: string; expiresAt: Date }>();
let failDeletes = false;
jest.mock('@/lib/db', () => ({
  prisma: {
    brickPurge: { count: async () => (purged ? 1 : 0) },
    savedCopyWrite: {
      create: async ({ data }: { data: { botId: string; expiresAt: Date } }) => {
        const id = `w${writes.size + 1}-${data.botId}`;
        writes.set(id, data);
        return { id };
      },
      deleteMany: async ({ where }: { where: { id: string } }) => ({ count: writes.delete(where.id) ? 1 : 0 }),
      count: async ({ where }: { where: { id: string } }) => (writes.has(where.id) ? 1 : 0),
    },
  },
}));
jest.mock('@/lib/artifact-storage', () => ({
  artifactBucket: () => ({
    bucket: 'b',
    s3: {
      send: async (command: { input: { Key: string; CopySource?: string } }) => {
        const kind = command.constructor.name;
        if (kind === 'CopyObjectCommand') {
          stored.set(command.input.Key, stored.get((command.input.CopySource as string).replace('b/', '')) as Buffer);
          return {};
        }
        if (kind === 'ListObjectsV2Command') {
          const input = command.input as unknown as { Prefix: string; ContinuationToken?: string };
          // As a real bucket: the token is the last key read, so deleting while listing never skips one. Two to a page.
          const keys = [...stored.keys()].filter((key) => key.startsWith(input.Prefix) && (!input.ContinuationToken || key > input.ContinuationToken)).sort();
          const page = keys.slice(0, 2);
          return { Contents: page.map((Key) => ({ Key })), IsTruncated: keys.length > 2, NextContinuationToken: page[page.length - 1] };
        }
        if (kind === 'DeleteObjectCommand') {
          if (failDeletes) throw new Error('bucket would not delete');
          stored.delete(command.input.Key);
          return {};
        }
        const file = stored.get(command.input.Key);
        if (!file) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return { ContentLength: file.length, LastModified: new Date('2026-11-14T12:00:00Z') };
      },
    },
  }),
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(private readonly options: { params: { Key: string; Body: Readable } }) {}
    async done() {
      if (failUpload) {
        // A bucket that stops reading and then fails, while the archive is still coming
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('bucket refused the upload');
      }
      const chunks: Buffer[] = [];
      for await (const chunk of this.options.params.Body) chunks.push(Buffer.from(chunk));
      stored.set(this.options.params.Key, Buffer.concat(chunks));
    }
    async abort() {
      abortCalled = true;
    }
  },
}));

import { COPY_OVERHEAD, deleteSavedCopy, openSavedCopy, savedCopyKey, savedCopyOf, storeSavedCopy } from '@/lib/agent37/saved-copies';

const webStream = (...parts: Buffer[]) => Readable.toWeb(Readable.from(parts)) as unknown as ReadableStream<Uint8Array>;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
});
beforeEach(() => {
  stored.clear();
  abortCalled = false;
  failUpload = false;
  purged = false;
  writes.clear();
  failDeletes = false;
});

describe('the saved copy of a Brick computer’s files', () => {
  const archive = gzipSync(Buffer.from('home folder '.repeat(5000)));

  it('stores the folder encrypted, so the bucket never holds anything readable, and reads back whole', async () => {
    const info = await storeSavedCopy('bot-1', webStream(archive.subarray(0, 100), archive.subarray(100)));
    const file = stored.get(savedCopyKey('bot-1')) as Buffer;
    expect(file.includes(archive.subarray(20, 60))).toBe(false);
    expect(file.length).toBe(archive.length + COPY_OVERHEAD);
    expect(info.bytes).toBe(archive.length);
    expect(openSavedCopy(file).equals(archive)).toBe(true);
  });

  it('does not leave a copy behind for a Brick that was purged while its save was running: the purge marker is there by the time the copy lands', async () => {
    // The purge wrote its marker and deleted the bucket's keys for the Brick before this save's copy landed
    purged = true;
    await expect(storeSavedCopy('bot-gone', webStream(archive))).rejects.toThrow('deleted while its files were being saved');
    expect(await savedCopyOf('bot-gone')).toBeNull();
    expect([...stored.keys()]).toEqual([]);
  });

  it('writes the save down before it starts and lets go of it once the copy is checked, so a purge can always tell a save is under way', async () => {
    let seenDuring = 0;
    const slow = Readable.from(
      (async function* () {
        seenDuring = writes.size;
        yield archive;
      })(),
    );
    await storeSavedCopy('bot-1', Readable.toWeb(slow) as unknown as ReadableStream<Uint8Array>);
    expect(seenDuring).toBe(1);
    expect(writes.size).toBe(0);
  });

  it('refuses to start for a Brick already purged, leaving nothing in the bucket and no row behind', async () => {
    purged = true;
    await expect(storeSavedCopy('bot-gone', webStream(archive))).rejects.toThrow('deleted while its files were being saved');
    expect(stored.size).toBe(0);
    expect(writes.size).toBe(0);
  });

  it('takes a copy back that landed after the purge, and lets go of its row only then', async () => {
    const stream = Readable.from(
      (async function* () {
        yield archive;
        purged = true;
      })(),
    );
    await expect(storeSavedCopy('bot-late', Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>)).rejects.toThrow('deleted while its files were being saved');
    expect(stored.has(savedCopyKey('bot-late'))).toBe(false);
    expect(writes.size).toBe(0);
  });

  it('publishes nothing once its write was settled by the purge (the row is gone) or its window is over: the upload is taken out again and the copy is not saved', async () => {
    // A purge settled this write (deleted its row) while the upload was still running
    const settledStream = Readable.from(
      (async function* () {
        yield archive;
        writes.clear();
      })(),
    );
    await expect(storeSavedCopy('bot-slow', Readable.toWeb(settledStream) as unknown as ReadableStream<Uint8Array>)).rejects.toThrow('no longer allowed');
    expect(stored.has(savedCopyKey('bot-slow'))).toBe(false);
    expect([...stored.keys()].filter((key) => key.includes('bot-slow'))).toEqual([]);
    // Its window ran out while it was uploading
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const slowStream = Readable.from(
        (async function* () {
          yield archive;
          jest.setSystemTime(Date.now() + 3 * 60 * 60_000);
        })(),
      );
      await expect(storeSavedCopy('bot-slow', Readable.toWeb(slowStream) as unknown as ReadableStream<Uint8Array>)).rejects.toThrow('no longer allowed');
      expect(stored.has(savedCopyKey('bot-slow'))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps its row when a copy that landed after the purge could not be taken away again, so the purge still finds it', async () => {
    // The copy lands, the marker is seen, and the bucket will not delete: the copy may still be there, so the row stays for the purge to settle
    const real = purged;
    expect(real).toBe(false);
    const stream = Readable.from(
      (async function* () {
        yield archive;
        purged = true;
        failDeletes = true;
      })(),
    );
    await expect(storeSavedCopy('bot-late', Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>)).rejects.toThrow();
    expect(writes.size).toBe(1);
    expect(stored.has(savedCopyKey('bot-late'))).toBe(true);
  });

  it('refuses a copy that was changed', async () => {
    await storeSavedCopy('bot-1', webStream(archive));
    const file = Buffer.from(stored.get(savedCopyKey('bot-1')) as Buffer);
    file[30] ^= 1;
    expect(() => openSavedCopy(file)).toThrow();
  });

  it('a stream that ends before the gzip does is not saved, and the earlier copy stays', async () => {
    await storeSavedCopy('bot-1', webStream(archive));
    const before = Buffer.from(stored.get(savedCopyKey('bot-1')) as Buffer);
    await expect(storeSavedCopy('bot-1', webStream(archive.subarray(0, archive.length - 40)))).rejects.toThrow();
    expect(abortCalled).toBe(true);
    expect([...stored.keys()]).toEqual([savedCopyKey('bot-1')]);
    expect((stored.get(savedCopyKey('bot-1')) as Buffer).equals(before)).toBe(true);
  });

  it('a bucket that fails while a big archive is still coming ends the save with an error instead of hanging', async () => {
    failUpload = true;
    // 40 MB of a valid gzip that nobody reads: without the clean-up the stream stops on backpressure and never settles
    const big = gzipSync(randomBytes(40 * 1024 * 1024));
    const endless = Readable.toWeb(
      Readable.from(
        (function* () {
          for (let at = 0; at < big.length; at += 64 * 1024) yield big.subarray(at, at + 64 * 1024);
        })(),
      ),
    ) as unknown as ReadableStream<Uint8Array>;
    await expect(storeSavedCopy('bot-1', endless)).rejects.toThrow('bucket refused');
  }, 10_000);

  it('says nothing is saved for a Brick that has no copy', async () => {
    expect(await savedCopyOf('nobody')).toBeNull();
  });

  it('deletes everything kept of a Brick for good: the saved copy and every staged object, across pages, and nobody else\'s', async () => {
    stored.set(savedCopyKey('bot-1'), Buffer.from('saved'));
    stored.set('computer-saves/bot-1.attempt-a.ubc.new', Buffer.from('staged a'));
    stored.set('computer-saves/bot-1.attempt-b.ubc.new', Buffer.from('staged b'));
    stored.set('computer-saves/bot-1.attempt-c.ubc.new', Buffer.from('staged c'));
    stored.set(savedCopyKey('bot-10'), Buffer.from('another Brick whose id starts the same'));
    stored.set(savedCopyKey('bot-2'), Buffer.from('another Brick'));
    await deleteSavedCopy('bot-1');
    expect([...stored.keys()].sort()).toEqual([savedCopyKey('bot-10'), savedCopyKey('bot-2')].sort());
    expect(await savedCopyOf('bot-1')).toBeNull();
    // Asked for a Brick with nothing kept it is the same answer
    await expect(deleteSavedCopy('bot-1')).resolves.toBeUndefined();
  });
});
