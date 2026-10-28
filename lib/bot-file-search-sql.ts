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

/**
 * Punctuation, listed (ASCII, Latin, Arabic, general, CJK and full-width) rather than [[:punct:]], whose meaning follows
 * the server's locale and can take a Hindi vowel sign or virama for punctuation. The same class is in the migration's
 * SQL; keep them the same.
 */
export const PUNCTUATION_CLASS =
  '[\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E\\u00A1\\u00AB\\u00B7\\u00BB\\u00BF\\u060C\\u061B\\u061F\\u066A-\\u066C\\u06D4\\u2000-\\u206F\\u3000-\\u3003\\u3008-\\u3011\\u3014-\\u301F\\uFF01-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65]';

/**
 * The words Postgres keeps of some text: without Arabic marks, and split at punctuation as a search is ("plan.pdf" is
 * found by "pdf", "2024-05-01" by "05"; Postgres alone keeps "plan.pdf" whole and "-05" signed). The same expression as
 * the migration's, for a part's words and the index on a file's own words; keep them the same.
 */
export function wordsOfSql(text: string): string {
  return `to_tsvector('simple', regexp_replace(regexp_replace(${text}, '${ARABIC_MARKS_CLASS}', '', 'g'), '${PUNCTUATION_CLASS}', ' ', 'g'))`;
}
const ARABIC_MARKS = /[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/g;

/** The words of a search, lowercased, letters, digits and marks only, so they are safe inside a word query. */
export function searchWords(words: string | null | undefined): string[] {
  if (!words) return [];
  // Marks belong to their word (an Arabic vowel, an accent typed apart), so they never split one
  const found = words.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  // Arabic marks are left out as the stored words leave them out; any other mark stays, as Postgres keeps it in its word
  // (a Hindi vowel sign or virama has no letter to join), so "नमस्ते" finds नमस्ते. Only letters, digits and marks reach
  // the query, and a word needs a letter or digit
  const clean = found.map((word) => word.replace(ARABIC_MARKS, '').slice(0, MAX_WORD_LENGTH));
  const safe = clean.filter((word) => /[\p{L}\p{N}]/u.test(word));
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
  /**
   * For every word (`all`): the words, each to be found somewhere in the file, in its name, line or prompt or in any part
   * of its text ("plan thursday" finds plan.pdf that says Thursday). Null to match `query` as it is.
   */
  every?: string[] | null;
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
    filters.every && filters.every.length > 0 ? filters.every.map((word) => `${word}:*`) : null,
  ];
  const at = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;
  const matches = `
    WITH q AS (
      SELECT
        CASE WHEN $8::text IS NULL THEN NULL ELSE to_tsquery('simple', $8::text) END AS query,
        (SELECT array_agg(to_tsquery('simple', word)) FROM unnest($12::text[]) AS word) AS each_word
    ),
    matches AS (
      SELECT f.* FROM bot_files f CROSS JOIN q
      -- The file's own words, once per file: the start of a made file's prompt only (PROMPT_SEARCH_CHARS), the same
      -- expression as the migration's index
      CROSS JOIN LATERAL (
        SELECT CASE WHEN q.query IS NULL THEN NULL ELSE ${wordsOfSql(`f.name || ' ' || coalesce(f.line, '') || ' ' || left(coalesce(f.made_prompt, ''), 20000)`)} END AS words
      ) own
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
          OR (q.each_word IS NULL AND (own.words @@ q.query OR EXISTS (SELECT 1 FROM bot_file_parts p WHERE p.bot_file_id = f.id AND p.words @@ q.query)))
          -- Every word somewhere in the file: no word missing from both its own words and every part
          OR (
            q.each_word IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM unnest(q.each_word) AS word
              WHERE NOT (own.words @@ word OR EXISTS (SELECT 1 FROM bot_file_parts p WHERE p.bot_file_id = f.id AND p.words @@ word))
            )
          )
        )
    )`;
  return {
    values,
    count: `${matches} SELECT count(*)::int AS total FROM matches`,
    page: `${matches} SELECT ${FILE_COLUMNS} FROM matches ORDER BY created_at DESC, number DESC OFFSET ${offset} LIMIT ${limit}`,
  };
}

/**
 * Where the words are in each of these files, to show them: the first part with all of `query`, else the first with any
 * of `anyQuery` (the words can be in the name and the text, or across parts). Only for the page being sent.
 */
export function fileHitsSql(fileIds: string[], query: string, anyQuery: string = query): { sql: string; values: unknown[] } {
  return {
    values: [fileIds, query, anyQuery],
    sql: `
      SELECT DISTINCT ON (p.bot_file_id) p.bot_file_id, p.start, p.text
      FROM bot_file_parts p
      WHERE p.bot_file_id = ANY($1::text[]) AND p.words @@ to_tsquery('simple', $3::text)
      ORDER BY p.bot_file_id, (p.words @@ to_tsquery('simple', $2::text)) DESC, p.number`,
  };
}

/**
 * The artifacts in reach (this chat's, and the person's own) whose title has the words, each anywhere in it, with Arabic
 * marks left out of the title as they are of the words ("مرحبا" finds "مَرْحَبًا"). The words are letters and digits only.
 */
export function artifactTitleSql(scope: { userId: string | null; chatKind: string; chatRef: string }, words: string[], mode: 'all' | 'any'): { sql: string; values: unknown[] } {
  return {
    values: [scope.chatKind, scope.chatRef, scope.userId, words.map((word) => `%${word}%`)],
    sql: `
      SELECT id FROM artifacts
      WHERE ((chat_kind = $1 AND chat_ref = $2) OR ($3::text IS NOT NULL AND owner_id = $3::text))
        AND regexp_replace(title, '${ARABIC_MARKS_CLASS}', '', 'g') ILIKE ${mode === 'all' ? 'ALL' : 'ANY'} ($4::text[])`,
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
