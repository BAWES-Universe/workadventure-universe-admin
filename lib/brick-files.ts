import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { FileLimits } from '@/lib/bot-files';
import { resultTotalsOf, resultsOf, type ResultDelivery } from '@/lib/computer-file-cards';

/**
 * A Brick's files in one place (game #2003): what it made for its person, what they sent it, and, later, what is on its
 * computer. It is the owner's view of their own Brick and only theirs: every row is the person's own file of this Brick,
 * so a link to one is handed to nobody else, whoever manages or pays for the Brick. What a file is open to stays what it
 * was (a file sent in a bubble is not made private by being listed here, and one never becomes more open).
 *
 * The browser can look and download. It changes nothing but one thing: a file the person sent can be deleted.
 */

/** How a file was shared when it came in: only the Brick and the person, or in a nearby chat with other people there. */
export type FileAudience = 'you' | 'chat';

export interface BrickFile {
  id: string;
  name: string;
  kind: string;
  sizeBytes: number | null;
  /** When it came, ISO. */
  at: string;
  audience: FileAudience;
  /** Where to open it. The game builds the lasting link of an uploader file; a link is a link. */
  store: { bucket: string; fileId: string } | { url: string };
}

/**
 * What is on the Brick's computer, from Orbit's last reading of it (game #2000). Never read from the computer itself:
 * looking at files never starts a computer that is off, and a resting one is not woken to be listed. Null until a Brick
 * has one.
 */
export interface BrickComputerFiles {
  /** on | resting | off: only `on` can be browsed; the rest show the last saved copy. */
  state: 'on' | 'resting' | 'off';
  files: number;
  bytes: number;
  /** When the last copy was saved, ISO. */
  savedAt: string | null;
}

/** A file the Brick's computer made for its owner: theirs in Files whether or not the chat took it (`delivery`). */
export interface BrickComputerResult {
  id: string;
  name: string;
  sizeBytes: number;
  /** The job it came from, as the bar showed it. */
  job: string;
  /** When it was made, ISO. */
  at: string;
  delivery: ResultDelivery;
}

export interface BrickFiles {
  /**
   * The latest files it made for them. `total` counts every file it made and every artifact it made; `fileTotal` only
   * the files. `nextCursor` asks for the older files (see `listBrickFilesPage`); null when these are all of them.
   */
  made: { files: BrickFile[]; total: number; artifacts: number; fileTotal: number; nextCursor: string | null };
  /** What they sent it: the latest page, with every one counted. `nextCursor` asks for the older ones. */
  sent: { files: BrickFile[]; total: number; nextCursor: string | null };
  computer: BrickComputerFiles | null;
  /** What its computer made for them (its results), newest first. */
  results: BrickComputerResult[];
  /** Files and bytes in all (made, sent and on the computer), for the line under "Files". */
  count: number;
  bytes: number;
}

/** One page of one list: the files, how many there are in all (matching the search, if any), and where the next page starts. */
export interface BrickFilesPage {
  section: FileSection;
  files: BrickFile[];
  total: number;
  nextCursor: string | null;
}

export type FileSection = 'made' | 'sent';

/** The latest files it made that the first answer names; the older ones are the same list, one tap away. */
export const MADE_SHOWN = 2;
/** The most files one answer lists, however many are asked for: every query stays this small, the list goes on by cursor. */
export const FILES_PAGE = 50;
/** The longest search that is used; more is cut. */
export const SEARCH_MAX_LENGTH = 100;

type Row = {
  id: string;
  name: string;
  kind: string;
  sizeBytes: number | null;
  bucket: string | null;
  fileId: string | null;
  url: string | null;
  chatKind: string;
  seenBy: string[];
  expiresAt: Date | null;
  createdAt: Date;
};

const SELECT = { id: true, name: true, kind: true, sizeBytes: true, bucket: true, fileId: true, url: true, chatKind: true, seenBy: true, expiresAt: true, createdAt: true } as const;

/**
 * In a direct message nobody else is there. In a nearby chat, only the sender is named when nobody else was. An empty
 * list means nothing was recorded (a file from before it was), and the page never says "only you" for what it cannot know.
 */
