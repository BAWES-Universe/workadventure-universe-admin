import { NextRequest, NextResponse } from 'next/server';
import { checkGitKey, MAX_PUSH_BYTES, readCapped, readRelayPath, recheckGitKey, relayGit, UPLOAD_GRACE_SECONDS } from '@/lib/github/git-relay';

export const runtime = 'nodejs';

type Params = { params: Promise<{ path: string[] }> };

const plain = (text: string, status: number, extra: Record<string, string> = {}) =>
  new NextResponse(`${text}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

/**
 * /api/git/<owner>/<repo>.git/... - the git relay for a Brick's computer (game #2041): git's smart HTTP, signed in with the running
 * job's git key (HTTP Basic, the key as the password; it is the only sign-in taken). Orbit adds the owner's own GitHub token and passes
 * the request to github.com; the computer never holds that token. A push that deletes a branch, pushes a tag or overwrites a branch is
 * turned down here, and the key is looked at again right before a push goes to GitHub.
 */
const needPass = () => plain('A job key from Universe is needed (it ends with the job, or when the person takes the computer).', 401, { 'WWW-Authenticate': 'Basic realm="Universe git"' });

async function handle(request: NextRequest, { params }: Params): Promise<NextResponse | Response> {
  const authorization = request.headers.get('authorization');
  let pass = await checkGitKey(authorization);
  if (!pass) return needPass();
  const target = readRelayPath((await params).path ?? []);
  if (!target) return plain('Not a git address Universe passes on.', 404);
  let body: Buffer | null = null;
  if (request.method === 'POST') {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_PUSH_BYTES) return plain('This push is too big for Universe to pass on.', 413);
    // Read as it streams and stopped past the limit: a chunked push declares no length
    const read = await readCapped(request.body, MAX_PUSH_BYTES);
    if (read === 'late') return plain('This push took too long to upload. Try again.', 408);
    if (!read) return plain('This push is too big for Universe to pass on.', 413);
    body = read;
    // The owner may have turned GitHub off for this Brick, or the job may have ended or been taken over, while it uploaded: checked
    // again before anything goes to GitHub, and for the same job. A key that was good when the upload started and ran out during it
    // still counts (the upload itself is limited to UPLOAD_MS).
    pass = await recheckGitKey(authorization, pass, UPLOAD_GRACE_SECONDS);
    if (!pass) return needPass();
  }
  const accepted = pass;
  const url = new URL(request.url);
  const outcome = await relayGit(pass, target, {
    method: request.method,
    search: url.search,
    contentType: request.headers.get('content-type'),
    contentEncoding: request.headers.get('content-encoding'),
    gitProtocol: request.headers.get('git-protocol'),
    body,
    // The last look, right before a push is passed to GitHub (after it was read and checked, which may take a while)
    recheck: () => recheckGitKey(authorization, accepted, UPLOAD_GRACE_SECONDS),
  });
  switch (outcome.status) {
    case 'pass':
    case 'refused':
      return outcome.response;
    case 'revoked':
      return needPass();
    case 'reconnect':
      return plain("GitHub asked for a new sign-in: the Brick's owner needs to reconnect GitHub in Apps.", 403);
    case 'too_big':
      return plain('This push is too big for Universe to pass on.', 413);
    case 'bad_request':
      return plain('Universe could not read this git request.', 400);
    default:
      return plain('GitHub could not be reached just now.', 502);
  }
}

export const GET = handle;
export const POST = handle;
