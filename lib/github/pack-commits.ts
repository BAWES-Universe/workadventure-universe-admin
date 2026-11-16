import { createHash } from 'crypto';
import { inflateSync } from 'zlib';

/**
 * Reads the commits out of a git pack (the part of a push after its ref updates), so the relay can tell a push that adds to a branch
 * from one that overwrites it. A push says only "branch X: was A, now B"; whether B comes after A is not in the words, only in the
 * commits the pack carries (B, and the ones between, each naming its parents).
 *
 * Only what is needed: commit objects and the ids of what they name. Anything that cannot be read to the end (a pack that is cut
 * short, a delta whose base is not in the pack, too many objects) answers null, and the relay turns the push down: a push whose
 * history cannot be seen is never taken for an addition.
 */

/** A push to an existing branch is only checked up to this size (after unzipping); a bigger one goes to a new branch. */
export const VERIFY_MAX_BYTES = 32 * 1024 * 1024;
const MAX_OBJECTS = 200_000;
const HEX40 = /^[0-9a-f]{40}$/;

const TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

interface Entry {
  offset: number;
  type: number;
  /** For a delta: where its base is (an offset in this pack) or its id. */
  baseOffset?: number;
  baseId?: string;
  data: Buffer;
  /** The object once its delta is applied. */
  done?: { type: number; data: Buffer };
}

const idOf = (type: number, data: Buffer): string => createHash('sha1').update(`${TYPE_NAMES[type]} ${data.length}\0`).update(data).digest('hex');

/** Applies a git delta to its base; null when the delta is not well formed. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
  let at = 0;
  const size = (): number | null => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) return null;
      const byte = delta[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
      if (shift > 49) return null;
    }
  };
  const baseSize = size();
  const resultSize = size();
  if (baseSize === null || resultSize === null || baseSize !== base.length || resultSize > VERIFY_MAX_BYTES) return null;
  const out = Buffer.alloc(resultSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) offset |= (delta[at++] ?? 0) << (8 * bit);
      for (let bit = 0; bit < 3; bit++) if (op & (0x10 << bit)) length |= (delta[at++] ?? 0) << (8 * bit);
      if (length === 0) length = 0x10000;
      offset >>>= 0;
      if (offset + length > base.length || written + length > resultSize) return null;
      base.copy(out, written, offset, offset + length);
      written += length;
    } else if (op > 0) {
      if (at + op > delta.length || written + op > resultSize) return null;
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      return null;
    }
  }
  return written === resultSize ? out : null;
}

/** The commits of a pack: each commit's id and the ids of its parents. Null when the pack cannot be read to its end. */
export function readPackCommits(pack: Buffer): Map<string, string[]> | null {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK' || pack.readUInt32BE(4) !== 2) return null;
  const count = pack.readUInt32BE(8);
  if (count > MAX_OBJECTS) return null;
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let at = 12;
  try {
    for (let n = 0; n < count; n++) {
      const offset = at;
      let byte = pack[at++];
      if (byte === undefined) return null;
      const type = (byte >> 4) & 7;
      let size = byte & 15;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[at++];
        if (byte === undefined) return null;
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if (shift > 56) return null;
      }
      const entry: Entry = { offset, type, data: Buffer.alloc(0) };
      if (type === 6) {
        let c = pack[at++];
        if (c === undefined) return null;
        let back = c & 0x7f;
        while (c & 0x80) {
          c = pack[at++];
          if (c === undefined) return null;
          back = (back + 1) * 128 + (c & 0x7f);
        }
        entry.baseOffset = offset - back;
      } else if (type === 7) {
        if (at + 20 > pack.length) return null;
        entry.baseId = pack.subarray(at, at + 20).toString('hex');
        at += 20;
      } else if (!TYPE_NAMES[type]) {
        return null;
      }
      if (size > VERIFY_MAX_BYTES) return null;
      const inflated = inflateSync(pack.subarray(at), { info: true, maxOutputLength: Math.max(size, 1) }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (inflated.buffer.length !== size) return null;
      at += inflated.engine.bytesWritten;
      entry.data = inflated.buffer;
      entries.push(entry);
      byOffset.set(offset, entry);
    }
  } catch {
    return null;
  }

  // Deltas are put together from their bases, which may themselves be deltas: until nothing more resolves
  const byId = new Map<string, { type: number; data: Buffer }>();
  const settle = (entry: Entry, object: { type: number; data: Buffer }) => {
    entry.done = object;
    byId.set(idOf(object.type, object.data), object);
  };
  for (const entry of entries) if (entry.type <= 4) settle(entry, { type: entry.type, data: entry.data });
  let pending = entries.filter((entry) => !entry.done);
  while (pending.length > 0) {
    const before = pending.length;
    pending = pending.filter((entry) => {
      const base = entry.baseOffset !== undefined ? byOffset.get(entry.baseOffset)?.done : byId.get(entry.baseId ?? '');
      if (!base) return true;
      const data = applyDelta(base.data, entry.data);
      if (!data) return true;
      settle(entry, { type: base.type, data });
      return false;
    });
    if (pending.length === before) break;
  }
  // What is still a delta of something outside the pack (a thin pack leans on what the branch already has) cannot be read, and is left
  // out: if it was a commit the line of history through it is not seen, and `buildsOn` then does not prove the push. Nothing is guessed.

  const commits = new Map<string, string[]>();
  for (const entry of entries) {
    const object = entry.done;
    if (!object || object.type !== 1) continue;
    const text = object.data.toString('utf8');
    const head = text.split('\n\n', 1)[0];
    const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]);
    commits.set(idOf(1, object.data), parents);
  }
  return commits;
}

/**
 * Whether `oldId` can be reached from `newId` through commits in the pack: the new tip builds on what the branch has now. A tip that
 * is not in the pack (an older commit the branch is being moved back to), or a line of history that leaves the pack before meeting
 * `oldId`, is not proved, and so is not taken for an addition.
 */
export function buildsOn(commits: Map<string, string[]>, oldId: string, newId: string): boolean {
  if (!HEX40.test(oldId) || !HEX40.test(newId)) return false;
  if (oldId === newId) return true;
  if (!commits.has(newId)) return false;
  const seen = new Set<string>();
  const queue = [newId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (id === oldId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const parent of commits.get(id) ?? []) queue.push(parent);
  }
  return false;
}
