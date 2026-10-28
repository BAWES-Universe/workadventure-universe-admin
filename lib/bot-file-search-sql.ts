/**
 * The search over files in bot chats (game #1508), as SQL with no database of its own, so the tests run the same text on
 * a real Postgres (PGlite). lib/bot-file-search.ts runs it through Prisma.
 *
 * It looks only where the person may: their own files with this bot, and the files of the chat they are asking in. It
 * uses Postgres's own word index in 'simple' mode (no extension): a part's stored `words`, and the expression index on a
 * file's name and line (the expression below must stay the same as the migration's).
 */

/** At most this many words of a search are used; each is matched as the start of a word ("yazo" finds "yazoghal"). */
export const MAX_SEARCH_WORDS = 8;
const MAX_WORD_LENGTH = 64;

/**
 * Arabic short vowels, shadda, sukun, Quranic marks and tatweel. Postgres keeps them inside its words, so they are left
 * out of the stored words (the migration) and of the search words, and "مَرْحَبًا" and "مرحبا" find each other. The same
 * class is in the migration's SQL; keep them the same.
 */
export const ARABIC_MARKS_CLASS = '[\\u0610-\\u061A\\u0640\\u064B-\\u065F\\u0670\\u06D6-\\u06ED]';
const ARABIC_MARKS = /[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/g;

/** The words of a search, lowercased, letters and digits only, so they are safe inside a word query. */
export function searchWords(words: string | null | undefined): string[] {
  if (!words) return [];
  // Marks belong to their word (an Arabic vowel, an accent typed apart), so they never split one
  const found = words.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  const clean = found.map((word) => word.replace(ARABIC_MARKS, ''));
  // Only letters and digits reach the query: any other mark left after NFC is dropped
  const safe = clean.map((word) => word.replace(/[^\p{L}\p{N}]/gu, '').slice(0, MAX_WORD_LENGTH)).filter((word) => word.length > 0);
  return [...new Set(safe)].slice(0, MAX_SEARCH_WORDS);
}

/** A word query: every word (`all`), or any of them (`any`), each as the start of a word. Null for no words. */
export function wordQuery(words: string[], mode: 'all' | 'any'): string | null {
  if (words.length === 0) return null;
  return words.map((word) => `${word}:*`).join(mode === 'all' ? ' & ' : ' | ');
}

export interface SearchScope {
  botId: string;
  /** The person's Orbit account; null for a guest. */
  userId: string | null;
  chatKind: string;
  chatRef: string;
  now: Date;
  /** Files made before this can no longer be found (the super admin's days); null = no end. */
  findableSince: Date | null;
}

export interface SearchFilters {
  /** From wordQuery. */
  query: string | null;
  kinds: string[] | null;
  source: string | null;
  since: Date | null;
  until: Date | null;
}

export interface FileSearchSql {
  count: string;
  page: string;
  values: unknown[];
}

const FILE_COLUMNS = `id, number, owner_id, source, kind, name, mime_type, size_bytes, line, made_with, made_prompt, length_seconds, pages, chat_kind, chat_ref, text_state, text_chars, created_at`;

/** The count of every match, and one page of them, newest first. */
export function fileSearchSql(scope: SearchScope, filters: SearchFilters, page: { offset: number; limit: number }): FileSearchSql {
  const offset = Math.max(0, Math.floor(page.offset));
  const limit = Math.max(1, Math.floor(page.limit));
  // Dates go as UTC text and are read as UTC: the columns hold UTC without a zone, and a driver that sends a date in the
  // server's own zone would otherwise move every bound by that zone's hours
  const utc = (date: Date | null) => (date ? date.toISOString() : null);
  const values = [
    scope.botId,
    scope.userId,
    scope.chatKind,
    scope.chatRef,
    utc(scope.now),
    utc(scope.findableSince),
    filters.kinds && filters.kinds.length > 0 ? filters.kinds : null,
    filters.query,
    filters.source,
    utc(filters.since),
    utc(filters.until),
  ];
  const at = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;
  const matches = `
    WITH q AS (SELECT CASE WHEN $8::text IS NULL THEN NULL ELSE to_tsquery('simple', $8::text) END AS query),
    matches AS (
      SELECT f.* FROM bot_files f CROSS JOIN q
      WHERE f.bot_id = $1
        AND ((f.owner_id IS NOT NULL AND f.owner_id = $2::text) OR (f.chat_kind = $3 AND f.chat_ref = $4))
        AND (f.expires_at IS NULL OR f.expires_at > ${at(5)})
        AND ($6::text IS NULL OR f.created_at > ${at(6)})
        AND ($7::text[] IS NULL OR f.kind = ANY($7::text[]))
        AND ($9::text IS NULL OR f.source = $9::text)
        AND ($10::text IS NULL OR f.created_at >= ${at(10)})
        AND ($11::text IS NULL OR f.created_at < ${at(11)})
        AND (
          q.query IS NULL
          OR to_tsvector('simple', regexp_replace(f.name || ' ' || coalesce(f.line, '') || ' ' || coalesce(f.made_prompt, ''), '${ARABIC_MARKS_CLASS}', '', 'g')) @@ q.query
          OR EXISTS (SELECT 1 FROM bot_file_parts p WHERE p.bot_file_id = f.id AND p.words @@ q.query)
        )
    )`;
  return {
    values,
    count: `${matches} SELECT count(*)::int AS total FROM matches`,
    page: `${matches} SELECT ${FILE_COLUMNS} FROM matches ORDER BY created_at DESC, number DESC OFFSET ${offset} LIMIT ${limit}`,
  };
}

/** The first part of each of these files that has the words, to show where they are. Only for the page being sent. */
export function fileHitsSql(fileIds: string[], query: string): { sql: string; values: unknown[] } {
  return {
    values: [fileIds, query],
    sql: `
      SELECT DISTINCT ON (p.bot_file_id) p.bot_file_id, p.start, p.text
      FROM bot_file_parts p
      WHERE p.bot_file_id = ANY($1::text[]) AND p.words @@ to_tsquery('simple', $2::text)
      ORDER BY p.bot_file_id, p.number`,
  };
}

/** A row of the page, as Postgres gives it. */
export interface FileSearchRow {
  id: string;
  number: number;
  owner_id: string | null;
  source: string;
  kind: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  line: string | null;
  made_with: string | null;
  made_prompt: string | null;
  length_seconds: number | null;
  pages: number | null;
  chat_kind: string;
  chat_ref: string;
  text_state: string;
  text_chars: number;
  created_at: Date;
}

export interface FileHitRow {
  bot_file_id: string;
  start: number;
  text: string;
}

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 200;

/**
 * Where in a matching part the first search word is, as a place in the file's text to open from, with a short piece of
 * text around it. The part is where Postgres found the words; this finds the first one inside it.
 */
export function hitOf(start: number, text: string, words: string[]): { at: number; snippet: string } {
  let index = -1;
  for (const word of words) {
    // The text may carry Arabic marks the word has not: let any follow each letter
    const pattern = [...word].map((letter) => `${letter}${ARABIC_MARKS.source}*`).join('');
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}`, 'iu').exec(text);
    if (match && (index === -1 || match.index < index)) index = match.index;
  }
  const from = Math.max(0, (index === -1 ? 0 : index) - SNIPPET_BEFORE);
  const snippet = text.slice(from, from + SNIPPET_LENGTH).replace(/\s+/g, ' ').trim();
  return { at: start + from, snippet: `${from > 0 ? '…' : ''}${snippet}${from + SNIPPET_LENGTH < text.length ? '…' : ''}` };
}
