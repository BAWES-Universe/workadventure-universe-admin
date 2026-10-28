import { prisma } from '@/lib/db';
import { clipText } from '@/lib/artifacts';
import {
  FILE_KINDS,
  TEXT_PART_CHARS,
  defaultContext,
  limitsOf,
  loadUsable,
  passBotGate,
  resolvePerson,
  shortIdOf,
  viewOf,
  type BotCall,
  type BotFileView,
  type Context,
  type FileKind,
  type FileSource,
  type Who,
} from '@/lib/bot-files';
import { fileHitsSql, fileSearchSql, hitOf, searchWords, wordQuery, type FileHitRow, type FileSearchRow } from '@/lib/bot-file-search-sql';

/**
 * Finding and reading files in bot chats (game #1508). One search looks through the person's files with this bot and
 * this chat's files, and through artifacts by the rule bots already use for them (Orbit #655): this chat's, and the
 * person's own from any chat with any bot. Artifacts stay in their own tables; they are only read here. Newest first, a
 * page at a time, with the total, so a person with thousands of files never fills the bot's prompt.
 */

/** Runs one SQL statement; Prisma by default, PGlite in the tests. */
export type SqlRunner = <T>(sql: string, values: unknown[]) => Promise<T[]>;

const runWithPrisma: SqlRunner = <T,>(sql: string, values: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...values);

export interface SearchContext extends Context {
  sql?: SqlRunner;
}

export const FIND_KINDS = [...FILE_KINDS, 'artifact'] as const;
export type FindKind = (typeof FIND_KINDS)[number];

export interface FindInput extends BotCall {
  words?: string | null;
  kinds?: FindKind[] | null;
  /** person: they sent it. bot: the bot sent or made it (artifacts too). */
  source?: FileSource | null;
  since?: string | null;
  until?: string | null;
  /** From 1. */
  page?: number | null;
  /** How many a page holds: the "Files found in one search" setting, sent by the bot server. */
  limit: number;
}

export interface FoundFile {
  type: 'file';
  ref: string;
  name: string;
  kind: string;
  source: string;
  mimeType: string | null;
  sizeBytes: number | null;
  line: string | null;
  /** The prompt as one short line, with its whole length; the whole prompt comes when the file is opened. */
  made: { with: string; prompt: string | null; promptChars: number } | null;
  lengthSeconds: number | null;
  pages: number | null;
  mine: boolean;
  inThisChat: boolean;
  text: { state: string; chars: number };
  createdAt: string;
  /** Where the words are in its text: a place to open from, and the text around it. */
  hit?: { at: number; snippet: string };
}

export interface FoundArtifact {
  type: 'artifact';
  id: string;
  title: string;
  kind: string;
  makerName: string;
  version: number;
  mine: boolean;
  inThisChat: boolean;
  updatedAt: string;
}

export type FoundItem = FoundFile | FoundArtifact;

export interface Found {
  items: FoundItem[];
  total: number;
  page: number;
  pages: number;
  /** With words: whether every word matched, or (when nothing had all of them) any of them. */
  matched: 'all' | 'any' | null;
  hidden: boolean;
}

function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** How much of a prompt a search page shows: a page of ten stays small however long the prompts are. */
export const PROMPT_LINE_LENGTH = 200;

