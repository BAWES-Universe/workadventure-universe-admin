import { botFileRoute, getSchema } from '@/lib/bot-files-http';
import { getFile } from '@/lib/bot-files';

export const runtime = 'nodejs';

/**
 * POST /api/bot-files/get
 * One file by its short id, if the person may use it here (game #1508): theirs from any chat with this bot, anyone
 * else's only in the chat it came in. Any other answers the same as a file that never was.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, ref }
 * Response: { file, hidden }
 */
export const POST = botFileRoute('POST /api/bot-files/get', getSchema, (body) => getFile(body));
