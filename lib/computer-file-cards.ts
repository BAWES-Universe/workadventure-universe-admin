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
 *   1. the files the job made are the ones in its OWN output folder (`Outputs/<job id>`, which the agent is told to save its results in): the folder
 *      is the proof of which job made a file, so nothing depends on when a file was last touched, a job running beside it cannot be given its files, and
 *      a file anywhere else on the machine is never handed over, however new. Newest first, no hidden folder, nothing already handed over, never more
 *      files or bigger files than Limits say;
 *   2. each is read through the machine's command channel in pieces (a command's answer is cut at 512 KB), after checking it is a plain file in the
 *      home folder and not a link to somewhere else, and checked again at the end that it did not change while it was read;
 *   3. it is kept in Universe's bucket ENCRYPTED, under a name of its own, as the person's own result: an owned record (owner, the job and Brick that made
 *      it, when) that is theirs alone (Files, owner only) and publishes nothing. The chat gets a copy (the bot server fetches it and says when the chat took
 *      it). The result stays whether or not the chat took it, whether or not the provider's copy or the computer is still there, until the person deletes it
 *      or `computerFileDays` pass. Deleting the Brick that made it does NOT delete it: it stays, under "A deleted Brick";
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

/**
 * The folder a job saves what it makes for the person in, from the home folder. It is the job's own (its id is in the name), so a file in it can only be
 * this job's: this, and nothing about when a file was touched, is what says a file is a job's result. The agent is told it in its first prompt (the bot server
 * uses the same name).
 */
export const outputFolder = (jobId: string): string => `Outputs/${jobId}`;

/** The command that lists the files in a job's own folder, one line each as `universe-files` prints them: size, TAB, modified (seconds), TAB, path from the home folder. At most 201 lines. */
export const outputListCommand = (jobId: string): string =>
  [
    'cd "${HOME:-/home/node}" 2>/dev/null || exit 0',
    `d=${shellQuote(outputFolder(jobId))}`,
    '[ -d "$d" ] && [ ! -L "$d" ] || exit 0',
    // Plain files only (never a link), no hidden folder, the newest first
    String.raw`find "$d" -maxdepth 4 \( -name '.*' \) -prune -o -type f -printf '%s\t%T@\t%p\n' 2>/dev/null | sort -t "$(printf '\t')" -k2,2nr | head -n 201`,
  ].join('\n');

/**
 * What a job made OUTSIDE its output folder, only to be named (never handed over): the files on the list at its end whose path was not on the list from
 * before it began. By path alone: a file that was there before is never claimed, however it was touched since. Nothing at all when the list from before is
 * missing: without it nothing can be said. Pure.
 */
export function madeInJob(end: FilesList | null, start: FilesList | null): FileEntry[] {
  if (!end || !start) return [];
  const before = new Set(start.items.map((entry) => entry.path));
  // The list is cut at its newest files: a file older than all of them is on neither list and could not have been made by the job
  return end.items.filter((entry) => !before.has(entry.path));
}

export interface Picked {
  entry: FileEntry;
  name: string;
}

/** A path is inside the job's folder: below it, with no way out of it and no hidden part. */
export function insideFolder(path: string, folder: string): boolean {
  if (!path.startsWith(`${folder}/`)) return false;
  return path.slice(folder.length + 1).split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'));
}

/**
 * The files to hand over, from the list of the job's own folder: the ones inside it, with something in them, not over the biggest size, none already handed over
 * (by path and time), newest first, at most `count`. Pure.
 */
