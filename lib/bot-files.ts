import { prisma } from '@/lib/db';
import { checkBotAccess } from '@/lib/bot-access';
import { loadBotPrivacy, takeForgets } from '@/lib/bot-privacy';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { GUEST_KEEP_MS, cleanLine, clipText, type ChatKind } from '@/lib/artifacts';

/**
 * Files in bot chats (game #1508): what a person sent a bot and what a bot sent them, kept so the bot can find, read and
 * send them again later instead of forgetting them once the message has passed. The bot server adds a file after a
 * reply, keeps its text in the background, and asks for one by its short id (f12). Artifacts are not copied here: the
 * bot finds them in their own tables.
 *
 * Who may use a file: the person it belongs to, from any chat with this bot; anyone else only while they are in the
 * chat it came in. A guest's file has no owner, so it is only for that chat, and it goes after a day like a guest's
 * artifact. Bot B never sees a file sent to bot A. Orbit logs no file names or text, and every answer carries the bot's
 * hidden flag so the bot server keeps them out of PostHog and Sentry when the bot's chats are hidden.
 */

export const FILE_KINDS = ['image', 'audio', 'video', 'document', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Who added it: the person sent it, or the bot sent it to them. */
export const FILE_SOURCES = ['person', 'bot'] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

/**
 * How long a file's text may be, and for how many days a file can be found again (0 = until the person asks the bot to
 * forget them). The super admin's settings for these come with the limits page (#1508 O3); until then these are used.
 */
export interface FileLimits {
  text: number;
  findable: number;
}

export const FILE_LIMITS_RECOMMENDED: FileLimits = { text: 2_000_000, findable: 0 };

/** The text is kept in parts this long, so search points at a part and a long file is never read whole. */
export const TEXT_PART_CHARS = 10_000;

/**
 * The bot server sends a long text in pieces of at most this many characters, so one request stays a few MB whatever
 * "Text kept from a file" is set to. It is the size of one request, not of what is kept: any number of pieces add up
 * to the setting.
 */
export const TEXT_PIECE_CHARS = 1_000_000;

export const MAX_FILE_NAME_LENGTH = 255;
export const MAX_FILE_LINE_LENGTH = 300;
export const MAX_TOOL_NAME_LENGTH = 100;
/**
 * Search matches the words of this much of a made file's prompt, with its name and line: Postgres can't hold the words
 * of a much longer text in one index entry (1 MB), and the insert would fail. The whole prompt is still kept and read
 * back; only words past this are not searched. The same number is in the migration's index and the search SQL.
 */
export const PROMPT_SEARCH_CHARS = 20_000;

/** What the uploader names a stored file: a UUID, with its extension kept (uploader MimeType.ts, up to 16 characters). */
const UPLOADER_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,16})?$/i;
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/i;
/** Query parameters of a signed link. Such a link expires, so it is never kept. */
const SIGNED_LINK_PARAMS = ['x-amz-signature', 'x-amz-credential', 'x-goog-signature', 'signature', 'sig', 'expires', 'se'];
const SHORT_ID = /^f([1-9]\d{0,8})$/i;

export class BotFileError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const notFound = () => new BotFileError('not_found', 404, 'No such file.');

/** A person as the bot server names them. A guest has no account: nothing is kept for them beyond a day. */
export interface Person {
  signedIn: boolean;
  identifier?: string | null;
  name?: string | null;
}

export interface Chat {
  kind: ChatKind;
  ref: string;
}

/** Where a file can be opened again: a chat bucket and the uploader's id, or a link that lasts. */
export type FileStore = { bucket: string; fileId: string } | { url: string };

export interface BotCall {
  botId: string;
  person: Person;
  chat: Chat;
}

export interface Context {
  now: Date;
  limits?: FileLimits;
}

export const defaultContext = (): Context => ({ now: new Date() });
export const limitsOf = (ctx: Context): FileLimits => ctx.limits ?? FILE_LIMITS_RECOMMENDED;

