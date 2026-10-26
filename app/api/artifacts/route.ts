import { artifactRoute, makeSchema } from '@/lib/artifact-http';
import { makeArtifact } from '@/lib/artifact-service';

export const runtime = 'nodejs';

/**
 * POST /api/artifacts
 * A bot makes an artifact for the person who asked, in the chat they asked in (game #1422, Orbit #622).
 *
 * Auth: BOT_SERVICE_TOKEN (the admin token also works).
 * Body: { botId, person: { signedIn, identifier?, name? }, chat: { kind: "nearby" | "dm", ref }, title,
 *   kind: "app" | "page" | "markdown" | "svg", content, summary? }
 * Response: { artifact, version, hidden }. `hidden` is the Bot chat telemetry switch for this bot: when true the bot
 * server keeps the artifact's text out of PostHog and Sentry.
 *
 * The same checks as /api/bots/:id/access come first: a person who cannot chat with the bot (or message it, in a
 * direct chat) gets 403. A guest's artifact is kept for a day.
 */
export const POST = artifactRoute('POST /api/artifacts', 'bot', makeSchema, (body) => makeArtifact(body));
