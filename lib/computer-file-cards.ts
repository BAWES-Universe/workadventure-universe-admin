import { prisma } from '@/lib/db';
import { deleteResult as deleteOwnedResult, keepResult, keptBytes, openResult, resultsOfSource } from '@/lib/owned-results';
import { getCodeJobLimits } from '@/lib/workbench/state';
import { getOutputStore } from '@/lib/workbench/store';
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
 *   3. it is kept as the person's own result in the one place every result is kept (`lib/owned-results.ts`, the same as a code job's): encrypted, an owned
 *      record (owner, the job and Brick that made it, when) that is theirs alone (Files, owner only) and publishes nothing, inside the one Limit for what a
 *      person keeps. The chat gets a copy (the bot server fetches it and says when the chat took it). The result stays whether or not the chat took it, whether
 *      or not the provider's copy or the computer is still there, until the person deletes it: there is no expiry (a result is the person's own, the same as a code job's, and counts against the same per-person Limit).
 *      Deleting the Brick that made it does NOT delete it: it stays, under "A deleted Brick";
 *   4. a row of this job's own (the delivery ledger) stays behind with the file's name, path and time so the same file is never handed over twice, with the
 *      result it became, and with whether the chat took it. It outlives the result: a result the person deleted is never handed over again.
 * What cannot be handed over (too many, too big, unreadable, the time ran out) is still named in the message by the report, and stays on the computer.
 */

/** A command's answer is cut at 512 KB; base64 makes 3 bytes into 4 characters, so this many bytes always fit. */
export const PIECE_BYTES = 300_000;
/** Pieces of one file asked at the same time. */
const PIECES_AT_ONCE = 4;
/** The most time handing over may take after a job ends: the machine is held for it, so it is counted as the job's time. What is left is only named. */
export const HAND_OVER_BUDGET_MS = 2 * 60_000;
/** The longest handing over can still be running (the budget, and one last command that was already asked): after this its claim on the machine is stale, and nothing is written after it. */
export const HAND_OVER_LATEST_MS = HAND_OVER_BUDGET_MS + 2 * 60_000;
/** A job waiting for its hand-over beats its `handOverAliveAt` this often, and is believed to be waiting while the last beat is younger than HAND_OVER_ALIVE_MS (one that stopped beating was abandoned). */
export const HAND_OVER_BEAT_MS = 5_000;
export const HAND_OVER_ALIVE_MS = 30_000;
const NAME_MAX = 120;

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
 * What every read starts with: in the home folder, the path is a plain file, and the file is OPENED once (descriptor 3) and checked as opened: its real
 * place must be exactly where the path says (a link, or a folder that is a link, to anywhere else is refused: the agent could make "receipt.pdf" a
 * link to a key). Everything after reads that one open file (size, time, bytes), never the name again, so a name swapped for a link after the check
 * cannot send the read somewhere else. Exit 4: not a plain file. Exit 5: not where it says.
 */
export function preamble(path: string): string {
  return [
    'cd "${HOME:-/home/node}" 2>/dev/null || exit 9',
    `f=${shellQuote(`./${path}`)}`,
    '[ -f "$f" ] && [ ! -L "$f" ] || exit 4',
    'exec 3< "$f" || exit 4',
    'o="/proc/$$/fd/3"',
    '[ -f "$o" ] || exit 4',
    '[ "$(readlink -f -- "$o")" = "$(pwd -P)/${f#./}" ] || exit 5',
  ].join('\n');
}

/** What says this is the same file, unchanged: its place on the disk, the time its content or its details last changed and the time it was written, to the nanosecond (a rewrite inside one second still shows). */
const SIGNATURE = `"$(stat -L -c '%i %z %y' -- "$o")"`;

/** Size, modified time (seconds) and signature of the file now, after the checks, all from the one open file. */
export const probeCommand = (path: string): string => `${preamble(path)}\nprintf '%s %s|%s\\n' "$(stat -L -c %s -- "$o")" "$(stat -L -c %Y -- "$o")" ${SIGNATURE}`;
/** The signature of the file, a line, and then `length` bytes from `offset` as one line of base64: all from the one open file. */
export const pieceCommand = (path: string, offset: number, length: number): string =>
  `${preamble(path)}\nprintf '%s\\n' ${SIGNATURE}\ntail -c +${offset + 1} <&3 | head -c ${length} | base64 -w0`;

type Exec = Pick<ComputerProvider, 'exec'>;

/**
 * The bytes of one file, or null when it cannot be had whole and unchanged: not a plain file, not where it says, a different size or time than the
 * list said, a piece that was cut or did not add up, or it changed while it was read. Never returns part of a file.
 */
