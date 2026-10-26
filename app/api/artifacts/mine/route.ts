import { artifactRoute, mineSchema } from '@/lib/artifact-http';
import { listMine } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/mine
 * The artifacts a signed-in person owns, the most recently changed first.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { person: { signedIn, identifier, name? } }
 * Response: { artifacts: [{ ...artifact }] }. A guest owns none.
 */
export const POST = artifactRoute('POST /api/artifacts/mine', 'game', mineSchema, (body) => listMine(body.person));
