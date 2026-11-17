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
/** The most bytes a pack may unzip to and rebuild from deltas, all objects together: a small pack of deltas on one big base can ask for terabytes. */
const MAX_TOTAL_BYTES = 2 * VERIFY_MAX_BYTES;
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
  /** The object's id, once it is done. */
  id?: string;
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
  let total = 0;
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
      total += size;
      if (total > MAX_TOTAL_BYTES) return null;
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

  // Deltas are put together from their bases, which may themselves be deltas. Each delta waits on its base (by offset or by id) and is put together
  // once, when that base is done: one pass over the entries however the chains run, never a pass over everything for each one settled
  const waitingOnOffset = new Map<number, Entry[]>();
  const waitingOnId = new Map<string, Entry[]>();
  const queue: Entry[] = [];
  const settle = (entry: Entry, object: { type: number; data: Buffer }) => {
    entry.done = object;
    entry.id = idOf(object.type, object.data);
    queue.push(entry);
  };
  const wait = <K,>(map: Map<K, Entry[]>, key: K, entry: Entry) => map.set(key, [...(map.get(key) ?? []), entry]);
  for (const entry of entries) {
    if (entry.type <= 4) continue;
    if (entry.baseOffset !== undefined) wait(waitingOnOffset, entry.baseOffset, entry);
    else if (entry.baseId !== undefined) wait(waitingOnId, entry.baseId, entry);
  }
  for (const entry of entries) if (entry.type <= 4) settle(entry, { type: entry.type, data: entry.data });
  let rebuilt = 0;
  while (queue.length > 0) {
    const base = queue.pop() as Entry;
    const object = base.done as { type: number; data: Buffer };
    const dependents = [...(waitingOnOffset.get(base.offset) ?? []), ...(waitingOnId.get(base.id as string) ?? [])];
    waitingOnOffset.delete(base.offset);
    waitingOnId.delete(base.id as string);
    for (const entry of dependents) {
      if (entry.done) continue;
      const data = applyDelta(object.data, entry.data);
      // A delta that does not apply stays unread, as before
      if (!data) continue;
      rebuilt += data.length;
      if (rebuilt > MAX_TOTAL_BYTES) return null;
      settle(entry, { type: object.type, data });
    }
  }
  // What is still a delta of something outside the pack (a thin pack leans on what the branch already has) cannot be read, and is left
  // out: if it was a commit the line of history through it is not seen, and `buildsOn` then does not prove the push. Nothing is guessed.

  const commits = new Map<string, string[]>();
  for (const entry of entries) {
    const object = entry.done;
    if (!object || object.type !== 1) continue;
    // Read as git reads a commit: `tree` first, then the `parent` lines directly after it. A "parent" line further down (after author or committer,
    // or in the message) is not a parent, so it can neither hide the real history nor make the push look like it builds on the branch
    const lines = object.data.toString('utf8').split('\n\n', 1)[0].split('\n');
    if (!/^tree [0-9a-f]{40}$/.test(lines[0] ?? '')) continue;
    const parents: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parent = /^parent ([0-9a-f]{40})$/.exec(lines[i]);
      if (!parent) break;
      parents.push(parent[1]);
    }
    commits.set(entry.id as string, parents);
  }
  return commits;
}

/**
 * Whether `oldId` can be reached from `newId` through commits in the pack: the new tip builds on what the branch has now.
 *  - `true`: proved from the pack alone.
 *  - a list: not proved by the pack, but the line of history left the pack at these commits (ones GitHub already has, which git leaves
 *    out of a thin pack). If one of them comes after `oldId` on GitHub, the push still builds on the branch; the caller asks GitHub.
 *  - `false`: the tip is not in the pack at all, or the history leads nowhere that could be asked about.
 */
export function buildsOn(commits: Map<string, string[]>, oldId: string, newId: string): boolean | string[] {
  if (!HEX40.test(oldId) || !HEX40.test(newId)) return false;
  if (oldId === newId) return true;
  if (!commits.has(newId)) return false;
  const seen = new Set<string>();
  const outside = new Set<string>();
  const queue = [newId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (id === oldId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!commits.has(id)) {
      outside.add(id);
      continue;
    }
    for (const parent of commits.get(id) ?? []) queue.push(parent);
  }
  return outside.size > 0 ? [...outside] : false;
}
