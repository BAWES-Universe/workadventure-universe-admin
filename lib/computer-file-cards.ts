import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@/lib/db';
import { artifactBucket } from '@/lib/artifact-storage';
import { derivedKey } from '@/lib/encryption';
import { parseFilesList, type FileEntry, type FilesList } from '@/lib/computer-files';
import type { ComputerProvider } from '@/lib/computer-provider';

/**
 * The file card: when a computer job ends well, the files it made reach the person's chat as downloadable cards (mock v10, part 4, picture 8).
 *
 * A Brick's computer is not reachable from the bot server, and its key must never leave Orbit, so Orbit moves the files itself while the machine
 * is still awake for the job that just ended (nothing here wakes a resting machine):
 *   1. the files the job made are picked from the machine's own list: what the list at the end has that the list taken when the job began did not
 *      (same path, size and time: never a guess from when a file was last touched), newest first, no hidden folder, nothing an earlier job already
 *      handed over, never more files or bigger files than Limits say;
 *   2. each is read through the machine's command channel in pieces (a command's answer is cut at 512 KB), after checking it is a plain file in the
 *      home folder and not a link to somewhere else, and checked again at the end that it did not change while it was read;
 *   3. it is kept in Universe's bucket ENCRYPTED, under a name of its own, as the person's own result (their Files, owner only): the chat gets a copy
 *      (the bot server fetches it and says when the chat took it), and the result stays whether or not the chat did, until the person deletes it,
 *      `computerFileDays` pass, or the Brick is deleted;
 *   4. a row stays behind with the file's name, path and time so the same file is never handed over twice, and with whether the chat took it.
 * What cannot be handed over (too many, too big, unreadable, the time ran out) is still named in the message by the report, and stays on the computer.
 */

const MAGIC = Buffer.from('UBF1');
const NONCE = 12;
const TAG = 16;
const PURPOSE = 'universe-computer-file-card';
/** A command's answer is cut at 512 KB; base64 makes 3 bytes into 4 characters, so this many bytes always fit. */
export const PIECE_BYTES = 300_000;
/** Pieces of one file asked at the same time. */
const PIECES_AT_ONCE = 4;
/** The most time handing over may take after a job ends: the machine is held for it, so it is counted as the job's time. What is left is only named. */
export const HAND_OVER_BUDGET_MS = 2 * 60_000;
/** The longest handing over can still be running (the budget, and one last command that was already asked): after this its claim on the machine is stale, and nothing is written after it. */
export const HAND_OVER_LATEST_MS = HAND_OVER_BUDGET_MS + 2 * 60_000;
const NAME_MAX = 120;

export const cardKey = (botId: string, fileId: string) => `computer-files/${botId}/${fileId}.ubf`;

// ---------- Where the bytes are kept ----------

export interface CardStore {
  put(key: string, sealed: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(keys: string[]): Promise<void>;
}

const bucketStore: CardStore = {
  async put(key, sealed) {
    const { s3, bucket } = artifactBucket();
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: sealed, ContentType: 'application/octet-stream', CacheControl: 'private, no-store' }));
  },
  async get(key) {
    const { s3, bucket } = artifactBucket();
    const found = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!found.Body) throw new Error('The file is not there');
    return Buffer.from(await found.Body.transformToByteArray());
  },
  async remove(keys) {
    const { s3, bucket } = artifactBucket();
    for (let at = 0; at < keys.length; at += 1000) {
      const part = keys.slice(at, at + 1000);
      const answer = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: part.map((Key) => ({ Key })), Quiet: true } }));
      if (answer.Errors && answer.Errors.length > 0) throw new Error('Some files could not be deleted');
    }
  },
};

let store: CardStore = bucketStore;
/** A test keeps the bytes in memory. Pass null to go back to the bucket. */
export function setCardStoreForTests(replacement: CardStore | null): void {
  store = replacement ?? bucketStore;
}

