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

/** The most one version can hold. A page or mini app is one file; this is far above a few thousand lines. */
export const MAX_ARTIFACT_BYTES = 512 * 1024;
/** Versions one artifact keeps. After that a change is refused, so one chat cannot fill the bucket. */
export const MAX_VERSIONS = 200;
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

/** Where a version's file sits in the bucket. The random part keeps it unguessable without Orbit's say. */
export function newFileKey(artifactId: string, number: number, kind: ArtifactKind): string {
  return `artifacts/${artifactId}/v${number}-${randomBytes(12).toString('hex')}.${FILE_TYPES[kind].extension}`;
}

export function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/** Half an emoji on its own, which the database can't keep as text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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

/** A file of this many characters is over the limit in bytes too (a character is at least one byte). */
function tooLargeAfter(characters: number): void {
  if (characters > MAX_ARTIFACT_BYTES) throw new ArtifactError('too_large', 413, `An artifact can hold up to ${MAX_ARTIFACT_BYTES / 1024} KB.`);
}

/**
 * The file after the edits, applied in order, each on the result of the one before. An edit that finds nothing, or
 * finds a piece that is not unique and was not asked for everywhere, stops the whole change: nothing is half applied.
 * The message says which edit and why, so the bot can fix that edit and send it again.
 */
export function applyEdits(content: string, edits: readonly ArtifactEdit[]): string {
  let result = content;
  edits.forEach((edit, index) => {
    if (edit.old === '') throw new ArtifactError('edit_empty', 422, `Edit ${index + 1} has nothing to find.`);
    const first = result.indexOf(edit.old);
    if (first === -1) throw new ArtifactError('edit_not_found', 422, `Edit ${index + 1}: the text to replace is not in the file.`);
    const second = result.indexOf(edit.old, first + edit.old.length);
    if (edit.all) {
      const parts = result.split(edit.old);
      // A short piece replaced by a long one in many places can grow far past the limit: refuse before building it
      tooLargeAfter(result.length + (parts.length - 1) * (edit.new.length - edit.old.length));
      result = parts.join(edit.new);
      return;
    }
    if (second !== -1) {
      throw new ArtifactError('edit_ambiguous', 422, `Edit ${index + 1}: the text to replace appears more than once. Add more around it, or replace all of them.`);
    }
    tooLargeAfter(result.length + edit.new.length - edit.old.length);
    result = result.slice(0, first) + edit.new + result.slice(first + edit.old.length);
  });
  return result;
}

/** The size check every new version goes through, before anything is stored. */
export function checkContent(content: string): void {
  if (content.trim() === '') throw new ArtifactError('empty_content', 422, 'An artifact cannot be empty.');
  if (byteLength(content) > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError('too_large', 413, `An artifact can hold up to ${MAX_ARTIFACT_BYTES / 1024} KB.`);
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
