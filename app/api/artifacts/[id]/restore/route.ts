import { artifactRoute, restoreSchema } from '@/lib/artifact-http';
import { restoreVersion } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/restore
 * The owner restores an older version. That makes a new latest version with the same file ("Restored version N"); no
 * version is deleted, so a restore can be undone by restoring the one before it.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat }, number }
 * Response: { artifact, version, you }. Only the owner (403 for others who can open it, 404 for those who cannot).
 */
export const POST = artifactRoute('POST /api/artifacts/:id/restore', 'game', restoreSchema, (body, params) =>
  restoreVersion(params.id, body.number, body.viewer),
);
