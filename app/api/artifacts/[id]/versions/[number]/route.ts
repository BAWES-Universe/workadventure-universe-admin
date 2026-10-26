import { artifactRoute, versionParam, viewerOnlySchema } from '@/lib/artifact-http';
import { readVersionCode } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/versions/:number
 * The code of one version, for the Code view.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat, chat } }
 * Response: { version, content }. Only for someone who may open it.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/versions/:number', 'game', viewerOnlySchema, (body, params) =>
  readVersionCode(params.id, versionParam(params.number), body.viewer),
);
