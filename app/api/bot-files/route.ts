import { addSchema, botFileRoute } from '@/lib/bot-files-http';
import { addFile } from '@/lib/bot-files';

export const runtime = 'nodejs';

/**
 * POST /api/bot-files
 * Adds a file to a bot's list for the person (game #1508): one they sent the bot, or one the bot sent them. The bot server
 * calls it after the reply. The answer's short id (f12) is what the bot uses for the file from then on.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, source, kind, name, mimeType?,
 * sizeBytes?, store: { bucket, fileId } | { url }, line? }
 * Response: { file, hidden }
 */
export const POST = botFileRoute('POST /api/bot-files', addSchema, (body) => addFile(body));
