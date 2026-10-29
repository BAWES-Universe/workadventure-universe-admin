import { artifactRoute, ownedListSchema } from '@/lib/artifact-http';
import { listOwnedBy } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/owned
 * Every artifact a signed-in person owns, from every chat and bot, the most recently changed first, 50 at a time
 * (game #1609): Your artifacts in the game's window. The same pages as GET /api/me/artifacts.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { person: { signedIn, identifier, name? }, offset? }
 * Response: { artifacts: [...], total, next }. A guest owns none.
 */
export const POST = artifactRoute('POST /api/artifacts/owned', 'game', ownedListSchema, (body) => listOwnedBy(body.person, body.offset ?? 0));
