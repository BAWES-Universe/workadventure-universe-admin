import { artifactRoute, chatListSchema } from '@/lib/artifact-http';
import { listChatArtifacts } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/chat
 * The artifacts made in one chat that the person may open, the most recently changed first, 50 at a time (game #1474):
 * the Artifacts group on a chat's profile or details, and its full list.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat, chat }, offset? }
 * Response: { artifacts: [{ ...artifact, yours }], total, next }
 */
export const POST = artifactRoute('POST /api/artifacts/chat', 'game', chatListSchema, (body) => listChatArtifacts(body.viewer, body.offset ?? 0));
