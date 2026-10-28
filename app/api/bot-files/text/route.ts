import { botFileRoute, keepTextSchema } from '@/lib/bot-files-http';
import { keepFileText } from '@/lib/bot-files';

export const runtime = 'nodejs';

/**
 * POST /api/bot-files/text
 * Keeps a file's whole text (game #1508), read by the bot server in the background after the reply, in place of any kept
 * before; or marks that it could not be read. Kept up to the super admin's limit, in parts, for search.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, ref, text } or { ..., failed: true }
 * Response: { file, hidden }
 */
export const POST = botFileRoute('POST /api/bot-files/text', keepTextSchema, (body, ctx) => keepFileText(body, ctx));
