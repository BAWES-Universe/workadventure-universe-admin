import { artifactRoute, viewerOnlySchema } from '@/lib/artifact-http';
import { listVersions } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/versions
 * Every version of an artifact, the newest first, each with what changed and who asked.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat, chat } }
 * Response: { versions: [{ number, summary, askedByName, sizeBytes, createdAt, url }] }. Only for someone who may open it.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/versions', 'game', viewerOnlySchema, (body, params) =>
  listVersions(params.id, body.viewer),
);