export interface Who {
  /** Their Orbit account; null for a guest. */
  userId: string | null;
  /** The id the bot server named them by. */
  personRef: string | null;
}

export async function resolvePerson(person: Person): Promise<Who> {
  const identifier = person.identifier?.trim() || null;
  const user = person.signedIn && identifier ? await findUserByIdentifier(identifier) : null;
  return { userId: user && !user.isGuest ? user.id : null, personRef: identifier };
}

/** The same gate as artifacts: the bot exists, the person may use it this way, and the bot's chat telemetry switch. */
export async function passBotGate(call: BotCall): Promise<{ hidden: boolean }> {
  const access = await checkBotAccess({
    botId: call.botId,
    action: call.chat.kind === 'dm' ? 'dm' : 'chat',
    person: { signedIn: call.person.signedIn, identifier: call.person.identifier },
  });
  if (!access) throw new BotFileError('bot_not_found', 404, 'No such bot.');
  if (!access.allowed) throw new BotFileError('not_allowed', 403, access.reason ?? 'This person cannot use this bot.');
  const privacy = await loadBotPrivacy(call.botId);
  return { hidden: privacy?.hidden === true };
}

/**
 * Files are added after the reply, so a Forget pressed while a reply runs would see its file written back a moment
 * later. While a Forget names this person (or everyone) and the bot server has not yet reported it dropped them, as for
 * the memory save (#495), nothing is kept for them: the bot server hears 409 `forgotten` and lets it go quietly.
 */
async function isForgotten(botId: string, who: Who): Promise<boolean> {
  const forgetting = await takeForgets(botId);
  return forgetting.everyone || (who.personRef !== null && forgetting.userUuids.has(who.personRef));
}

const forgotten = () => new BotFileError('forgotten', 409, 'The bot was asked to forget this person.');

export function shortIdOf(number: number): string {
  return `f${number}`;
}

/** The number in a short id ("f12" or "F12"), or null for anything else. */
export function numberOfShortId(ref: string): number | null {
  const match = SHORT_ID.exec(ref.trim());
  return match ? Number(match[1]) : null;
}

/** The store as given, checked: an uploader id in a bucket, or a link that is not signed. */
export function checkStore(store: FileStore): FileStore {
  if ('url' in store) {
    let link: URL;
    try {
      link = new URL(store.url);
    } catch {
      throw new BotFileError('invalid_link', 422, 'Not a link.');
    }
    if (link.protocol !== 'https:' && link.protocol !== 'http:') throw new BotFileError('invalid_link', 422, 'Not a web link.');
    if (link.username || link.password) throw new BotFileError('invalid_link', 422, 'A link may not carry a sign-in.');
    const params = [...link.searchParams.keys()].map((key) => key.toLowerCase());
    if (params.some((key) => SIGNED_LINK_PARAMS.includes(key))) {
      throw new BotFileError('signed_link', 422, 'A signed link expires. Send the bucket and the file id instead.');
    }
    return { url: link.toString() };
  }
  if (!BUCKET_NAME.test(store.bucket) || !UPLOADER_FILE_ID.test(store.fileId)) {
    throw new BotFileError('invalid_store', 422, 'Not an uploader file.');
  }
  return { bucket: store.bucket, fileId: store.fileId };
}

export interface FileRow {
  id: string;
  botId: string;
  number: number;
  ownerId: string | null;
  personRef: string | null;
  source: string;
  kind: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  bucket: string | null;
  fileId: string | null;
  url: string | null;
  line: string | null;
  madeWith: string | null;
  madePrompt: string | null;
  lengthSeconds: number | null;
  pages: number | null;
  chatKind: string;
  chatRef: string;
  textState: string;
  textChars: number;
  expiresAt: Date | null;
  createdAt: Date;
}

