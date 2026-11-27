/** What a copy of a Brick's computer keeps about the files outside its home folder (see `OutsideManifest`). A module of its own: the provider and the cold-storage flow both read it. */

/**
 * What `universe-cold prepack` printed about the files it copied from outside the home folder: for each file `['f', path, size, mode, sha256]`, for each link `['l', path, 0, 0, where it points]`, and the software added. `finish` puts back
 * ONLY what matches this list, which comes from Orbit and never from the home folder (the agent owns that folder and could plant files in it that a restore would otherwise install as root).
 */
export interface OutsideManifest {
  files: Array<['f' | 'l', string, number, number, string]>;
  packages: string[];
  /** The mode of each folder above a listed file that is not the usual 0755, by path (a private folder stays private when it is made again on the new computer). Absent on a copy made before they were kept. */
  dirs?: Array<[string, number]>;
}

const OUTSIDE_ROOTS = ['/etc', '/opt', '/srv', '/usr/local', '/root', '/var/www', '/var/spool/cron'];
const OUTSIDE_PACKAGE = /^[a-z0-9][a-z0-9+.:-]{0,100}$/;

/** Why a list is not one Orbit can keep: the first three are things about the computer (it cannot be packed away until they change), `invalid` is a list that is not the shape the script prints. */
export type OutsideProblem = 'outside_name_not_utf8' | 'packages_too_many' | 'outside_too_big' | 'invalid';

export type OutsideCheck = { ok: true; manifest: OutsideManifest } | { ok: false; reason: OutsideProblem };

/** A name with a lone surrogate (what a file name that is not valid UTF-8 reads as). A database refuses it in a JSON value, so it never gets that far. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The most files a list holds, and the most software names (the script's own limits, `MAX_FILES` and `MAX_PACKAGES`). */
export const OUTSIDE_MAX_FILES = 5000;
export const OUTSIDE_MAX_PACKAGES = 2000;
/** The most folder modes a list holds (the script's own limit is four for each file). */
export const OUTSIDE_MAX_DIRS = OUTSIDE_MAX_FILES * 4;

/** Checks a list to the last field and says WHY when it is not one, so a computer that cannot be packed is a clean `blocked` and never a failure further on. */
export function checkOutsideManifest(value: unknown): OutsideCheck {
  const invalid = { ok: false, reason: 'invalid' } as const;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid;
  const { files, packages, dirs } = value as { files?: unknown; packages?: unknown; dirs?: unknown };
  if (!Array.isArray(files) || !Array.isArray(packages)) return invalid;
  if (dirs !== undefined && !Array.isArray(dirs)) return invalid;
  // Said as a fact about the computer (it holds too much to carry), never as a list that is not one: a pack-away that could not be read would fail every time
  if (Array.isArray(dirs) && dirs.length > OUTSIDE_MAX_DIRS) return { ok: false, reason: 'outside_too_big' };
  if (files.length > OUTSIDE_MAX_FILES) return { ok: false, reason: 'outside_too_big' };
  if (packages.length > OUTSIDE_MAX_PACKAGES) return { ok: false, reason: 'packages_too_many' };
  const seen = new Set<string>();
  const out: OutsideManifest['files'] = [];
  let unreadableName = false;
  for (const item of files) {
    if (!Array.isArray(item) || item.length !== 5) return invalid;
    const [kind, path, size, mode, what] = item as unknown[];
    if (kind !== 'f' && kind !== 'l') return invalid;
    if (typeof path !== 'string' || typeof what !== 'string') return invalid;
    // Said first, and for every entry: it is a fact about the computer, whatever else is wrong with the list
    if (LONE_SURROGATE.test(path) || LONE_SURROGATE.test(what)) unreadableName = true;
    if (path.length > 4096 || !path.startsWith('/') || path.includes('\0') || path.split('/').some((part, at) => at > 0 && (part === '' || part === '.' || part === '..'))) return invalid;
    if (!OUTSIDE_ROOTS.some((root) => path.startsWith(`${root}/`)) || seen.has(path)) return invalid;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) return invalid;
    if (what.length > 4096 || (kind === 'f' && !/^[0-9a-f]{64}$/.test(what))) return invalid;
    seen.add(path);
    out.push([kind, path, size, mode, what]);
  }
  if (unreadableName) return { ok: false, reason: 'outside_name_not_utf8' };
  if (!packages.every((name) => typeof name === 'string' && OUTSIDE_PACKAGE.test(name))) return invalid;
  const folders: Array<[string, number]> = [];
  if (dirs !== undefined) {
    const named = new Set<string>();
    for (const item of dirs as unknown[]) {
      if (!Array.isArray(item) || item.length !== 2) return invalid;
      const [path, mode] = item as unknown[];
      if (typeof path !== 'string' || typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) return invalid;
      if (LONE_SURROGATE.test(path)) return { ok: false, reason: 'outside_name_not_utf8' };
      if (path.length > 4096 || !path.startsWith('/') || path.includes('\0') || path.split('/').some((part, at) => at > 0 && (part === '' || part === '.' || part === '..'))) return invalid;
      if (!OUTSIDE_ROOTS.some((root) => path.startsWith(`${root}/`)) || named.has(path)) return invalid;
      named.add(path);
      folders.push([path, mode]);
    }
  }
  return { ok: true, manifest: dirs === undefined ? { files: out, packages: packages as string[] } : { files: out, packages: packages as string[], dirs: folders } };
}

/** The manifest as a value kept on a copy's row, checked to the last field; null for anything that is not exactly one (an old copy has none). */
export function readOutsideManifest(value: unknown): OutsideManifest | null {
  const checked = checkOutsideManifest(value);
  return checked.ok ? checked.manifest : null;
}

// ---------- Sending and reading a list in pieces ----------

/** A list is read back from a computer this many characters at a time, and sent to one this many (a single command line is capped near 128 KiB by Linux, and one answer at 512 KB by Agent37). */
export const LIST_READ_PIECE = 200_000;
export const LIST_SEND_PIECE = 48 * 1024;
/** What `list-piece` prints after the text of a piece (on the same line), so a piece that ends in a space is read whole even if the end of the answer is trimmed on the way. */
export const LIST_PIECE_END = '|end|';
/** How many times a piece is read again, and how many times a whole send is started again from the first piece, before it is given up. */
export const LIST_TRIES = 3;
/** The largest list a computer may hand over: 5000 files at the longest path is about 21 MB. */
export const LIST_MAX_BYTES = 32 * 1024 * 1024;
/** A list that fits a command (heredoc) in one piece is sent as it is; a longer one goes in pieces. */
export const LIST_INLINE_BYTES = 48 * 1024;

/** A value as JSON that is plain ASCII (everything else as \uXXXX, pairs for characters above U+FFFF), so a piece of N characters is N bytes wherever it is cut. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
