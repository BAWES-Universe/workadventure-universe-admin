import { artifactRoute, readSchema } from '@/lib/artifact-http';
import { readArtifact } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts/:id/read
 * A bot reads an artifact: its latest version, or the one asked for, with the file's text.
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works). Body: { botId, person, chat, version? }
 * Response: { artifact, version, content, hidden }. Only for someone who may open it.
 */
export const POST = artifactRoute('POST /api/artifacts/:id/read', 'bot', readSchema, (body, params) =>
  readArtifact({ ...body, artifactId: params.id }),
);
