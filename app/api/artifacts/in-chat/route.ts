import { artifactRoute, inChatSchema } from '@/lib/artifact-http';
import { listArtifactsInChat } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/in-chat
 * The artifacts made in this chat that the person may open, the most recently changed first (up to 20). A bot asks it to
 * find the artifact a person means in a later message, and after a restart.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat }
 * Response: { artifacts, hidden }
 */
export const POST = artifactRoute('POST /api/artifacts/in-chat', 'bot', inChatSchema, (body) => listArtifactsInChat(body));
