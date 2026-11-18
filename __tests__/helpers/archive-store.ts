import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ArchiveStore } from '@/lib/computer-archives';

/** The bucket, in memory. What is "encrypted" in the real one is plain here: the encryption has its own tests (saved-copies). */
export function memoryStore() {
  const objects = new Map<string, Buffer>();
  // When each object was last written (the real bucket says so): a test may set it back to make an object old
  const written = new Map<string, Date>();
  const store: ArchiveStore = {
    async put(finalKey, _stagingKey, archive, mayPublish) {
      const chunks: Buffer[] = [];
      const reader = archive.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      const body = Buffer.concat(chunks);
      // As the bucket does: asked right before the copy goes in place
      if (mayPublish && !(await mayPublish())) throw new Error('not published');
      objects.set(finalKey, body);
      written.set(finalKey, new Date());
      return { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    },
    async open(key) {
      const body = objects.get(key);
      if (!body) throw new Error('not found');
      return { stream: Readable.from([body]), bytes: body.length };
    },
    async remove(keys) {
      for (const key of keys) objects.delete(key);
    },
    async list(prefix, max, startAfter) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort().slice(0, max).map((key) => ({ key, modifiedAt: written.get(key) ?? new Date() }));
    },
  };
  return { store, objects, written };
}