export function audienceOf(row: Pick<Row, 'chatKind' | 'seenBy'>): FileAudience {
  if (row.chatKind === 'dm') return 'you';
  return row.seenBy.length === 1 ? 'you' : 'chat';
}

function viewOf(row: Row): BrickFile | null {
  const store = row.bucket && row.fileId ? { bucket: row.bucket, fileId: row.fileId } : row.url ? { url: row.url } : null;
  // A file with nowhere to open it is not a file the person can use
  if (!store) return null;
  return { id: row.id, name: row.name, kind: row.kind, sizeBytes: row.sizeBytes, at: row.createdAt.toISOString(), audience: audienceOf(row), store };
}

const SOURCE = { made: 'bot', sent: 'person' } as const;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Which rows are the person's live files of one section, as the database reads them (the same rule as `hasGone` and
 * `viewOf`, so a count and a page never disagree): theirs, of this Brick, not expired, inside the days files stay
 * findable, with somewhere to open them, and (for a search) with the words in the name.
 */
export function liveWhere(botId: string, userId: string, section: FileSection, limits: FileLimits, now: Date, search = ''): Prisma.BotFileWhereInput {
  const filled = (field: 'bucket' | 'fileId' | 'url'): Prisma.BotFileWhereInput => ({ AND: [{ [field]: { not: null } }, { [field]: { not: '' } }] });
  return {
    botId,
    ownerId: userId,
    source: SOURCE[section],
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ...(limits.findable > 0 ? [{ createdAt: { gte: new Date(now.getTime() - limits.findable * DAY) } }] : []),
      { OR: [{ AND: [filled('bucket'), filled('fileId')] }, filled('url')] },
      ...(search ? [{ name: { contains: likeLiteral(search), mode: 'insensitive' as const } }] : []),
    ],
  };
}

/** The words as a literal piece of a name: `%` and `_` are characters in a file name, never wildcards, and `\\` is itself. */
export const likeLiteral = (words: string): string => words.replace(/[\\%_]/g, (character) => `\\${character}`);

/** What someone typed to search for, trimmed and cut, without the characters the database can't search for. Empty: no search. */
export function cleanSearch(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, SEARCH_MAX_LENGTH).trim();
}