/** What the bot is told about a file. */
export interface BotFileView {
  ref: string;
  name: string;
  kind: string;
  source: string;
  mimeType: string | null;
  sizeBytes: number | null;
  line: string | null;
  /** For a file the bot made: the tool and what it asked that tool for, so it can make one like it again. */
  made: { with: string; prompt: string | null } | null;
  /** How long a song, voice note or video is, and how many pages a document has, when known. */
  lengthSeconds: number | null;
  pages: number | null;
  /** Where to open it again. */
  store: FileStore;
  /** It belongs to the person asking. */
  mine: boolean;
  /** It came in the chat they are asking in. */
  inThisChat: boolean;
  text: { state: string; chars: number };
  createdAt: string;
}

function inThisChat(row: Pick<FileRow, 'chatKind' | 'chatRef'>, chat: Chat): boolean {
  return row.chatKind === chat.kind && row.chatRef === chat.ref;
}

export function viewOf(row: FileRow, who: Who, chat: Chat): BotFileView {
  return {
    ref: shortIdOf(row.number),
    name: row.name,
    kind: row.kind,
    source: row.source,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    line: row.line,
    made: row.madeWith ? { with: row.madeWith, prompt: row.madePrompt } : null,
    lengthSeconds: row.lengthSeconds,
    pages: row.pages,
    store: row.bucket && row.fileId ? { bucket: row.bucket, fileId: row.fileId } : { url: row.url ?? '' },
    mine: who.userId !== null && row.ownerId === who.userId,
    inThisChat: inThisChat(row, chat),
    text: { state: row.textState, chars: row.textChars },
    createdAt: row.createdAt.toISOString(),
  };
}

/** Gone for everyone: a guest's after a day, anyone's past the days the super admin keeps files findable. */
export function hasGone(row: Pick<FileRow, 'expiresAt' | 'createdAt'>, limits: FileLimits, now: Date): boolean {
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return true;
  return limits.findable > 0 && now.getTime() - row.createdAt.getTime() > limits.findable * 24 * 60 * 60 * 1000;
}

/** The person it belongs to, from any chat with this bot; anyone else only in the chat it came in. */
export function canUse(row: Pick<FileRow, 'ownerId' | 'chatKind' | 'chatRef'>, who: Who, chat: Chat): boolean {
  if (who.userId !== null && row.ownerId === who.userId) return true;
  return inThisChat(row, chat);
}

export async function loadUsable(call: BotCall & { ref: string }, who: Who, ctx: Context): Promise<FileRow> {
  const number = numberOfShortId(call.ref);
  if (number === null) throw notFound();
  const row = await prisma.botFile.findUnique({ where: { botId_number: { botId: call.botId, number } } });
  // One that has gone, or that this person may not use, looks the same as one that never was
  if (!row || hasGone(row, limitsOf(ctx), ctx.now) || !canUse(row, who, call.chat)) throw notFound();
  return row;
}

export interface AddInput extends BotCall {
  source: FileSource;
  kind: FileKind;
  name: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  store: FileStore;
  line?: string | null;
  /** For a file the bot made: the tool it used and what it asked for. Kept only when the bot sent it. */
  madeWith?: string | null;
  madePrompt?: string | null;
  lengthSeconds?: number | null;
  pages?: number | null;
}

/**
 * A prompt as written (its lines kept), without the characters the database can't keep, or null when empty. It is kept
 * up to the super admin's "Text kept from a file", like a document's text.
 */
function cleanPrompt(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const prompt = clipText(value.replace(/\u0000/g, '').trim(), max).trim();
  return prompt.length > 0 ? prompt : null;
}

/**
 * Adds a file to the bot's list for the person. The short id comes from one counter per bot, counted up in a single
 * statement, so a direct message and a bubble adding files in the same second never get the same one.
 */