export function pickFiles(list: FilesList | null, folder: string, limits: { count: number; bytes: number }, handed: (entry: FileEntry) => boolean): Picked[] {
  if (limits.count <= 0 || !list) return [];
  const picked: Picked[] = [];
  for (const entry of list.items) {
    if (!insideFolder(entry.path, folder)) continue;
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
export async function handOverFiles(input: {
  jobId: string;
  botId: string;
  /** Whose the files are, the name of the Brick that made them and what the job was called: kept with each as its provenance. */
  ownerId: string;
  makerName: string;
  jobTitle: string;
  ref: string;
  provider: Exec;
  limits: HandOverLimits;
  clock?: () => number;
}): Promise<{ handed: number; ms: number }> {
  const clock = input.clock ?? Date.now;
  const began = clock();
  let handed = 0;
  try {
    if (input.limits.count <= 0) return { handed, ms: 0 };
    const listed = await input.provider.exec(input.ref, outputListCommand(input.jobId), { timeoutMs: 20_000 });
    if (listed.exitCode !== 0 || listed.truncated) return { handed, ms: clock() - began };
    const list = parseFilesList(listed.stdout, new Date());
    // What an earlier job already handed over (its row stays, without the bytes), so one file is never handed over twice
    const earlier = await prisma.computerJobFile.findMany({ where: { botId: input.botId }, select: { path: true, modifiedAt: true } });
    const known = new Set(earlier.map((row) => `${row.modifiedAt.toISOString()}\t${row.path}`));
    const picks = pickFiles(list, outputFolder(input.jobId), input.limits, (entry) => known.has(`${entry.modifiedAt}\t${entry.path}`));
    const deadline = began + HAND_OVER_BUDGET_MS;
    for (const pick of picks) {
      if (clock() > deadline) break;
      try {
        const data = await readFile(input.provider, input.ref, pick.entry, deadline, clock);
        if (!data) continue;
        const row = await prisma.computerJobFile.create({
          data: { jobId: input.jobId, botId: input.botId, ownerId: input.ownerId, makerName: input.makerName, jobTitle: input.jobTitle, name: pick.name, path: pick.entry.path, modifiedAt: new Date(pick.entry.modifiedAt), bytes: data.length, mimeType: mimeOf(pick.name) },
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
  for (const row of rows) if (row.jobId) out.set(row.jobId, [...(out.get(row.jobId) ?? []), { id: row.id, name: row.name, bytes: row.bytes, mime: row.mimeType, path: row.path }]);
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

/** What a result says made it once its Brick is gone (deleted, waiting out its Undo days, or removed for good): only the name goes, the file stays. */
export const DELETED_BRICK_LABEL = 'A deleted Brick';

export interface Result {
  id: string;
  /** The job that made it; null once that job is gone with its Brick. */
  jobId: string | null;
  name: string;
  bytes: number;
  mime: string;
  jobTitle: string;
  /** The Brick that made it, as the person knows it: the name it has now, or `DELETED_BRICK_LABEL` when it is gone. */
  brick: string;
  /** The Brick's id, kept when it is deleted (the provenance of the file). */
  brickId: string;
  /** When the job made it. */
  at: Date;
  /** Whether the chat took it: `waiting` while it is still being tried, `not_delivered` once the chat did not (and will not) take it. */
  delivery: ResultDelivery;
}

type ResultRow = {
  id: string;
  jobId: string | null;
  botId: string;
  name: string;
  bytes: number;
  mimeType: string;
  jobTitle: string;
  createdAt: Date;
  deliveredAt: Date | null;
  job: { endToldAt: Date | null; endUndeliverableAt: Date | null } | null;
};

const RESULT_INCLUDE = { job: { select: { endToldAt: true, endUndeliverableAt: true } } } as const;

function resultOf(row: ResultRow, brick: string): Result {
  return {
    id: row.id,
    jobId: row.jobId,
    name: row.name,
    bytes: row.bytes,
    mime: row.mimeType,
    jobTitle: row.jobTitle,
    brick,
    brickId: row.botId,
    at: row.createdAt,
    // Taken: delivered. Not taken, but the message was told or can never be told, or the job is gone: the chat did not take it. Otherwise it is still being tried.
    delivery: row.deliveredAt ? 'delivered' : !row.job || row.job.endToldAt || row.job.endUndeliverableAt ? 'not_delivered' : 'waiting',
  };
}

/** A person's results from one of their Bricks, newest first: kept files that are still theirs to open, whether or not the chat took them. */
export async function resultsOf(botId: string, personId: string, take = 100): Promise<Result[]> {
  const rows = await prisma.computerJobFile.findMany({
    where: { botId, ownerId: personId, storageKey: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    include: RESULT_INCLUDE,
  });
  const bot = rows.length > 0 ? await prisma.bot.findUnique({ where: { id: botId }, select: { name: true, deletedAt: true } }) : null;
  const brick = bot && !bot.deletedAt ? bot.name : DELETED_BRICK_LABEL;
  return rows.map((row) => resultOf(row, brick));
}

/**
 * A person's results whose Brick is gone (deleted, waiting out its Undo days, or removed for good), newest first. They are theirs and stay: only the Brick's name on
 * them is "A deleted Brick". Results of a Brick that is still there are listed on that Brick's own Files instead.
 */
export async function orphanResultsOf(personId: string, take = 100): Promise<Result[]> {
  const rows = await prisma.computerJobFile.findMany({
    where: { ownerId: personId, storageKey: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 500,
    include: RESULT_INCLUDE,
  });
  if (rows.length === 0) return [];
  const bots = await prisma.bot.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.botId))] } }, select: { id: true, deletedAt: true } });
  const alive = new Set(bots.filter((bot) => !bot.deletedAt).map((bot) => bot.id));
  return rows
    .filter((row) => !alive.has(row.botId))
    .slice(0, take)
    .map((row) => resultOf(row, DELETED_BRICK_LABEL));
}

type Opened = { name: string; mime: string; data: Buffer };

async function open(row: { storageKey: string | null; name: string; mimeType: string } | null): Promise<Opened | null> {
  if (!row || !row.storageKey) return null;
  try {
    return { name: row.name, mime: row.mimeType, data: openCard(row.storageKey, await store.get(row.storageKey)) };
  } catch (error) {
    console.error('[Computer] Could not read a result:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** One of a person's results, to open, from one of their Bricks: only when it is theirs and that Brick's. Null when it is not there or not theirs. */
export async function readResult(botId: string, personId: string, fileId: string): Promise<Opened | null> {
  return open(await prisma.computerJobFile.findFirst({ where: { id: fileId, botId, ownerId: personId } }));
}

/** One of a person's own results, whichever Brick made it (the Brick may be gone). Null when it is not there or not theirs. */
export async function readOwnResult(personId: string, fileId: string): Promise<Opened | null> {
  return open(await prisma.computerJobFile.findFirst({ where: { id: fileId, ownerId: personId } }));
}

/** The person deletes one of their results from one of their Bricks: the kept copy goes, and the row stays as the record that it was handed over (so it never comes back). False when it is not theirs. */
export async function deleteResult(botId: string, personId: string, fileId: string): Promise<boolean> {
  const row = await prisma.computerJobFile.findFirst({ where: { id: fileId, botId, ownerId: personId, storageKey: { not: null } }, select: { id: true, storageKey: true } });
  if (!row) return false;
  await purge([row]);
  return true;
}

/** The person deletes one of their own results, whichever Brick made it. False when it is not theirs. */
export async function deleteOwnResult(personId: string, fileId: string): Promise<boolean> {
  const row = await prisma.computerJobFile.findFirst({ where: { id: fileId, ownerId: personId, storageKey: { not: null } }, select: { id: true, storageKey: true } });
  if (!row) return false;
  await purge([row]);
  return true;
}

/** Results older than the days in Limits are deleted (their rows stay as the record). */
export async function purgeStaleCards(now: Date, days: number, batch = 500): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return purge(await prisma.computerJobFile.findMany({ where: { storageKey: { not: null }, createdAt: { lte: cutoff } }, orderBy: { createdAt: 'asc' }, take: batch, select: { id: true, storageKey: true } }));
}