/** "UBF1", a 12-byte nonce, the encrypted file, a 16-byte tag. The key's own name is bound to it, so a copy swapped under another name is refused. */
export function sealCard(key: string, data: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(PURPOSE), nonce);
  cipher.setAAD(Buffer.from(key));
  return Buffer.concat([MAGIC, nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

export function openCard(key: string, file: Buffer): Buffer {
  if (file.length < MAGIC.length + NONCE + TAG || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a kept file');
  const decipher = createDecipheriv('aes-256-gcm', derivedKey(PURPOSE), file.subarray(MAGIC.length, MAGIC.length + NONCE));
  decipher.setAAD(Buffer.from(key));
  decipher.setAuthTag(file.subarray(file.length - TAG));
  return Buffer.concat([decipher.update(file.subarray(MAGIC.length + NONCE, file.length - TAG)), decipher.final()]);
}

// ---------- Which files ----------

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/** What the chat card is told the file is, from its name only. A page, script or anything unknown is plain bytes to download: never something the chat opens as a page. */
export function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return MIME[extension] ?? 'application/octet-stream';
}

/** The name the person's card shows: the file's own name, with nothing that is a folder, a control character or a way to pretend to be another file. Keeps the ending when it is cut. */
export function cardName(path: string): string {
  const last = path.split('/').pop() ?? '';
  const cleaned = last.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  if (cleaned.length <= NAME_MAX) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ending = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return `${cleaned.slice(0, NAME_MAX - ending.length - 1).trimEnd()}…${ending}`;
}

/** The identity of one file on a list: where, how big and when it was last changed. */
const identityOf = (entry: FileEntry): string => `${entry.path}\t${entry.bytes}\t${entry.modifiedAt}`;

/**
 * What a job made: the files the list at its end has that the list from before it began did not, by path, size and time. A file that was there
 * before and not touched is never the job's, however recently it was touched before; one the job changed is. Nothing at all when the list from
 * before is missing: without it nothing can be proved, so nothing is attributed. Pure.
 */
export function madeInJob(end: FilesList | null, start: FilesList | null): FileEntry[] {
  if (!end || !start) return [];
  const before = new Set(start.items.map(identityOf));
  // The list is cut at its newest files: a file older than all of them is on neither list and could not have been made by the job
  return end.items.filter((entry) => !before.has(identityOf(entry)));
}

export interface Picked {
  entry: FileEntry;
  name: string;
}

/**
 * The files of a list a job made, to hand over: new since the job began (madeInJob), in no hidden folder, with something in them, not over the biggest
 * size, none already handed over (by path and time), newest first, at most `count`. Pure.
 */
export function pickFiles(list: FilesList | null, start: FilesList | null, limits: { count: number; bytes: number }, handed: (entry: FileEntry) => boolean): Picked[] {
  if (limits.count <= 0) return [];
  const picked: Picked[] = [];
  for (const entry of madeInJob(list, start)) {
    if (entry.path.split('/').some((part) => part.startsWith('.'))) continue;
    if (entry.bytes <= 0 || entry.bytes > limits.bytes) continue;
    if (handed(entry)) continue;
    picked.push({ entry, name: cardName(entry.path) });
    if (picked.length >= limits.count) break;
  }
  return picked;
}

// ---------- Reading a file from the machine ----------

/** Single-quoted for `sh`: whatever the name holds is text, never a command. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * What every read starts with: in the home folder, and the path is a plain file whose real place is exactly where it says (a link, or a folder that
 * is a link, to anywhere else is refused: the agent could make "receipt.pdf" a link to a key). Exit 4: not a plain file. Exit 5: not where it says.
 */
function preamble(path: string): string {
  return [
    'cd "${HOME:-/home/node}" 2>/dev/null || exit 9',
    `f=${shellQuote(`./${path}`)}`,
    '[ -f "$f" ] && [ ! -L "$f" ] || exit 4',
    '[ "$(readlink -f -- "$f")" = "$(pwd -P)/${f#./}" ] || exit 5',
  ].join('\n');
}

/** Size and modified time (seconds) of the file now, after the checks. */
export const probeCommand = (path: string): string => `${preamble(path)}\nprintf '%s %s\\n' "$(stat -c %s -- "$f")" "$(stat -c %Y -- "$f")"`;
/** `length` bytes from `offset`, as one line of base64. */
export const pieceCommand = (path: string, offset: number, length: number): string => `${preamble(path)}\ntail -c +${offset + 1} -- "$f" | head -c ${length} | base64 -w0`;

type Exec = Pick<ComputerProvider, 'exec'>;

/**
 * The bytes of one file, or null when it cannot be had whole and unchanged: not a plain file, not where it says, a different size or time than the
 * list said, a piece that was cut or did not add up, or it changed while it was read. Never returns part of a file.
 */
export async function readFile(provider: Exec, ref: string, entry: FileEntry, deadline: number, clock: () => number = Date.now): Promise<Buffer | null> {
  const probe = async (): Promise<{ bytes: number; at: number } | null> => {
    const answer = await provider.exec(ref, probeCommand(entry.path), { timeoutMs: 20_000 });
    if (answer.exitCode !== 0 || answer.truncated) return null;
    const match = /^(\d+) (\d+)\s*$/.exec(answer.stdout);
    return match ? { bytes: Number(match[1]), at: Number(match[2]) } : null;
  };
  const before = await probe();
  if (!before || before.bytes !== entry.bytes || new Date(before.at * 1000).toISOString() !== entry.modifiedAt) return null;
  const offsets: number[] = [];
  for (let offset = 0; offset < before.bytes; offset += PIECE_BYTES) offsets.push(offset);
  const parts: Buffer[] = [];
  for (let at = 0; at < offsets.length; at += PIECES_AT_ONCE) {
    if (clock() > deadline) return null;
    const group = offsets.slice(at, at + PIECES_AT_ONCE);
    const got = await Promise.all(
      group.map(async (offset) => {
        const length = Math.min(PIECE_BYTES, before.bytes - offset);
        const answer = await provider.exec(ref, pieceCommand(entry.path, offset, length), { timeoutMs: 60_000 });
        if (answer.exitCode !== 0 || answer.truncated) return null;
        const text = answer.stdout.trim();
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
        const bytes = Buffer.from(text, 'base64');
        return bytes.length === length ? bytes : null;
      })
    );
    for (const piece of got) {
      if (!piece) return null;
      parts.push(piece);
    }
  }
  const data = Buffer.concat(parts);
  if (data.length !== before.bytes) return null;
  const after = await probe();
  return after && after.bytes === before.bytes && after.at === before.at ? data : null;
}

// ---------- Handing a job's files over ----------

export interface HandOverLimits {
  /** Files at most. 0 hands none over. */
  count: number;
  /** Bytes of the biggest file. */
  bytes: number;
}

/**
 * Moves the files a job made from its machine into Universe, as far as the limits and the time allow. Never throws: a failure only means fewer files
 * (the message names the ones left). Returns how many were handed over and how long it took, which is machine time held for the job.
 */
export async function handOverFiles(input: { jobId: string; botId: string; start: FilesList | null; ref: string; provider: Exec; limits: HandOverLimits; clock?: () => number }): Promise<{ handed: number; ms: number }> {
  const clock = input.clock ?? Date.now;
  const began = clock();
  let handed = 0;
  try {
    if (input.limits.count <= 0) return { handed, ms: 0 };
    const listed = await input.provider.exec(input.ref, 'universe-files', { timeoutMs: 20_000 });
    if (listed.exitCode !== 0 || listed.truncated) return { handed, ms: clock() - began };
    const list = parseFilesList(listed.stdout, new Date());
    // What an earlier job already handed over (its row stays, without the bytes), so one file is never handed over twice
    const earlier = await prisma.computerJobFile.findMany({ where: { botId: input.botId }, select: { path: true, modifiedAt: true } });
    const known = new Set(earlier.map((row) => `${row.modifiedAt.toISOString()}\t${row.path}`));
    const picks = pickFiles(list, input.start, input.limits, (entry) => known.has(`${entry.modifiedAt}\t${entry.path}`));
    const deadline = began + HAND_OVER_BUDGET_MS;
    for (const pick of picks) {
      if (clock() > deadline) break;
      try {
        const data = await readFile(input.provider, input.ref, pick.entry, deadline, clock);
        if (!data) continue;
        const row = await prisma.computerJobFile.create({
          data: { jobId: input.jobId, botId: input.botId, name: pick.name, path: pick.entry.path, modifiedAt: new Date(pick.entry.modifiedAt), bytes: data.length, mimeType: mimeOf(pick.name) },
          select: { id: true },
        }).catch((error: { code?: string }) => {
          // The same file at the same time, handed over by a job at the same moment: that one has it
          if (error?.code === 'P2002') return null;
          throw error;
        });
        if (!row) continue;
        const key = cardKey(input.botId, row.id);
        try {
          await store.put(key, sealCard(key, data));
          await prisma.computerJobFile.update({ where: { id: row.id }, data: { storageKey: key } });
          handed += 1;
        } catch (error) {
          // Not kept: the row would claim a file that is not there, so it goes (the file can be handed over by a later job)
          await store.remove([key]).catch(() => undefined);
          await prisma.computerJobFile.delete({ where: { id: row.id } }).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        console.error('[Computer] Could not hand over a file:', error instanceof Error ? error.message : 'unknown');
      }
    }
  } catch (error) {
    console.error('[Computer] Could not hand over the files of a job:', error instanceof Error ? error.message : 'unknown');
  }
  return { handed, ms: Math.max(0, clock() - began) };
}

// ---------- What the report and the bot server read ----------

export interface Card {
  id: string;
  name: string;
  bytes: number;
  mime: string;
}

/** The files of these jobs the chat has not taken yet, oldest first. `path` is Orbit's own: it never goes to the bot server. */
export async function cardsOfJobs(jobIds: string[]): Promise<Map<string, (Card & { path: string })[]>> {
  const out = new Map<string, (Card & { path: string })[]>();
  if (jobIds.length === 0) return out;
  const rows = await prisma.computerJobFile.findMany({ where: { jobId: { in: jobIds }, storageKey: { not: null }, deliveredAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const row of rows) out.set(row.jobId, [...(out.get(row.jobId) ?? []), { id: row.id, name: row.name, bytes: row.bytes, mime: row.mimeType, path: row.path }]);
  return out;
}

/** One kept file's bytes for the bot server, or null when it is not there (deleted, past Limits' days, or never the job's). */
export async function readCard(jobId: string, fileId: string): Promise<{ name: string; mime: string; data: Buffer } | null> {
  const row = await prisma.computerJobFile.findUnique({ where: { id: fileId } });
  if (!row || row.jobId !== jobId || !row.storageKey) return null;
  try {
    return { name: row.name, mime: row.mimeType, data: openCard(row.storageKey, await store.get(row.storageKey)) };
  } catch (error) {
    console.error('[Computer] Could not read a kept file:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/**
 * Deletes the kept bytes of the rows given (the copy first, then the row's pointer to it, so a copy that could not be deleted is tried again). The
 * rows stay as the record that the file was handed over. Throws when a copy could not be deleted.
 */
async function purge(rows: { id: string; storageKey: string | null }[]): Promise<number> {
  const held = rows.filter((row): row is { id: string; storageKey: string } => !!row.storageKey);
  if (held.length === 0) return 0;
  await store.remove(held.map((row) => row.storageKey));
  await prisma.computerJobFile.updateMany({ where: { id: { in: held.map((row) => row.id) } }, data: { storageKey: null, purgedAt: new Date() } });
  return held.length;
}

/** The chat took this file: it is marked, so a restart never sends it again. A file of another job is never marked. Safe to say twice. False when there is no such file. */
export async function markFileDelivered(jobId: string, fileId: string, now: Date = new Date()): Promise<boolean> {
  const row = await prisma.computerJobFile.findUnique({ where: { id: fileId }, select: { jobId: true } });
  if (!row || row.jobId !== jobId) return false;
  await prisma.computerJobFile.updateMany({ where: { id: fileId, deliveredAt: null }, data: { deliveredAt: now } });
  return true;
}

export type ResultDelivery = 'delivered' | 'waiting' | 'not_delivered';

export interface Result {
  id: string;
  jobId: string;
  name: string;
  bytes: number;
  mime: string;
  jobTitle: string;
  /** When the job made it. */
  at: Date;
  /** Whether the chat took it: `waiting` while it is still being tried, `not_delivered` once the chat did not (and will not) take it. */
  delivery: ResultDelivery;
}

/** A person's results from a Brick's computer, newest first: kept files that are still theirs to open, whether or not the chat took them. */
export async function resultsOf(botId: string, personId: string, take = 100): Promise<Result[]> {
  const rows = await prisma.computerJobFile.findMany({
    where: { botId, storageKey: { not: null }, job: { personId } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    include: { job: { select: { title: true, endToldAt: true, endUndeliverableAt: true, status: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    name: row.name,
    bytes: row.bytes,
    mime: row.mimeType,
    jobTitle: row.job.title,
    at: row.createdAt,
    // Taken: delivered. Not taken, but the message was told or can never be told: the chat did not take it. Otherwise it is still being tried.
    delivery: row.deliveredAt ? 'delivered' : row.job.endToldAt || row.job.endUndeliverableAt ? 'not_delivered' : 'waiting',
  }));
}

/** One of a person's results, to open: only when it is theirs (their job) on this Brick. Null when it is not there or not theirs. */
export async function readResult(botId: string, personId: string, fileId: string): Promise<{ name: string; mime: string; data: Buffer } | null> {
  const row = await prisma.computerJobFile.findFirst({ where: { id: fileId, botId, job: { personId } } });
  if (!row || !row.storageKey) return null;
  try {
    return { name: row.name, mime: row.mimeType, data: openCard(row.storageKey, await store.get(row.storageKey)) };
  } catch (error) {
    console.error('[Computer] Could not read a result:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** The person deletes one of their results: the kept copy goes, and the row stays as the record that it was handed over (so it never comes back). False when it is not theirs. */
export async function deleteResult(botId: string, personId: string, fileId: string): Promise<boolean> {
  const row = await prisma.computerJobFile.findFirst({ where: { id: fileId, botId, job: { personId }, storageKey: { not: null } }, select: { id: true, storageKey: true } });
  if (!row) return false;
  await purge([row]);
  return true;
}

/** A Brick is going for good: every copy kept for it is deleted first. Throws when one cannot be, so the Brick waits for the next sweep. */
export const purgeCardsOfBot = async (botId: string): Promise<number> => purge(await prisma.computerJobFile.findMany({ where: { botId, storageKey: { not: null } }, select: { id: true, storageKey: true } }));

/** Results older than the days in Limits are deleted (their rows stay as the record). */
export async function purgeStaleCards(now: Date, days: number, batch = 500): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return purge(await prisma.computerJobFile.findMany({ where: { storageKey: { not: null }, createdAt: { lte: cutoff } }, orderBy: { createdAt: 'asc' }, take: batch, select: { id: true, storageKey: true } }));
}