export async function addFile(input: AddInput, ctx: Context = defaultContext()): Promise<{ file: BotFileView; hidden: boolean }> {
  const name = cleanLine(input.name, MAX_FILE_NAME_LENGTH);
  if (!name) throw new BotFileError('name_required', 422, 'A file needs a name.');
  const store = checkStore(input.store);
  const madeWith = input.source === 'bot' ? cleanLine(input.madeWith, MAX_TOOL_NAME_LENGTH) : null;
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person);
  if (await isForgotten(input.botId, who)) throw forgotten();

  const counter = await prisma.botFileCounter.upsert({
    where: { botId: input.botId },
    create: { botId: input.botId, last: 1 },
    update: { last: { increment: 1 } },
  });
  const row = await prisma.botFile.create({
    data: {
      botId: input.botId,
      number: counter.last,
      ownerId: who.userId,
      personRef: who.personRef,
      source: input.source,
      kind: input.kind,
      name,
      mimeType: cleanLine(input.mimeType, 255),
      sizeBytes: input.sizeBytes ?? null,
      bucket: 'bucket' in store ? store.bucket : null,
      fileId: 'fileId' in store ? store.fileId : null,
      url: 'url' in store ? store.url : null,
      line: cleanLine(input.line, MAX_FILE_LINE_LENGTH),
      ...(madeWith ? { madeWith, madePrompt: cleanPrompt(input.madePrompt, limitsOf(ctx).text) } : {}),
      lengthSeconds: input.lengthSeconds ?? null,
      pages: input.pages ?? null,
      chatKind: input.chat.kind,
      chatRef: input.chat.ref,
      expiresAt: who.userId ? null : new Date(ctx.now.getTime() + GUEST_KEEP_MS),
      createdAt: ctx.now,
    },
  });
  // A Forget pressed between the check and the write: take the file out again
  if (await isForgotten(input.botId, who)) {
    await prisma.botFile.deleteMany({ where: { id: row.id } });
    throw forgotten();
  }
  pruneSometimes(ctx);
  return { file: viewOf(row, who, input.chat), hidden };
}

export async function getFile(input: BotCall & { ref: string }, ctx: Context = defaultContext()): Promise<{ file: BotFileView; hidden: boolean }> {
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person);
  const row = await loadUsable(input, who, ctx);
  pruneSometimes(ctx);
  return { file: viewOf(row, who, input.chat), hidden };
}

/** The text split into parts, never through the middle of an emoji. */
export function splitText(text: string, size = TEXT_PART_CHARS): { number: number; start: number; text: string }[] {
  const parts: { number: number; start: number; text: string }[] = [];
  let start = 0;
  while (start < text.length) {
    const piece = clipText(text.slice(start), size);
    // clipText drops a lone first half at the end; a part of one character that is half an emoji still moves on
    const length = piece.length > 0 ? piece.length : 1;
    parts.push({ number: parts.length + 1, start, text: text.slice(start, start + length) });
    start += length;
  }
  return parts;
}

export interface KeepTextInput extends BotCall {
  ref: string;
  /**
   * One piece of the file's text (up to TEXT_PIECE_CHARS), read by the bot server after the reply; or `failed` when it
   * could not be read.
   */
  text?: string | null;
  /** Where the piece starts in the whole text: 0 starts again in place of anything kept, more goes on from there. */
  from?: number | null;
  /** This piece ends the text. Without it the file reads as still being kept. */
  last?: boolean | null;
  failed?: boolean;
}

const HIGH_HALF = /[\uD800-\uDBFF]$/;

/**
 * Keeps a file's text, up to the super admin's limit, piece by piece. A piece from 0 replaces any text kept before; each
 * next one starts where the last ended. The bot server reads the whole file in the background after the reply; a
 * failure there marks the file and never touches the reply.
 */
