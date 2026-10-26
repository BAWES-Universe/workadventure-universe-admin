import { artifactRoute, openSchema } from '@/lib/artifact-http';
import { copyArtifact } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/copy
 * Make a copy: the signed-in person's own artifact, from the latest version or the one asked for. It sits in no chat, so
 * only its owner opens it until they share it, and any bot they talk to can change it.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat }, version? }
 * Response: { artifact, version, you }. A guest gets 403 sign_in_required; someone who may not open the original, 404.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/copy', 'game', openSchema, (body, params) =>
  copyArtifact(params.id, body.viewer, body.version),
);
