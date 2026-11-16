import { botFileRoute, getSchema } from '@/lib/bot-files-http';
import { getFile } from '@/lib/bot-files';

export const runtime = 'nodejs';

/**
 * POST /api/bot-files/get
 * One file by its short id, if the person may use it here (game #1508): theirs from any chat with this bot, anyone
 * else's only in the chat it came in. Any other answers the same as a file that never was.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, ref, everyoneHere?, others? }
 * `everyoneHere: true` is for a reply other people in the chat read too (game #1993): then only a file that the person
 * and all of `others` (everyone else there now) were there for when it was put in a chat. Any other answers as one that
 * never was, the person's own included.
 * Response: { file, hidden }
 */
export const POST = botFileRoute('POST /api/bot-files/get', getSchema, (body, ctx) => getFile(body, ctx));
