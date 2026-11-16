import { addSchema, botFileRoute } from '@/lib/bot-files-http';
import { addFile } from '@/lib/bot-files';

export const runtime = 'nodejs';

/**
 * POST /api/bot-files
 * Adds a file to a bot's list for the person (game #1508): one they sent the bot, or one the bot sent them. The bot server
 * calls it after the reply. The answer's short id (f12) is what the bot uses for the file from then on.
 *
 * `others` (game #1993) is everyone else who was in the bubble or meeting room when it was put in the chat, by the ids the
 * bot server names people by. Orbit keeps them with the person: a reply other people read uses the file only when all of
 * its readers were there. Left out: nobody else was. In a direct message nobody else ever is.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, source, kind, name, mimeType?,
 * sizeBytes?, store: { bucket, fileId } | { url }, line?, others? }
 * Response: { file, hidden }
 */
export const POST = botFileRoute('POST /api/bot-files', addSchema, (body, ctx) => addFile(body, ctx));
