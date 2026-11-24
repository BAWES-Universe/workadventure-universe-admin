/** What a copy of a Brick's computer keeps about the files outside its home folder (see `OutsideManifest`). A module of its own: the provider and the cold-storage flow both read it. */

/**
 * What `universe-cold prepack` printed about the files it copied from outside the home folder: for each file `['f', path, size, mode, sha256]`, for each link `['l', path, 0, 0, where it points]`, and the software added. `finish` puts back
 * ONLY what matches this list, which comes from Orbit and never from the home folder (the agent owns that folder and could plant files in it that a restore would otherwise install as root).
 */
export interface OutsideManifest {
  files: Array<['f' | 'l', string, number, number, string]>;
  packages: string[];
}

const OUTSIDE_ROOTS = ['/etc', '/opt', '/srv', '/usr/local', '/root', '/var/www', '/var/spool/cron'];
const OUTSIDE_PACKAGE = /^[a-z0-9][a-z0-9+.:-]{0,100}$/;

/** The manifest as a value kept on a copy's row, checked to the last field; null for anything that is not exactly one (an old copy has none). */
export function readOutsideManifest(value: unknown): OutsideManifest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { files, packages } = value as { files?: unknown; packages?: unknown };
  if (!Array.isArray(files) || !Array.isArray(packages) || files.length > 5000 || packages.length > 2000) return null;
  const seen = new Set<string>();
  const out: OutsideManifest['files'] = [];
  for (const item of files) {
    if (!Array.isArray(item) || item.length !== 5) return null;
    const [kind, path, size, mode, what] = item as unknown[];
    if (kind !== 'f' && kind !== 'l') return null;
    if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') || path.includes('\0') || path.split('/').some((part, at) => at > 0 && (part === '' || part === '.' || part === '..'))) return null;
    if (!OUTSIDE_ROOTS.some((root) => path.startsWith(`${root}/`)) || seen.has(path)) return null;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) return null;
    if (typeof what !== 'string' || what.length > 4096 || (kind === 'f' && !/^[0-9a-f]{64}$/.test(what))) return null;
    seen.add(path);
    out.push([kind, path, size, mode, what]);
  }
  if (!packages.every((name) => typeof name === 'string' && OUTSIDE_PACKAGE.test(name))) return null;
  return { files: out, packages: packages as string[] };
}
