import { randomBytes } from 'node:crypto';

/**
 * Live artifacts (game #1422, Orbit #622): the rules that need no database. What a bot may make, how a change is
 * applied, and who may open or change one. The list, the versions and the files are kept by lib/artifact-service.ts.
 */
export const ARTIFACT_KINDS = ['app', 'page', 'markdown', 'svg'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Who can open it: people in the chat it was made in, or anyone who has the link. */
export const OPEN_SCOPES = ['chat', 'link'] as const;
export type OpenScope = (typeof OPEN_SCOPES)[number];

/** Who can ask for changes: only the owner, or everyone who can open it (in its chat). */
export const CHANGE_SCOPES = ['owner', 'openers'] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];

export const CHAT_KINDS = ['nearby', 'dm'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

/**
 * How big one version can be and how many versions one artifact keeps are a super admin's limits (#666, lib/bot-limits.ts),
 * passed in by the service. This is only the largest size that can be set, which the request parser allows for.
 */
export const LARGEST_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 120;
export const MAX_SUMMARY_LENGTH = 300;
export const MAX_NAME_LENGTH = 100;
/** What a guest asked for is kept this long after its last change. Nothing is kept for a guest beyond that. */
export const GUEST_KEEP_MS = 24 * 60 * 60 * 1000;

const FILE_TYPES: Record<ArtifactKind, { extension: string; contentType: string }> = {
  app: { extension: 'html', contentType: 'text/html; charset=utf-8' },
  page: { extension: 'html', contentType: 'text/html; charset=utf-8' },
  markdown: { extension: 'md', contentType: 'text/markdown; charset=utf-8' },
  svg: { extension: 'svg', contentType: 'image/svg+xml' },
};

export function fileTypeOf(kind: ArtifactKind): { extension: string; contentType: string } {
  return FILE_TYPES[kind];
}

/**
 * Where a version's file sits in the bucket: a folder of its own, so the songs and images it carries sit beside it and
 * the page names them as "song.mp3" (#1510). The random part keeps it unguessable without Orbit's say. Versions saved
 * before #1510 keep the key they have (`v1-<random>.html`, no folder); they carry no media.
 */
export function newFileKey(artifactId: string, number: number, kind: ArtifactKind): string {
  return `artifacts/${artifactId}/v${number}-${randomBytes(12).toString('hex')}/index.${FILE_TYPES[kind].extension}`;
}

/** Where a media file of the version whose file is `fileKey` sits: in the same folder. */
export function mediaKeyFor(fileKey: string, name: string): string {
  return `${fileKey.slice(0, fileKey.lastIndexOf('/'))}/${name}`;
}

/**
 * The media a version can carry (#1510): songs, images and videos, by the type they are served with. Only types a
 * browser plays or shows and never runs, so a media file opened on its own is never a page. SVG is left out on purpose
 * (it can hold a script); a bot draws one inside the page instead.
 */
export const MEDIA_TYPES: Record<string, string[]> = {
  'audio/mpeg': ['mp3'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/aac': ['aac'],
  'audio/ogg': ['ogg', 'oga', 'opus'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/webm': ['weba', 'webm'],
  'audio/flac': ['flac'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm'],
  'video/ogg': ['ogv', 'ogg'],
  'video/quicktime': ['mov'],
};

/** Only pages and mini apps carry media: Orbit draws a document from its text, and an SVG drawing has no page around it. */
export const MEDIA_KINDS: readonly ArtifactKind[] = ['app', 'page'];

/** A media file a version carries, as the version row keeps it. */
export interface MediaFile {
  name: string;
  contentType: string;
  sizeBytes: number;
  key: string;
}

/** A media file the bot sends with a make or a change. */
export interface MediaUpload {
  name: string;
  contentType: string;
  body: Uint8Array;
}

/** A media name is one plain file name the page can use as is: letters, digits, dot, dash and underscore. */
const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_MEDIA_NAME_LENGTH = 100;

/** The type a media file is served with, without parameters; checked against its name so a page never gets a surprise. */
export function checkMediaFile(name: string, contentType: string, kind: ArtifactKind): string {
  if (!MEDIA_NAME.test(name) || name.length > MAX_MEDIA_NAME_LENGTH || name.includes('..')) {
    throw new ArtifactError('invalid_media_name', 422, `"${clipText(name, 60)}" cannot be a media name: use letters, digits, ".", "-" and "_", like song.mp3.`);
  }
  if (name.toLowerCase().startsWith('index.')) throw new ArtifactError('invalid_media_name', 422, `"${name}" is the page's own name: pick another.`);
  const type = contentType.split(';')[0].trim().toLowerCase();
  const extensions = MEDIA_TYPES[type];
  if (!extensions) throw new ArtifactError('media_type_not_allowed', 422, `"${name}" is ${type || 'of no type'}: an artifact can carry songs, images and videos only.`);
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (!extensions.includes(extension)) throw new ArtifactError('media_type_mismatch', 422, `"${name}" is ${type}: name it .${extensions[0]}.`);
  if (!MEDIA_KINDS.includes(kind)) throw new ArtifactError('media_not_allowed', 422, 'Only pages and mini apps can carry songs, images and videos.');
  return type;
}

/** "An artifact can carry up to 50 MB of media", or that it can carry none. */
export function tooMuchMedia(maxMediaBytes: number): ArtifactError {
  return maxMediaBytes === 0
    ? new ArtifactError('media_off', 413, 'Artifacts cannot carry songs, images or videos on this server.')
    : new ArtifactError('media_too_large', 413, `One save can add up to ${sizeLabel(maxMediaBytes)} of songs, images and videos.`);
}

/**
 * The media of a new version: what it keeps from the version it is made from (`kept`, already in the bucket), minus the
 * names the bot dropped, with the new uploads on top (an upload with a kept name takes its place). Every name once, and
 * the new uploads together inside the media limit: it is what one save brings in, so what the version keeps (copied
 * inside the bucket, never sent again) doesn't count. Says which name is wrong, so the bot can fix it and send it again.
 */
export function mergeMedia(
  kept: readonly MediaFile[],
  uploads: readonly MediaUpload[],
  drop: readonly string[],
  kind: ArtifactKind,
  maxMediaBytes: number,
  /** Files the version may hold in all (#696): given on a make or change, left out on a restore or copy. */
  maxMediaFiles?: number,
): { keep: MediaFile[]; add: (MediaUpload & { contentType: string })[] } {
  const names = new Set<string>();
  const add = uploads.map((upload) => {
    if (names.has(upload.name)) throw new ArtifactError('duplicate_media', 422, `"${upload.name}" was sent twice.`);
    names.add(upload.name);
    const contentType = checkMediaFile(upload.name, upload.contentType, kind);
    if (upload.body.byteLength === 0) throw new ArtifactError('empty_media', 422, `"${upload.name}" is empty.`);
    return { ...upload, contentType };
  });
  for (const name of drop) {
    if (!kept.some((file) => file.name === name)) throw new ArtifactError('media_not_found', 422, `"${clipText(name, 60)}" is not in this artifact.`);
  }
  const keep = kept.filter((file) => !names.has(file.name) && !drop.includes(file.name));
  if (add.reduce((sum, file) => sum + file.body.byteLength, 0) > maxMediaBytes) throw tooMuchMedia(maxMediaBytes);
  const files = keep.length + add.length;
  // only a save that adds files is held to it: one already over a lowered limit can still be edited or drop files
  if (maxMediaFiles !== undefined && add.length > 0 && files > maxMediaFiles) {
    throw new ArtifactError(
      'too_many_media_files',
      422,
      `This artifact can hold ${maxMediaFiles.toLocaleString('en')} files. This save would leave ${files.toLocaleString('en')}. Leave some out, or put the rest in a new artifact.`,
    );
  }
  return { keep, add };
}

/** A version row's media list, as it was saved (an old row has none). */
export function mediaOf(row: { media?: unknown }): MediaFile[] {
  return Array.isArray(row.media) ? (row.media as MediaFile[]) : [];
}

export function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/** Half an emoji on its own, which the database can't keep as text. */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A text cut to fit, never through the middle of an emoji. */
export function clipText(value: string, max: number): string {
  return value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}

/** A title or a name as one short line (no control characters, no lone halves of an emoji), or null when nothing is left. */
export function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const line = clipText(value.replace(LONE_SURROGATE, '').replace(/[\s\u0000-\u001F\u007F]+/g, ' ').trim(), max).trim();
  return line.length > 0 ? line : null;
}

export class ArtifactError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** What a bot sends to change a file in place: one piece of the file and what it becomes, like an editor's replace. */
export interface ArtifactEdit {
  old: string;
  new: string;
  /** Replace every place the piece appears; without it the piece must appear exactly once. */
  all?: boolean;
}

/** "512 KB", "2 MB": the size limit as a person reads it. */
export function sizeLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Number(mb.toFixed(1)).toLocaleString('en')} MB` : `${Math.round(bytes / 1024).toLocaleString('en')} KB`;
}

export function tooLarge(maxBytes: number): ArtifactError {
  return new ArtifactError('too_large', 413, `An artifact can hold up to ${sizeLabel(maxBytes)}.`);
}

/** The file would be this many bytes after an edit: over the limit is refused before anything is built. */
function tooLargeAfter(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) throw tooLarge(maxBytes);
}

/**
 * The file after the edits, applied in order, each on the result of the one before. An edit that finds nothing, or
 * finds a piece that is not unique and was not asked for everywhere, stops the whole change: nothing is half applied.
 * The message says which edit and why, so the bot can fix that edit and send it again.
 */
export function applyEdits(content: string, edits: readonly ArtifactEdit[], maxBytes: number): string {
  let result = content;
  edits.forEach((edit, index) => {
    if (edit.old === '') throw new ArtifactError('edit_empty', 422, `Edit ${index + 1} has nothing to find.`);
    // Half of an emoji (a surrogate pair cut at either end) would match inside characters and grow them past the size
    // the check below counts, so the text to find must start and end on whole characters
    if (/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(edit.old)) {
      throw new ArtifactError('edit_split_character', 422, `Edit ${index + 1}: the text to replace starts or ends in the middle of a character. Include the whole character.`);
    }
    const first = result.indexOf(edit.old);
    if (first === -1) throw new ArtifactError('edit_not_found', 422, `Edit ${index + 1}: the text to replace is not in the file.`);
    const second = result.indexOf(edit.old, first + edit.old.length);
    if (edit.all) {
      // A short piece replaced by a long one in many places can grow far past the limit: count the places and refuse
      // before building anything (splitting a big file on one character would build a part for each)
      let places = 0;
      for (let at = first; at !== -1; at = result.indexOf(edit.old, at + edit.old.length)) places++;
      // Bytes, not characters: replacing "a" with "界" is three times the size
      tooLargeAfter(byteLength(result) + places * (byteLength(edit.new) - byteLength(edit.old)), maxBytes);
      result = result.split(edit.old).join(edit.new);
      return;
    }
    if (second !== -1) {
      throw new ArtifactError('edit_ambiguous', 422, `Edit ${index + 1}: the text to replace appears more than once. Add more around it, or replace all of them.`);
    }
    tooLargeAfter(byteLength(result) + byteLength(edit.new) - byteLength(edit.old), maxBytes);
    result = result.slice(0, first) + edit.new + result.slice(first + edit.old.length);
  });
  return result;
}

/** The size check every new version goes through, before anything is stored. */
export function checkContent(content: string, maxBytes: number): void {
  if (content.trim() === '') throw new ArtifactError('empty_content', 422, 'An artifact cannot be empty.');
  if (byteLength(content) > maxBytes) throw tooLarge(maxBytes);
}

/** A new version is refused once an artifact keeps as many as it may (0: it keeps them all). */
export function checkVersionRoom(latestVersion: number, maxVersions: number): void {
  if (maxVersions > 0 && latestVersion >= maxVersions) {
    throw new ArtifactError('too_many_versions', 409, `An artifact keeps up to ${maxVersions.toLocaleString('en')} versions.`);
  }
}

/** The artifact fields the rules below read. */
export interface ArtifactRules {
  ownerId: string | null;
  chatRef: string | null;
  openScope: string;
  changeScope: string;
  expiresAt: Date | null;
}

/** Who is asking: their account when they have one (a guest has none), and whether they are in the artifact's chat. */
export interface Asker {
  userId: string | null;
  inChat: boolean;
}

export function isOwner(artifact: ArtifactRules, asker: Asker): boolean {
  return artifact.ownerId !== null && artifact.ownerId === asker.userId;
}

/** A guest's artifact that has run out: gone for everyone, as if it never was. */
export function hasExpired(artifact: ArtifactRules, now: Date): boolean {
  return artifact.expiresAt !== null && artifact.expiresAt.getTime() <= now.getTime();
}

/**
 * May this person open it (and see its versions and code)? The owner always. A link opens for anyone who has it.
 * "People in this chat" opens only for someone who is in that chat now, which the game vouches for.
 */
export function canOpen(artifact: ArtifactRules, asker: Asker, now: Date): boolean {
  if (hasExpired(artifact, now)) return false;
  if (isOwner(artifact, asker)) return true;
  if (artifact.openScope === 'link') return true;
  return asker.inChat && artifact.chatRef !== null;
}

/**
 * May this person ask a bot to change it? The owner, in any chat they have with a bot. Anyone else only in the chat it
 * was made in, and only when the owner allowed everyone who can open it. What a guest asked for has no owner, so
 * anyone in its chat may change it while it is kept.
 */
export function canAskForChange(artifact: ArtifactRules, asker: Asker, inThisChat: boolean, now: Date): boolean {
  if (hasExpired(artifact, now)) return false;
  if (isOwner(artifact, asker)) return true;
  if (!inThisChat || artifact.chatRef === null) return false;
  return artifact.ownerId === null || artifact.changeScope === 'openers';
}

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