/** A prompt as one line of at most PROMPT_LINE_LENGTH, cut on a word with "…" when longer. */
export function promptLine(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  if (line.length <= PROMPT_LINE_LENGTH) return line;
  const cut = clipText(line, PROMPT_LINE_LENGTH - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > PROMPT_LINE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function foundFile(row: FileSearchRow, who: Who, input: FindInput): FoundFile {
  return {
    type: 'file',
    ref: shortIdOf(row.number),
    name: row.name,
    kind: row.kind,
    source: row.source,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    line: row.line,
    made: row.made_with ? { with: row.made_with, prompt: row.made_prompt ? promptLine(row.made_prompt) : null, promptChars: row.made_prompt?.length ?? 0 } : null,
    lengthSeconds: row.length_seconds,
    pages: row.pages,
    mine: who.userId !== null && row.owner_id === who.userId,
    inThisChat: row.chat_kind === input.chat.kind && row.chat_ref === input.chat.ref,
    text: { state: row.text_state, chars: row.text_chars },
    createdAt: new Date(row.created_at).toISOString(),
  };
}

type ArtifactPick = { id: string; title: string; kind: string; makerName: string; latestVersion: number; ownerId: string | null; chatKind: string | null; chatRef: string | null; updatedAt: Date };

function foundArtifact(row: ArtifactPick, who: Who, input: FindInput): FoundArtifact {
  return {
    type: 'artifact',
    id: row.id,
    title: row.title,
    kind: row.kind,
    makerName: row.makerName,
    version: row.latestVersion,
    mine: who.userId !== null && row.ownerId === who.userId,
    inThisChat: row.chatKind === input.chat.kind && row.chatRef === input.chat.ref,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Newest first across both lists; a page from the top `offset + limit` of each. */
export function mergePage(files: FoundFile[], artifacts: FoundArtifact[], offset: number, limit: number): FoundItem[] {
  const when = (item: FoundItem) => (item.type === 'file' ? item.createdAt : item.updatedAt);
  return [...files, ...artifacts].sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0)).slice(offset, offset + limit);
}

/** The artifacts this person may find from here, by #655's rule, with the same filters as files. */
function artifactWhere(input: FindInput, who: Who, words: string[], mode: 'all' | 'any', now: Date) {
  const since = dateOf(input.since);
  const until = dateOf(input.until);
  const titleHas = words.map((word) => ({ title: { contains: word, mode: 'insensitive' as const } }));
  return {
    AND: [
      { OR: [{ chatKind: input.chat.kind, chatRef: input.chat.ref }, ...(who.userId ? [{ ownerId: who.userId }] : [])] },
      // A guest's artifact past its day is gone for everyone
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ...(titleHas.length === 0 ? [] : mode === 'all' ? titleHas : [{ OR: titleHas }]),
      ...(since ? [{ updatedAt: { gte: since } }] : []),
      ...(until ? [{ updatedAt: { lt: until } }] : []),
    ],
  };
}

const wantsArtifacts = (input: FindInput) => (!input.kinds || input.kinds.length === 0 || input.kinds.includes('artifact')) && input.source !== 'person';

export async function findFiles(input: FindInput, ctx: SearchContext = defaultContext()): Promise<Found> {
  const sql = ctx.sql ?? runWithPrisma;
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person);
  const { findable } = limitsOf(ctx);
  const limit = Math.max(1, Math.floor(input.limit));
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const offset = (page - 1) * limit;
  const words = searchWords(input.words);
  const fileKinds = input.kinds?.filter((kind): kind is FileKind => kind !== 'artifact') ?? null;
  const onlyArtifacts = !!input.kinds && input.kinds.length > 0 && fileKinds?.length === 0;

  const search = async (mode: 'all' | 'any') => {
    const query = wordQuery(words, mode);
    const built = fileSearchSql(
      {
        botId: input.botId,
        userId: who.userId,
        chatKind: input.chat.kind,
        chatRef: input.chat.ref,
        now: ctx.now,
        findableSince: findable > 0 ? new Date(ctx.now.getTime() - findable * 24 * 60 * 60 * 1000) : null,
      },
      { query, kinds: fileKinds, source: input.source ?? null, since: dateOf(input.since), until: dateOf(input.until) },
      { offset: 0, limit: offset + limit },
    );
    const artifactsWhere = artifactWhere(input, who, words, mode, ctx.now);
    const [fileTotal, fileRows, artifactTotal, artifactRows] = await Promise.all([
      onlyArtifacts ? Promise.resolve(0) : sql<{ total: number }>(built.count, built.values).then((rows) => Number(rows[0]?.total ?? 0)),
      onlyArtifacts ? Promise.resolve([] as FileSearchRow[]) : sql<FileSearchRow>(built.page, built.values),
      wantsArtifacts(input) ? prisma.artifact.count({ where: artifactsWhere }) : Promise.resolve(0),
      wantsArtifacts(input)
        ? prisma.artifact.findMany({
            where: artifactsWhere,
            orderBy: { updatedAt: 'desc' },
            take: offset + limit,
            select: { id: true, title: true, kind: true, makerName: true, latestVersion: true, ownerId: true, chatKind: true, chatRef: true, updatedAt: true },
          })
        : Promise.resolve([] as ArtifactPick[]),
    ]);
    return { query, total: fileTotal + artifactTotal, fileRows, artifactRows };
  };

  let mode: 'all' | 'any' = 'all';
  let result = await search('all');
  // Nothing had every word: say so, and show what has any of them
  if (result.total === 0 && words.length > 1) {
    mode = 'any';
    result = await search('any');
  }

  const items = mergePage(
    result.fileRows.map((row) => foundFile(row, who, input)),
    result.artifactRows.map((row) => foundArtifact(row, who, input)),
    offset,
    limit,
  );

  // Where the words are, for the files on this page only
  const pageFiles = items.filter((item): item is FoundFile => item.type === 'file');
  if (result.query && pageFiles.length > 0) {
    const ids = new Map(result.fileRows.map((row) => [shortIdOf(row.number), row.id]));
    const hits = fileHitsSql(pageFiles.map((item) => ids.get(item.ref) as string), result.query);
    const byId = new Map((await sql<FileHitRow>(hits.sql, hits.values)).map((row) => [row.bot_file_id, row]));
    for (const item of pageFiles) {
      const hit = byId.get(ids.get(item.ref) as string);
      if (hit) item.hit = hitOf(hit.start, hit.text, words);
    }
  }

  return {
    items,
    total: result.total,
    page,
    pages: Math.max(1, Math.ceil(result.total / limit)),
    matched: words.length > 0 ? mode : null,
    hidden,
  };
}

export interface ReadInput extends BotCall {
  ref: string;
  /** Where to start in the file's text, in characters (a search hit's `at`, or the last read's `next`). */
  at?: number | null;
  /** How much to read: the "Reads from a kept file" setting, sent by the bot server. */
  chars: number;
}

export interface Read {
  file: BotFileView;
  text: string;
  at: number;
  end: number;
  /** Where the next read starts; null at the end. */
  next: number | null;
  hidden: boolean;
}

/** A piece of a file's kept text, from a place in it, by characters (never more than one read's worth). */
export async function readFileText(input: ReadInput, ctx: Context = defaultContext()): Promise<Read> {
  const { hidden } = await passBotGate(input);
  const who = await resolvePerson(input.person);
  const row = await loadUsable(input, who, ctx);
  const total = row.textChars;
  const at = Math.min(Math.max(0, Math.floor(input.at ?? 0)), total);
  const end = Math.min(total, at + Math.max(1, Math.floor(input.chars)));
  let text = '';
  if (end > at) {
    // Parts are about TEXT_PART_CHARS long, so the one holding `at` starts no earlier than this
    const parts = await prisma.botFilePart.findMany({
      where: { botFileId: row.id, start: { gte: Math.max(0, at - TEXT_PART_CHARS), lt: end } },
      orderBy: { number: 'asc' },
      select: { start: true, text: true },
    });
    text = parts
      .filter((part) => part.start + part.text.length > at)
      .map((part) => part.text.slice(Math.max(0, at - part.start), Math.max(0, end - part.start)))
      .join('');
  }
  return { file: viewOf(row, who, input.chat), text, at, end: at + text.length, next: at + text.length < total ? at + text.length : null, hidden };
}
