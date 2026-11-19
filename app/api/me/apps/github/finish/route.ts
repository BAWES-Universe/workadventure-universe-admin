import { NextRequest } from 'next/server';
import { z } from 'zod';
import { markConnectionReconnected, newSignInNonceIfClear, NOT_FOUND } from '@/lib/app-connections';
import { getGitHubApp } from '@/lib/github/app';
import { finishGitHubSignIn, installPageFor, readReturnState } from '@/lib/github/connection';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

const finishSchema = z.object({ state: z.string().min(1).max(8000), code: z.string().min(1).max(500) }).strict();

/**
 * POST /api/me/apps/github/finish { state, code } - finishes a GitHub sign-in (game #2041) from the window that started it, with the
 * person's own sign-in: only the person who started this sign-in can finish it, so a sign-in address someone else made never puts
 * one person's GitHub on another's connection. The code is exchanged once (the connection's ticket, and PKCE where we started the sign-in).
 * The state is the sign-in's own (the separate way) or the install page's (the combined way, GitHub signing the person in at the end of
 * the install). Answers { id } and,
 * when Universe's GitHub App is not added anywhere of theirs yet, `installUrl`: the page to pick where it works.
 */
export async function POST(request: NextRequest) {
  return appsRoute(request, METHODS, 'finishing a GitHub sign-in', async (user, respond) => {
    const parsed = finishSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Sign in to GitHub again', code: 'sign_in_expired' }, 400);
    const state = readReturnState(parsed.data.state);
    if (!state) return respond({ error: 'Sign in to GitHub again', code: 'sign_in_expired' }, 400);
    // Someone else's sign-in answers like one that does not exist
    if (state.personId !== user.id) return respond({ error: NOT_FOUND }, 404);
    const outcome = await finishGitHubSignIn(state, parsed.data.code);
    if (outcome.status === 'gone') return respond({ error: NOT_FOUND }, 404);
    if (outcome.status === 'expired') return respond({ error: 'Sign in to GitHub again', code: 'sign_in_expired' }, 400);
    if (outcome.status !== 'done') return respond({ error: 'GitHub could not finish the sign-in just now', code: 'unavailable' }, 502);
    await markConnectionReconnected(state.connectionId, user.id);
    const app = outcome.needsInstall ? await getGitHubApp() : null;
    // The install page's ticket is made only when no newer sign-in's ticket stands: a sign-in opened while this one waited on GitHub keeps its own
    const nonce = app ? await newSignInNonceIfClear(state.connectionId) : null;
    return respond({ id: state.connectionId, ...(app && nonce ? { installUrl: installPageFor(app, state.connectionId, user.id, nonce, state.redirectUrl) } : {}) });
  });
}