export async function keepFileText(input: KeepTextInput, ctx: Context = defaultContext()): Promise<{ file: BotFileView; hidden: boolean }> {
  const hasText = typeof input.text === 'string';
  if (hasText === (input.failed === true)) throw new BotFileError('text_or_failed', 422, 'Send the text, or that it failed, not both and not neither.');
  const from = input.from ?? 0;
  const last = input.last ?? true;
  // The null character can't be kept as text in Postgres
  const piece = hasText ? (input.text as string).replace(/\u0000/g, '') : '';
  if (piece.length > TEXT_PIECE_CHARS) throw new BotFileError('piece_too_large', 413, `Send the text in pieces of up to ${TEXT_PIECE_CHARS.toLocaleString('en')} characters.`);
  // Each piece is kept as text of its own, and half an emoji can't be
  if (!last && HIGH_HALF.test(piece)) throw new BotFileError('split_emoji', 422, 'A piece may not end in the middle of an emoji.');
  const limit = limitsOf(ctx).text;
  if (from + piece.length > limit) {
    throw new BotFileError('too_much_text', 413, `Text kept from a file is set to ${limit.toLocaleString('en')} characters.`);
  }
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person);
  const row = await loadUsable(input, who, ctx);
  if (await isForgotten(input.botId, who)) throw forgotten();
  if (hasText && from > 0 && (row.textState !== 'reading' || from !== row.textChars)) {
    throw new BotFileError('out_of_order', 409, `Send the pieces in order: the next one starts at ${row.textState === 'reading' ? row.textChars : 0}.`);
  }
  const starting = !hasText || from === 0;
  const before = starting ? 0 : await prisma.botFilePart.count({ where: { botFileId: row.id } });
  const parts = splitText(piece).map((part) => ({ ...part, number: before + part.number, start: from + part.start }));
  const chars = hasText ? from + piece.length : 0;
  const textState = !hasText ? 'failed' : !last ? 'reading' : chars > 0 ? 'kept' : 'none';
  let updated: FileRow;
  try {
    const steps = [
      ...(starting ? [prisma.botFilePart.deleteMany({ where: { botFileId: row.id } })] : []),
      prisma.botFilePart.createMany({ data: parts.map((part) => ({ botFileId: row.id, ...part })) }),
      prisma.botFile.update({ where: { id: row.id }, data: { textState, textChars: chars } }),
    ];
    updated = (await prisma.$transaction(steps)).at(-1) as FileRow;
  } catch (error) {
    // Forgotten or gone in the meantime: the same answer as a file that is not there
    if (!(await prisma.botFile.findUnique({ where: { botId_number: { botId: row.botId, number: row.number } } }))) throw notFound();
    throw error;
  }
  return { file: viewOf(updated, who, input.chat), hidden };
}

/**
 * Forget (#435) for files: one person (by the id the bot server named them by, and their account), or everyone. The
 * person's artifacts stay: they have their own delete.
 */
export function forgetFilesWhere(botId: string, person: { userUuid: string | null; userId: string | null } | 'everyone') {
  if (person === 'everyone') return { botId };
  const of = [
    ...(person.userUuid ? [{ personRef: person.userUuid }] : []),
    ...(person.userId ? [{ ownerId: person.userId }] : []),
  ];
  // Nobody named: match nothing rather than the whole bot
  return of.length > 0 ? { botId, OR: of } : { botId, id: { in: [] as string[] } };
}

const PRUNE_BATCH = 100;
const PRUNE_EVERY_MS = 60_000;
let lastPruneAt = 0;

/** For tests: let the next call tidy up at once. */
export function resetFilePruneClock(): void {
  lastPruneAt = 0;
}

/** Removes guests' files past their day and, when the super admin keeps files for a number of days, older ones. */
export async function pruneGoneFiles(ctx: Context = defaultContext()): Promise<number> {
  const { findable } = limitsOf(ctx);
  const gone: object[] = [{ expiresAt: { lte: ctx.now } }];
  if (findable > 0) gone.push({ createdAt: { lte: new Date(ctx.now.getTime() - findable * 24 * 60 * 60 * 1000) } });
  const rows = await prisma.botFile.findMany({ where: { OR: gone }, select: { id: true }, take: PRUNE_BATCH });
  if (rows.length === 0) return 0;
  const { count } = await prisma.botFile.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return count;
}

/** The tidy-up from the add and read paths, once a minute at most, never in the way of the answer. */
function pruneSometimes(ctx: Context): void {
  const at = ctx.now.getTime();
  if (at - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = at;
  void pruneGoneFiles(ctx).catch((error) => console.error('Could not clear gone bot files:', error instanceof Error ? error.message : 'unknown'));
}