export async function readFile(provider: Exec, ref: string, entry: FileEntry, deadline: number, clock: () => number = Date.now): Promise<Buffer | null> {
  const probe = async (): Promise<{ bytes: number; at: number; sig: string } | null> => {
    const answer = await provider.exec(ref, probeCommand(entry.path), { timeoutMs: 20_000 });
    if (answer.exitCode !== 0 || answer.truncated) return null;
    const match = /^(\d+) (\d+)\|(.+?)\s*$/.exec(answer.stdout);
    return match ? { bytes: Number(match[1]), at: Number(match[2]), sig: match[3] } : null;
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
        // Each piece says which version of the file it came from: pieces of two versions are never put together
        const lines = answer.stdout.trim().split('\n');
        if (lines.length !== 2 || lines[0].trim() !== before.sig) return null;
        const text = lines[1].trim();
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
  return after && after.bytes === before.bytes && after.at === before.at && after.sig === before.sig ? data : null;
}

// ---------- Handing a job's files over ----------

export interface HandOverLimits {
  /** Files at most. 0 hands none over. */
  count: number;
  /** Bytes of the biggest file. */
  bytes: number;
}

/** A name that is not one of `used` (a file of the same name in another subfolder of the job's folder gets " (2)" before its ending), never longer than a result's name may be. Pure. */
export function uniqueName(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const ending = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  const base = ending ? name.slice(0, dot) : name;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, Math.max(1, NAME_MAX - ending.length - suffix.length)).trimEnd()}${suffix}${ending}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${name.slice(0, NAME_MAX - 9)} (${Date.now() % 100000})${ending}`.slice(0, NAME_MAX);
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
    // What an earlier job already handed over (its row stays), so one file is never handed over twice
    const earlier = await prisma.computerJobFile.findMany({ where: { botId: input.botId }, select: { path: true, modifiedAt: true } });
    const known = new Set(earlier.map((row) => `${row.modifiedAt.toISOString()}\t${row.path}`));
    const picks = pickFiles(list, outputFolder(input.jobId), input.limits, (entry) => known.has(`${entry.modifiedAt}\t${entry.path}`));
    if (picks.length === 0) return { handed, ms: Math.max(0, clock() - began) };
    // What one person may keep is one Limit for every result they own (the same as a code job's): a file that would take them over it stays on the
    // computer and is named. Not set reads as nothing may be kept.
    const cap = (await getCodeJobLimits()).maxKeptBytesPerPerson;
    let personKept = await keptBytes(input.ownerId);
    const used = new Set((await resultsOfSource('computer_job', input.jobId)).map((row) => row.name));
    const store = getOutputStore();
    const deadline = began + HAND_OVER_BUDGET_MS;
    for (const pick of picks) {
      if (clock() > deadline) break;
      if (cap === null || personKept + pick.entry.bytes > cap) continue;
      try {
        const data = await readFile(input.provider, input.ref, pick.entry, deadline, clock);
        if (!data) continue;
        const name = uniqueName(pick.name, used);
        // Kept first, claimed after: a crash in between leaves a result that is the person's own (never a claim on a file that is not there)
        // The count and the keeping are one step under the owner's lock (a job of theirs beside this one cannot both pass the same room), by the bytes actually read
        const kept = await keepResult({ ownerId: input.ownerId, sourceKind: 'computer_job', sourceId: input.jobId, makerBotId: input.botId, makerName: input.makerName, name, contentType: mimeOf(name), bytes: data, limitBytes: cap }, store);
        if (kept.status !== 'kept') {
          personKept = kept.keptBytes;
          continue;
        }
        const result = kept.row;
        const claimed = await prisma.computerJobFile
          .create({
            data: { jobId: input.jobId, botId: input.botId, ownerId: input.ownerId, makerName: input.makerName, jobTitle: input.jobTitle, name, path: pick.entry.path, modifiedAt: new Date(pick.entry.modifiedAt), bytes: data.length, mimeType: mimeOf(name), resultId: result.id },
            select: { id: true },
          })
          .catch(async (error: { code?: string }) => {
            // Not claimed (the same file at the same time was handed over by a job at the same moment, or the claim could not be written): the copy just kept goes
            await deleteOwnedResult(result.id, input.ownerId, store).catch(() => undefined);
            if (error?.code === 'P2002') return null;
            throw error;
          });
        if (!claimed) continue;
        used.add(name);
        personKept += data.length;
        handed += 1;
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
  const rows = await prisma.computerJobFile.findMany({ where: { jobId: { in: jobIds }, resultId: { not: null }, deliveredAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const row of rows) if (row.jobId) out.set(row.jobId, [...(out.get(row.jobId) ?? []), { id: row.id, name: row.name, bytes: row.bytes, mime: row.mimeType, path: row.path }]);
  return out;
}

/** The path of every file these jobs handed over, whether the chat took it or not and whether the person has deleted it since: none of them is "left on the computer". */
export async function handedPathsOf(jobIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (jobIds.length === 0) return out;
  const rows = await prisma.computerJobFile.findMany({ where: { jobId: { in: jobIds } }, select: { jobId: true, path: true } });
  for (const row of rows) if (row.jobId) out.set(row.jobId, [...(out.get(row.jobId) ?? []), row.path]);
  return out;
}

type Opened = { name: string; mime: string; data: Buffer };

async function open(row: { resultId: string | null; ownerId: string; name: string; mimeType: string } | null): Promise<Opened | null> {
  if (!row || !row.resultId) return null;
  const opened = await openResult(row.resultId, row.ownerId);
  return opened ? { name: row.name, mime: row.mimeType, data: Buffer.from(opened.bytes) } : null;
}

/** One kept file's bytes for the bot server, or null when it is not there (deleted, or never the job's). */
export async function readCard(jobId: string, fileId: string): Promise<Opened | null> {
  const row = await prisma.computerJobFile.findUnique({ where: { id: fileId } });
  if (!row || row.jobId !== jobId) return null;
  return open(row);
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
    where: { botId, ownerId: personId, resultId: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    include: RESULT_INCLUDE,
  });
  const bot = rows.length > 0 ? await prisma.bot.findUnique({ where: { id: botId }, select: { name: true, deletedAt: true } }) : null;
  const brick = bot && !bot.deletedAt ? bot.name : DELETED_BRICK_LABEL;
  return rows.map((row) => resultOf(row, brick));
}

/** How many results a person has from one of their Bricks, and how many bytes: all of them, not only the latest ones listed. */
export async function resultTotalsOf(botId: string, personId: string): Promise<{ count: number; bytes: number }> {
  const { _count, _sum } = await prisma.computerJobFile.aggregate({ where: { botId, ownerId: personId, resultId: { not: null } }, _count: { _all: true }, _sum: { bytes: true } });
  return { count: _count._all, bytes: _sum.bytes ?? 0 };
}

/** Where a page of results starts: the moment and id of the last result of the page before. Opaque to the caller. */
const resultCursor = (row: { createdAt: Date; id: string }): string => Buffer.from(`${row.createdAt.getTime()}:${row.id}`).toString('base64url');

function readResultCursor(cursor: string): { at: Date; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const match = /^(\d{1,16}):([^:\u0000]{1,100})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match) return null;
  const at = new Date(Number(match[1]));
  return Number.isNaN(at.getTime()) ? null : { at, id: match[2] };
}

/**
 * A page of a person's results whose Brick is gone (deleted, waiting out its Undo days, or removed for good), newest first. They are theirs and stay: only the
 * Brick's name on them is "A deleted Brick". Results of a Brick that is still there are listed on that Brick's own Files instead. The database picks them (a result
 * whose Brick is not one of the person's live ones), so none is missed however many results the person has; `next` starts the next page. Null for a cursor that is not ours.
 */
export async function orphanResultsPage(personId: string, options: { limit?: number; cursor?: string | null } = {}): Promise<{ results: Result[]; next: string | null } | null> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 200);
  const after = options.cursor ? readResultCursor(options.cursor) : null;
  if (options.cursor && !after) return null;
  const alive = (await prisma.bot.findMany({ where: { ownerId: personId, deletedAt: null }, select: { id: true } })).map((bot) => bot.id);
  const rows = await prisma.computerJobFile.findMany({
    where: {
      ownerId: personId,
      resultId: { not: null },
      ...(alive.length > 0 ? { botId: { notIn: alive } } : {}),
      ...(after ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: RESULT_INCLUDE,
  });
  const page = rows.slice(0, limit);
  return { results: page.map((row) => resultOf(row, DELETED_BRICK_LABEL)), next: rows.length > limit ? resultCursor(page[page.length - 1]) : null };
}

/** The first page of the same. */
export async function orphanResultsOf(personId: string, take = 100): Promise<Result[]> {
  return (await orphanResultsPage(personId, { limit: take }))?.results ?? [];
}

/** One of a person's results, to open, from one of their Bricks: only when it is theirs and that Brick's. Null when it is not there or not theirs. */
export async function readResult(botId: string, personId: string, fileId: string): Promise<Opened | null> {
  return open(await prisma.computerJobFile.findFirst({ where: { id: fileId, botId, ownerId: personId } }));
}

/** One of a person's own results, whichever Brick made it (the Brick may be gone). Null when it is not there or not theirs. */
export async function readOwnResult(personId: string, fileId: string): Promise<Opened | null> {
  return open(await prisma.computerJobFile.findFirst({ where: { id: fileId, ownerId: personId } }));
}

/** The result of a row is deleted (the copy first, then its record, so one that could not be deleted is still listed and tried again). The ledger row stays, so the file never comes back. */
async function removeResultOf(row: { resultId: string | null; ownerId: string }): Promise<boolean> {
  if (!row.resultId) return false;
  await deleteOwnedResult(row.resultId, row.ownerId);
  return true;
}

/** The person deletes one of their results from one of their Bricks. False when it is not theirs (or already gone). */
export async function deleteResult(botId: string, personId: string, fileId: string): Promise<boolean> {
  const row = await prisma.computerJobFile.findFirst({ where: { id: fileId, botId, ownerId: personId, resultId: { not: null } }, select: { resultId: true, ownerId: true } });
  return row ? removeResultOf(row) : false;
}

/** The person deletes one of their own results, whichever Brick made it. False when it is not theirs. */
export async function deleteOwnResult(personId: string, fileId: string): Promise<boolean> {
  const row = await prisma.computerJobFile.findFirst({ where: { id: fileId, ownerId: personId, resultId: { not: null } }, select: { resultId: true, ownerId: true } });
  return row ? removeResultOf(row) : false;
}
