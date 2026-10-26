import { artifactRoute, changeSchema } from '@/lib/artifact-http';
import { changeArtifact } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/change
 * A bot changes an artifact: small edits to the latest version (like an editor's replace) or the whole new file. Every
 * change is a new version with who asked; nothing is overwritten.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works).
 * Body: { botId, person, chat, edits?: [{ old, new, all? }], content?, summary?, title?, baseVersion? }, exactly one of
 *   edits and content. `baseVersion` is the version the bot read; a newer one in between answers 409 stale_version.
 * Response: { artifact, version, hidden }. An edit that finds nothing, or finds its text more than once, answers 422
 *   (edit_not_found, edit_ambiguous) and changes nothing.
 *
 * The owner may ask in any chat. Anyone else only in the chat it was made in, and only when the owner allowed everyone
 * who can open it to ask. Someone who may not even open it hears 404.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/change', 'bot', changeSchema, (body, params) =>
  changeArtifact({ ...body, artifactId: params.id }),
);
