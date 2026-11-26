import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { gitHubToken, gitHubTokenRefused } from '@/lib/github/connection';
import { checkGitKey, READ_ONLY_MESSAGE, recheckGitKey } from '@/lib/github/git-relay';
import { runGitHubTool } from '@/lib/github/tools';

export const runtime = 'nodejs';

const bodySchema = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
    head: z.string().min(1).max(255),
    base: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(256),
    body: z.string().max(20_000).optional(),
    draft: z.boolean().optional(),
  })
  .strict();

const no = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * POST /api/computer/github/pull { repo, head, base?, title, body?, draft? } - a Brick's computer opens a pull request for a branch it
 * pushed through the git relay (game #2041), as its owner. Signed in with the same job key as git (HTTP Basic, the key as the password; no other sign-in is taken),
 * so it ends with the job and the take-over like git does. Only a pull request: merging, closing and the rest are the Brick's own GitHub
 * tools, never the computer's. The owner's GitHub token stays in Orbit and GitHub decides which repositories it reaches. A computer that
 * may only read cannot open one, nor one whose Brick has Open a pull request on anything but Right away (a computer can't ask its owner,
 * lib/github/judge.ts). Answers { ok: true, number, url } or { ok: false, error }.
 */
export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get('authorization');
    const pass = await checkGitKey(authorization);
    if (!pass) return no('A job key from Universe is needed.', 401);
    if (pass.readOnly) return no(READ_ONLY_MESSAGE, 403);
    if (pass.stops.pullRequest) return no(pass.stops.pullRequest, 403);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return no('Say repo (owner/name), head (the branch you pushed) and title.', 400);
    const token = await gitHubToken(pass.connectionId);
    if (token.status === 'reconnect') return no("GitHub asked for a new sign-in: the Brick's owner needs to reconnect GitHub in Apps.", 403);
    if (token.status !== 'ok') return no('GitHub could not be reached just now.', 502);
    // A pull request is a change on GitHub: the key is looked at once more right before it is made
    const fresh = await recheckGitKey(authorization, pass);
    if (!fresh) return no('A job key from Universe is needed.', 401);
    if (fresh.readOnly) return no(READ_ONLY_MESSAGE, 403);
    if (fresh.stops.pullRequest) return no(fresh.stops.pullRequest, 403);
    const made = await runGitHubTool(token.token, 'github_create_pull_request', parsed.data);
    if (made.unauthorized) await gitHubTokenRefused(pass.connectionId, token.token);
    if (made.isError) return no(made.text.slice(0, 500), 422);
    const answer = JSON.parse(made.text) as { number?: number; url?: string };
    return NextResponse.json({ ok: true, number: answer.number, url: answer.url }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not open a pull request:', error instanceof Error ? error.message : 'unknown');
    return no('Could not open the pull request.', 500);
  }
}
