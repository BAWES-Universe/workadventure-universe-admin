import { botFileRoute, findSchema } from '@/lib/bot-files-http';
import { findFiles, type FindInput } from '@/lib/bot-file-search';

export const runtime = 'nodejs';

/**
 * POST /api/bot-files/find
 * Finds files and artifacts for the person (game #1508): their files with this bot and this chat's, by words, kind, who
 * sent them and dates, and artifacts by the rule bots use for them (this chat's, and the person's own from any chat).
 * Newest first, one page at a time, with the total.
 *
 * With `everyoneHere` (game #1993) what is found goes into a reply other people in this chat read. Of the files, only
 * those everyone who reads it was there for when they were put in a chat: the person, and `others`, everyone else in the
 * bubble or meeting room now. With nobody named in `others`, or someone who cannot be named, no file is found. Of the
 * artifacts, only this chat's, and no "Just you", the person's own neither.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, words?, kinds?, source?, since?,
 * until?, page?, limit, everyoneHere?, others? }
 * Response: { items, total, page, pages, matched, hidden }
 */
export const POST = botFileRoute('POST /api/bot-files/find', findSchema, (body, ctx) => findFiles(body as FindInput, ctx));
