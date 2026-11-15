/**
 * The list of files on a Brick's computer at the end of a job (for the Files list). The image's `universe-files` prints one line for
 * each file (size, modified, path, tab apart, newest first, at most 201 lines); this turns that into what is stored and shown. Pure:
 * nothing here reads a machine.
 */

export const FILES_LIST_MAX = 200;
const PATH_MAX = 300;

export interface FileEntry {
  path: string;
  bytes: number;
  /** ISO time. */
  modifiedAt: string;
}

export interface FilesList {
  items: FileEntry[];
  /** There were more files than are listed. */
  more: boolean;
  listedAt: string;
}

/** A line that is not size, TAB, seconds, TAB, a clean relative path is dropped: nothing from the machine is trusted as it comes. */
export function parseFilesList(stdout: string, now: Date): FilesList {
  const items: FileEntry[] = [];
  let seen = 0;
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length !== 3) continue;
    const bytes = Number(parts[0]);
    const seconds = Number(parts[1]);
    const path = parts[2];
    if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(seconds) || seconds <= 0) continue;
    // eslint-disable-next-line no-control-regex
    if (!path || path.length > PATH_MAX || path.startsWith('/') || path.split('/').includes('..') || /[\u0000-\u001f\u007f]/.test(path)) continue;
    seen++;
    if (items.length < FILES_LIST_MAX) items.push({ path, bytes: Math.trunc(bytes), modifiedAt: new Date(Math.trunc(seconds) * 1000).toISOString() });
  }
  return { items, more: seen > FILES_LIST_MAX, listedAt: now.toISOString() };
}

/** What was stored, read back safely (a column that holds anything else is "no list"). */
export function readFilesList(value: unknown): FilesList | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<FilesList>;
  if (!Array.isArray(candidate.items) || typeof candidate.listedAt !== 'string') return null;
  const items = candidate.items.filter((entry): entry is FileEntry => !!entry && typeof entry.path === 'string' && typeof entry.bytes === 'number' && typeof entry.modifiedAt === 'string').slice(0, FILES_LIST_MAX);
  return { items, more: candidate.more === true, listedAt: candidate.listedAt };
}
