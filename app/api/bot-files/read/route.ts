import { botFileRoute, readSchema } from '@/lib/bot-files-http';
import { readFileText } from '@/lib/bot-file-search';

export const runtime = 'nodejs';

/**
 * POST /api/bot-files/read
 * A piece of a file's kept text (game #1508), from a place in it (a search hit's `at`, or the last read's `next`), up to
 * the read size the bot server sends. Never the whole of a long file at once.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, ref, at?, chars }
 * Response: { file, text, at, end, next, hidden }
 */
export const POST = botFileRoute('POST /api/bot-files/read', readSchema, (body, ctx) => readFileText(body, ctx));
