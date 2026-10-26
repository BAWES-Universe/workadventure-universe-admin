import { artifactRoute, shareSchema } from '@/lib/artifact-http';
import { setSharing } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * PUT /api/artifacts/:id/share
 * The owner says who can open it ("chat": people in the chat it was made in, "link": anyone with the link) and who can
 * ask for changes ("owner": only them, "openers": everyone who can open it, in its chat). Send one or both.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat }, openScope?, changeScope? }
 * Response: { artifact }. Only the owner: someone else who can open it gets 403, someone who cannot gets 404.
 */
export const PUT = artifactRoute('PUT /api/artifacts/:id/share', 'game', shareSchema, (body, params) =>
  setSharing(params.id, body.viewer, body),
);
