import { botFileRoute, findSchema } from '@/lib/bot-files-http';
import { findFiles, type FindInput } from '@/lib/bot-file-search';

export const runtime = 'nodejs';

/**
 * POST /api/bot-files/find
 * Finds files and artifacts for the person (game #1508): their files with this bot and this chat's, by words, kind, who
 * sent them and dates, and artifacts by the rule bots use for them (this chat's, and the person's own from any chat).
 * Newest first, one page at a time, with the total.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, words?, kinds?, source?, since?,
 * until?, page?, limit }
 * Response: { items, total, page, pages, matched, hidden }
 */
export const POST = botFileRoute('POST /api/bot-files/find', findSchema, (body, ctx) => findFiles(body as FindInput, ctx));
