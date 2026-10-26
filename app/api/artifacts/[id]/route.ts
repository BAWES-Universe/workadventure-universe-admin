import { artifactRoute, deleteSchema } from '@/lib/artifact-http';
import { deleteArtifact } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * DELETE /api/artifacts/:id
 * The owner deletes it, with every version and file. A copy someone made earlier keeps its own files. Nothing is kept.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat, chat } }
 * Response: { deleted: true }. Only the owner (403 for others who can open it, 404 for those who cannot). A guest's
 * artifact has no owner and clears by itself after a day.
 */
export const DELETE = artifactRoute('DELETE /api/artifacts/:id', 'game', deleteSchema, (body, params) => deleteArtifact(params.id, body.viewer));
