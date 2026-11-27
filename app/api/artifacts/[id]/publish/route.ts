import { artifactRoute, publishSchema } from '@/lib/artifact-http';
import { publishArtifact } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/publish
 * The owner publishes a version (game #2115): people who open the artifact only by its link ("Anyone with the link" or
 * "Public") then see that version, under the title it has now, until the owner publishes another. The owner and the people
 * in its chat still see the latest. A link that was never published shows the latest, as before; Public with nothing
 * published shows "Not available". Publishing the version that is published already only moves the time.
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat, chat }, version? }: the version the owner was
 * looking at; the latest when left out. There is no bot route for this: only the owner, in the game, publishes.
 * Response: { artifact } with `published: { version, at }`. Only the owner: someone else who can open it gets 403, someone
 * who cannot gets 404. 409 not_shared: it is "Just you" or only for its chat, so there is nothing to publish to.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/publish', 'game', publishSchema, (body, params) =>
  publishArtifact(params.id, body.viewer, body),
);