/** Where a page starts: the moment and id of the last file of the page before. Opaque to the caller. */
export function encodeCursor(row: Pick<Row, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.getTime()}:${row.id}`).toString('base64url');
}

/** The place a cursor names, or null when it is not one this list gave out. */
export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const match = /^(\d{1,16}):([^:\u0000]{1,100})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match) return null;
  const at = new Date(Number(match[1]));
  return Number.isNaN(at.getTime()) ? null : { at, id: match[2] };
}

export const pageSizeOf = (asked: number | null | undefined) => (typeof asked === 'number' && Number.isInteger(asked) && asked >= 1 ? Math.min(asked, FILES_PAGE) : FILES_PAGE);

async function readPage(
  where: Prisma.BotFileWhereInput,
  after: { at: Date; id: string } | null,
  take: number,
): Promise<{ files: BrickFile[]; nextCursor: string | null }> {
  // After the last file the person saw, by where it sits in the list and never by the file itself: a file deleted
  // meanwhile, even the one the cursor names, leaves every other file where it was
  const placed: Prisma.BotFileWhereInput = after ? { AND: [where, { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }] } : where;
  const rows = await prisma.botFile.findMany({ where: placed, select: SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1 });
  const shown = rows.slice(0, take);
  return { files: shown.flatMap((row) => viewOf(row) ?? []), nextCursor: rows.length > take ? encodeCursor(shown[shown.length - 1]) : null };
}

async function totalOf(where: Prisma.BotFileWhereInput): Promise<{ count: number; bytes: number }> {
  const { _count, _sum } = await prisma.botFile.aggregate({ where, _count: { _all: true }, _sum: { sizeBytes: true } });
  return { count: _count._all, bytes: _sum.sizeBytes ?? 0 };
}

/**
 * The person's files of one of their Bricks, the first look: the latest it made and the latest page of what they sent,
 * with every file counted. A file that has gone (a guest's, or past the days files stay findable) is not listed or
 * counted. The caller has checked the Brick is theirs. Every query is bounded: the older files come page by page from
 * `listBrickFilesPage`.
 */
export async function listBrickFiles(botId: string, userId: string, limits: FileLimits, now: Date = new Date()): Promise<BrickFiles> {
  const madeWhere = liveWhere(botId, userId, 'made', limits, now);
  const sentWhere = liveWhere(botId, userId, 'sent', limits, now);
  const [made, sent, madeTotal, sentTotal, artifacts, results, resultTotals] = await Promise.all([
    readPage(madeWhere, null, MADE_SHOWN),
    readPage(sentWhere, null, FILES_PAGE),
    totalOf(madeWhere),
    totalOf(sentWhere),
    prisma.artifact.count({ where: { makerBotId: botId, ownerId: userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    // What the Brick's computer made for the person: the latest of them, and all of them counted
    resultsOf(botId, userId),
    resultTotalsOf(botId, userId),
  ]);
  return {
    made: { ...made, total: madeTotal.count + artifacts, artifacts, fileTotal: madeTotal.count },
    sent: { ...sent, total: sentTotal.count },
    // Nothing on a computer until a Brick has one (game #2000)
    computer: null,
    results: results.map((result) => ({ id: result.id, name: result.name, sizeBytes: result.bytes, job: result.jobTitle, at: result.at.toISOString(), delivery: result.delivery })),
    count: madeTotal.count + sentTotal.count + resultTotals.count,
    bytes: madeTotal.bytes + sentTotal.bytes + resultTotals.bytes,
  };
}

/**
 * One page of one list, for the person's files of one of their Bricks: the files the Brick made or the files they sent,
 * newest first, optionally only those with the words of a search in their name. The page starts after the `cursor` an
 * earlier page gave (none: the newest), holds at most `limit` files (never more than FILES_PAGE), and says how many
 * there are in all and where the next page starts (null: that was the last). Null for a cursor that is not one of ours.
 */
export async function listBrickFilesPage(
  botId: string,
  userId: string,
  limits: FileLimits,
  query: { section: FileSection; cursor?: string | null; search?: string | null; limit?: number | null },
  now: Date = new Date(),
): Promise<BrickFilesPage | null> {
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !after) return null;
  const where = liveWhere(botId, userId, query.section, limits, now, cleanSearch(query.search));
  const [page, total] = await Promise.all([readPage(where, after, pageSizeOf(query.limit)), totalOf(where)]);
  return { section: query.section, ...page, total: total.count };
}

/**
 * Delete a file the person sent their Brick. False when it is not one of theirs to delete: someone else's, one the Brick
 * made (those are the person's to keep, and are deleted from Your artifacts), or one that is gone. The Brick can no
 * longer find, read or send it, the text kept from it goes with it, and an uploader file waits in the removal list until
 * the bot server has taken it out of the uploader (see lib/bot-file-removals.ts).
 */
export async function deleteSentFile(botId: string, userId: string, fileId: string): Promise<boolean> {
  const row = await prisma.botFile.findFirst({ where: { id: fileId, botId, ownerId: userId, source: 'person' }, select: { id: true, bucket: true, fileId: true } });
  if (!row) return false;
  await prisma.$transaction([
    ...(row.bucket && row.fileId
      ? [prisma.botFileRemoval.upsert({ where: { bucket_fileId: { bucket: row.bucket, fileId: row.fileId } }, update: {}, create: { botId, bucket: row.bucket, fileId: row.fileId } })]
      : []),
    prisma.botFile.deleteMany({ where: { id: row.id } }),
  ]);
  return true;
}

export interface FileRemoval {
  id: string;
  bucket: string;
  fileId: string;
}

/** What the bot server still has to take out of the uploader, the oldest first. */
export async function pendingFileRemovals(botId?: string, take = 100): Promise<FileRemoval[]> {
  return prisma.botFileRemoval.findMany({ where: botId ? { botId } : {}, select: { id: true, bucket: true, fileId: true }, orderBy: { createdAt: 'asc' }, take });
}

/** The bot server confirms it removed these (or that they were gone already). Unknown ids are ignored. */
export async function confirmFileRemovals(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { count } = await prisma.botFileRemoval.deleteMany({ where: { id: { in: ids } } });
  return count;
}
