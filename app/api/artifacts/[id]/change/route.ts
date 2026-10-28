import { artifactRoute, changeSchema } from '@/lib/artifact-http';
import { changeArtifact } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/change
 * A bot changes an artifact: small edits to the latest version (like an editor's replace) or the whole new file. Every
 * change is a new version with who asked; nothing is overwritten.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works).
 * Body: { botId, person, chat, edits?: [{ old, new, all? }], content?, summary?, title?, baseVersion?, dropMedia? }, one
 *   of edits and content, or neither when only the media change. New songs, images or videos come as a form, the same
 *   way as for POST /api/artifacts (#1510); the new version keeps the media it had unless `dropMedia` names them, and a
 *   new one with a kept name takes its place. `baseVersion` is the version the bot read; a newer one in between answers 409 stale_version.
 * Response: { artifact, version, hidden }. An edit that finds nothing, or finds its text more than once, answers 422
 *   (edit_not_found, edit_ambiguous) and changes nothing.
 *
 * The owner may ask in any chat. Anyone else only in the chat it was made in, and only when the owner allowed everyone
 * who can open it to ask. Someone who may not even open it hears 404.
 */
export const POST = artifactRoute(
  'POST /api/artifacts/:id/change',
  'bot',
  changeSchema,
  (body, params, media) => changeArtifact({ ...body, artifactId: params.id, media }),
  { media: true },
);
