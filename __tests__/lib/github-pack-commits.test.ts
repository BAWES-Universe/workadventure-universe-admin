import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { buildsOn, readPackCommits } from '@/lib/github/pack-commits';

/** Packs written by hand, so what the relay reads can be bent in ways a real git never would. */
const idOf = (type: string, data: Buffer) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');

const entryHead = (type: number, size: number): Buffer => {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
};
const whole = (type: number, data: Buffer) => Buffer.concat([entryHead(type, data.length), deflateSync(data)]);
const refDelta = (baseId: string, delta: Buffer) => Buffer.concat([entryHead(7, delta.length), Buffer.from(baseId, 'hex'), deflateSync(delta)]);
const pack = (entries: Buffer[]) => {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  return Buffer.concat([head, ...entries]);
};
const varint = (n: number): number[] => {
  const out: number[] = [];
  let value = n;
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
};
/** A delta that copies the first `keep` bytes of the base and then adds `tail`. */
const delta = (baseSize: number, keep: number, tail: Buffer) => {
  const copy: number[] = [];
  // length in up to 3 bytes (bit 0x10, 0x20, 0x40); offset 0 needs none
  const lengthBytes = [keep & 0xff, (keep >> 8) & 0xff, (keep >> 16) & 0xff];
  let flags = 0x80;
  lengthBytes.forEach((byte, i) => {
    if (byte) {
      flags |= 0x10 << i;
      copy.push(byte);
    }
  });
  return Buffer.concat([Buffer.from([...varint(baseSize), ...varint(keep + tail.length)]), Buffer.from([flags, ...copy]), Buffer.from([tail.length]), tail]);
};

const T = 'a'.repeat(40);
const commit = (lines: string[], message = 'msg\n') => Buffer.from(`${lines.join('\n')}\n\n${message}`);

describe('reading the commits of a pack', () => {
  it('takes the parents of a commit only from the lines directly after tree, as git does', () => {
    const X = 'b'.repeat(40);
    const OLD = 'c'.repeat(40);
    const P2 = 'd'.repeat(40);
    // A "parent" line after author and committer is not a parent: git records only X for this commit
    const sneaky = commit([`tree ${T}`, `parent ${X}`, 'author a <a@b.c> 1 +0000', 'committer a <a@b.c> 1 +0000', `parent ${OLD}`]);
    const merge = commit([`tree ${T}`, `parent ${X}`, `parent ${P2}`, 'author a <a@b.c> 1 +0000', 'committer a <a@b.c> 1 +0000']);
    const noTree = commit([`parent ${X}`, `tree ${T}`, 'author a <a@b.c> 1 +0000']);
    const commits = readPackCommits(pack([whole(1, sneaky), whole(1, merge), whole(1, noTree)])) as Map<string, string[]>;
    expect(commits.get(idOf('commit', sneaky))).toEqual([X]);
    expect(commits.get(idOf('commit', merge))).toEqual([X, P2]);
    // Not a commit as git reads one: not taken at all, so a push through it is never taken for an addition
    expect(commits.has(idOf('commit', noTree))).toBe(false);
    expect(buildsOn(commits, OLD, idOf('commit', sneaky))).toEqual([X]);
  });

  it('resolves a long chain of deltas, each on the object the next one rebuilds, in one pass', () => {
    // 20,000 commits, each the one before with its last two bytes changed; the pack lists the last link first and the plain commit last
    const first = commit([`tree ${T}`, 'author a <a@b.c> 1 +0000', 'committer a <a@b.c> 1 +0000'], 'x'.repeat(100) + '00');
    const objects: Buffer[] = [first];
    const entries: Buffer[] = [];
    const N = 20_000;
    let previous = first;
    const ids: string[] = [idOf('commit', first)];
    for (let k = 1; k <= N; k++) {
      const tail = Buffer.from(String(k % 100).padStart(2, '0') + String.fromCharCode(97 + (k % 26)) + String.fromCharCode(97 + (Math.floor(k / 26) % 26)) + String.fromCharCode(97 + (Math.floor(k / 676) % 26)));
      const next = Buffer.concat([previous.subarray(0, previous.length - 5), tail]);
      // The change is in the message (after the blank line), so the header is the same and so are the parents
      entries.push(refDelta(ids[k - 1], delta(previous.length, previous.length - 5, tail)));
      ids.push(idOf('commit', next));
      objects.push(next);
      previous = next;
    }
    const started = Date.now();
    const commits = readPackCommits(pack([...entries.reverse(), whole(1, first)])) as Map<string, string[]>;
    // The old copying version took about two minutes; a busy CI machine took 4.2 s for this one, so the bound is well between them
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(commits.size).toBe(new Set(ids).size);
    expect(commits.has(ids[N])).toBe(true);
  }, 120_000);

  it('refuses a small pack of deltas that would rebuild more than a fixed total, however small each delta is', () => {
    // One 16 MB blob (it deflates to a few KB) and deltas that each rebuild all of it: five of them are 96 MB, more than the fixed total
    const size = 16_000_000;
    const base = Buffer.alloc(size);
    const baseId = idOf('blob', base);
    const make = (extra: string) => refDelta(baseId, delta(size, size - 4, Buffer.from(extra)));
    const small = pack([whole(3, base), make('aaaa')]);
    expect(small.length).toBeLessThan(1_000_000);
    expect(readPackCommits(small)).not.toBeNull();
    expect(readPackCommits(pack([whole(3, base), ...['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'].map(make)]))).toBeNull();
  });

  it('refuses deltas that declare a big result and then fail: what a delta says it will rebuild is spent before it is built', () => {
    // Each delta declares 16 MB, copies it all but its last bytes and is cut short, so it never applies; six of them still ask for 96 MB
    const size = 16_000_000;
    const base = Buffer.alloc(size);
    const baseId = idOf('blob', base);
    const broken = () => refDelta(baseId, delta(size, size - 4, Buffer.from('aaaa')).subarray(0, -1));
    expect(readPackCommits(pack([whole(3, base), broken()]))).not.toBeNull();
    expect(readPackCommits(pack([whole(3, base), ...Array.from({ length: 6 }, broken)]))).toBeNull();
  });

  it('puts together many deltas on one base without copying the list of the ones waiting for each one that joins it', () => {
    // 150,000 tiny deltas on one tiny blob: copying the waiting list for each is about 10^10 copies, a list that is added to is nothing
    const base = Buffer.from('0123456789');
    const baseId = idOf('blob', base);
    const entries: Buffer[] = [];
    for (let k = 0; k < 150_000; k++) entries.push(refDelta(baseId, delta(base.length, base.length, Buffer.from([97 + (k % 26)]))));
    const built = pack([whole(3, base), ...entries]);
    const started = Date.now();
    expect(readPackCommits(built)).not.toBeNull();
    // The copying version took about two minutes here, this one a few seconds (more on a busy CI machine): the bound is between them
    expect(Date.now() - started).toBeLessThan(40_000);
  }, 120_000);
});
