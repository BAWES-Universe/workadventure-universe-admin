import { prisma } from '@/lib/db';
import { hasGone, type FileLimits } from '@/lib/bot-files';

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

export interface BrickFiles {
  /** The files it made for them, the latest few; `total` counts every file it made and every artifact it made. */
  made: { files: BrickFile[]; total: number; artifacts: number };
  /** What they sent it, all of it. */
  sent: { files: BrickFile[]; total: number };
  computer: BrickComputerFiles | null;
  /** Files and bytes in all (made, sent and on the computer), for the line under "Files". */
  count: number;
  bytes: number;
}

/** The latest files it made that the page names; the rest are one tap away in Your artifacts. */
export const MADE_SHOWN = 2;
/** The most sent files one answer lists: more than anyone sends one Brick; the total says how many there are. */
export const SENT_LISTED = 100;

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

/** In a direct message nobody else is there; in a nearby chat, only if nobody but the sender was named. */
export function audienceOf(row: Pick<Row, 'chatKind' | 'seenBy'>): FileAudience {
  return row.chatKind === 'dm' || row.seenBy.length <= 1 ? 'you' : 'chat';
}

function viewOf(row: Row): BrickFile | null {
  const store = row.bucket && row.fileId ? { bucket: row.bucket, fileId: row.fileId } : row.url ? { url: row.url } : null;
  // A file with nowhere to open it is not a file the person can use
  if (!store) return null;
  return { id: row.id, name: row.name, kind: row.kind, sizeBytes: row.sizeBytes, at: row.createdAt.toISOString(), audience: audienceOf(row), store };
}

const sumBytes = (files: BrickFile[]) => files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0);

/**
 * The person's files of one of their Bricks. A file that has gone (a guest's, or past the days files stay findable) is
 * not listed. The caller has checked the Brick is theirs.
 */
export async function listBrickFiles(botId: string, userId: string, limits: FileLimits, now: Date = new Date()): Promise<BrickFiles> {
  const [rows, artifacts] = await Promise.all([
    prisma.botFile.findMany({ where: { botId, ownerId: userId }, select: { ...SELECT, source: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    prisma.artifact.count({ where: { makerBotId: botId, ownerId: userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
  ]);
  const live = rows.filter((row) => !hasGone(row, limits, now));
  const made = live.filter((row) => row.source === 'bot').flatMap((row) => viewOf(row) ?? []);
  const sent = live.filter((row) => row.source === 'person').flatMap((row) => viewOf(row) ?? []);
  return {
    made: { files: made.slice(0, MADE_SHOWN), total: made.length + artifacts, artifacts },
    sent: { files: sent.slice(0, SENT_LISTED), total: sent.length },
    // Nothing on a computer until a Brick has one (game #2000)
    computer: null,
    count: made.length + sent.length,
    bytes: sumBytes(made) + sumBytes(sent),
  };
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
