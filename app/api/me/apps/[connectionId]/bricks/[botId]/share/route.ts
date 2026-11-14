import { NextRequest } from 'next/server';
import { NOT_FOUND } from '@/lib/app-connections';
import { changeShare, changeShareSchema, readShare, startShare, startShareSchema, stopShare, type ShareProblem } from '@/lib/app-share-owner';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
type Params = { params: Promise<{ connectionId: string; botId: string }> };

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/** Plain words for what stopped a pick, for the page to show as it is. */
const WORDS: Record<ShareProblem, string> = {
  unknown_job: 'That is not something this app can be asked for right now',
  bad_input: 'That asks for something the job does not take',
  missing_input: 'The job needs an input that is not offered, so nobody could ask for it',
  bad_return: 'That asks for something the job does not give back',
  no_job: 'Pick what people can ask for first',
  unreachable: 'The app could not be reached just now, so its jobs cannot be picked. Try again soon',
};
const STATUS: Record<ShareProblem, number> = { unknown_job: 400, bad_input: 400, missing_input: 400, bad_return: 400, no_job: 409, unreachable: 503 };

/**
 * GET /api/me/apps/:id/bricks/:botId/share - "Other people" on the app's page (game #2006, mock Part 17): whether the app can be
 * shared at all (`shareable`: false is "Only for you", no button), whether it is (`shared`), the two limits, today's uses, and the jobs
 * with what each takes and gives back and which are picked. Only for the owner of the app and of the Brick (404 for anyone else). Never the app's link, key or account.
 */
export async function GET(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'reading what is shared', async (user, respond) => {
    const { connectionId, botId } = await params;
    const view = await readShare(user.id, connectionId, botId);
    if (!view) return respond({ error: NOT_FOUND }, 404);
    return respond(view);
  });
}

/**
 * POST /api/me/apps/:id/bricks/:botId/share { jobs?: [{ tool, inputs, returns }], usesPerDayEveryone?, usesPerDayPerson? } - "Let others use
 * it". With no jobs, the one job there is. The limits start at the ones a super admin set in Limits. 409 for an app signed in as the
 * person ("Only for you"). Asked again, the share that exists is returned unchanged (200).
 */
export async function POST(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'sharing an app', async (user, respond) => {
    const { connectionId, botId } = await params;
    const parsed = startShareSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    const result = await startShare(user.id, connectionId, botId, parsed.data);
    if (result.status === 'not_found') return respond({ error: NOT_FOUND }, 404);
    if (result.status === 'not_shareable') return respond({ error: 'This app is signed in as you, so it stays only for you' }, 409);
    if (result.status === 'refused') return respond({ error: WORDS[result.problem], reason: result.problem, ...(result.tool ? { tool: result.tool } : {}) }, STATUS[result.problem]);
    return respond(result.view, result.status === 'started' ? 201 : 200);
  });
}

/** PATCH /api/me/apps/:id/bricks/:botId/share { jobs?, usesPerDayEveryone?, usesPerDayPerson? } - "Change". `jobs` is the whole list of what can be asked for: a job left out stops at once. */
export async function PATCH(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'changing what is shared', async (user, respond) => {
    const { connectionId, botId } = await params;
    const parsed = changeShareSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    const result = await changeShare(user.id, connectionId, botId, parsed.data);
    if (result.status === 'not_found') return respond({ error: NOT_FOUND }, 404);
    if (result.status === 'refused') return respond({ error: WORDS[result.problem], reason: result.problem, ...(result.tool ? { tool: result.tool } : {}) }, STATUS[result.problem]);
    return respond(result.view);
  });
}

/** DELETE /api/me/apps/:id/bricks/:botId/share - "Stop letting others use it": every later ask is refused at once, in a chat that is already open too. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'stopping sharing', async (user, respond) => {
    const { connectionId, botId } = await params;
    if (!(await stopShare(user.id, connectionId, botId))) return respond({ error: NOT_FOUND }, 404);
    return respond({}, 204);
  });
}
