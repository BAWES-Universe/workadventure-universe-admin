import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const stored = new Map<string, Buffer>();
let abortCalled = false;

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
        if (kind === 'DeleteObjectCommand') {
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
      const chunks: Buffer[] = [];
      for await (const chunk of this.options.params.Body) chunks.push(Buffer.from(chunk));
      stored.set(this.options.params.Key, Buffer.concat(chunks));
    }
    async abort() {
      abortCalled = true;
    }
  },
}));

import { COPY_OVERHEAD, openSavedCopy, savedCopyKey, savedCopyOf, storeSavedCopy } from '@/lib/agent37/saved-copies';

const webStream = (...parts: Buffer[]) => Readable.toWeb(Readable.from(parts)) as unknown as ReadableStream<Uint8Array>;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
});
beforeEach(() => {
  stored.clear();
  abortCalled = false;
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

  it('says nothing is saved for a Brick that has no copy', async () => {
    expect(await savedCopyOf('nobody')).toBeNull();
  });
});
