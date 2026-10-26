import { artifactRoute, openSchema } from '@/lib/artifact-http';
import { openArtifact } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/open
 * The game opens an artifact for a person: what it is, the version to run (the latest unless one is asked for), where
 * that file is served from, and what this person may do (change, share and restore, make a copy).
 *
 * Auth: ADMIN_API_TOKEN (the game's server). Body: { viewer: { person, inChat, chat }, version? }. `inChat` says the person
 * is in the chat it was made in right now; the game vouches for it.
 * Response: { artifact, version: { number, summary, askedByName, sizeBytes, createdAt, url }, you }.
 * Someone who may not open it hears 404, the same as for one that is not there.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/open', 'game', openSchema, (body, params) =>
  openArtifact(params.id, body.viewer, body.version),
);
