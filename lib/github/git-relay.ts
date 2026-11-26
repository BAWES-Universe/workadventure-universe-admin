import { createGunzip } from 'zlib';
import { gitHubToken, gitHubTokenRefused } from '@/lib/github/connection';
import type { FetchLike } from '@/lib/github/api';
import { jobGitAccess } from '@/lib/github/git-login';
import type { ComputerStep } from '@/lib/github/judge';
import { verifyJobToken } from '@/lib/computer-token';
import { buildsOn, readPackCommits, VERIFY_MAX_BYTES } from '@/lib/github/pack-commits';

/**
 * The git relay (game #2041): a Brick's computer has full git, but never the owner's GitHub key. Its remote is Orbit
 * (`https://orbit…/api/git/<owner>/<repo>.git`), signed in with the running job's git key (`cjt_…`, computer-token.ts). Orbit checks the
 * key against its own records of the job on every request, puts the owner's own token on the request and passes it to github.com.
 * The job key is the ONLY sign-in the relay takes: an earlier "git pass" (an encrypted, 15-minute pass for a Brick and a grant, tied
 * to no job, no read-only scope and no control number) was retired, so nothing that outlives the job, a take-over or a revoked grant
 * can push. What a Brick may not do through it, whatever it is told: delete a branch, push a tag, or overwrite a branch (a push to an
 * existing branch must be proved to build on what the branch has: it adds commits, it never replaces history).
 */

/** The most a push may carry through the relay. */
export const MAX_PUSH_BYTES = 200 * 1024 * 1024;
/**
 * A push must finish uploading within this long. The key is checked again once it has (the owner may have turned GitHub off
 * meanwhile), and once more right before the push goes to GitHub; a key that ran out during the upload still counts for this long
 * after, so a big push on a slow line is not lost. A key that was revoked, or a job that ended or was taken over, never counts.
 */
export const UPLOAD_MS = 10 * 60_000;
export const UPLOAD_GRACE_SECONDS = UPLOAD_MS / 1000;
/** The most of a gzipped push that is unpacked to read its ref updates: they come first, and the rest is passed on as it was. */
const COMMANDS_MAX_BYTES = 1024 * 1024;
/** How long GitHub has to start answering a git request: a push gets longer, GitHub answers it after taking the whole pack in. */
const GITHUB_ANSWER_MS = 60_000;
const GITHUB_PUSH_ANSWER_MS = 10 * 60_000;
const ZERO_ID = /^0{40}$|^0{64}$/;

/** A job key that passed: who it is for, read from Orbit's records of the job (never from anything the computer says). */
export interface GitPass {
  /** The running job the key belongs to, and the control number it was made under (a take-over moves the job's number on). */
  jobId: string;
  generation: number;
  botId: string;
  connectionId: string;
  ownerId: string;
  /** A computer's job that may only read (a job that is only to look): a push is turned down. */
  readOnly: boolean;
  /** Why each step may not run (its GitHub action is not Right away for this Brick), or null when it may (lib/github/judge.ts). */
  stops: Record<ComputerStep, string | null>;
}

/**
 * The sign-in in a git request (HTTP Basic: any user name, the secret as the password), still good and still allowed, or null. The
 * secret must be a running job's git key (what a Brick's computer holds: `cjt_…`), checked against Orbit's records of the job each
 * time: scope "git", not revoked, not run out, the job still running under the control number the key was made for (a take-over, the
 * end of the job and GitHub taken from the Brick all end it), the job the owner's own, the Brick the owner's own and not deleted, and
 * the owner's grant of their GitHub still on. Anything else, including the old encrypted pass, is refused. A key that ran out only
 * during an upload still counts for `graceSeconds`.
 */
export async function checkGitKey(authorization: string | null, graceSeconds = 0): Promise<GitPass | null> {
  if (!authorization?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
  const secret = decoded.slice(decoded.indexOf(':') + 1);
  if (!secret.startsWith('cjt_')) return null;
  const verified = await verifyJobToken(secret, 'git', new Date(Date.now() - graceSeconds * 1000));
  if (!verified.ok) return null;
  const access = await jobGitAccess(verified.jobId);
  if (!access || access.botId !== verified.botId) return null;
  return { jobId: verified.jobId, generation: verified.generation, botId: access.botId, connectionId: access.connectionId, ownerId: access.ownerId, readOnly: !access.mayPush, stops: access.stops };
}

/**
 * The same key looked at again, right before something is forwarded to GitHub: it must still be good, and still be for the same job,
 * control number, Brick, owner and GitHub connection as when the request was let in (a connection swapped while the upload ran is
 * not the one that was let in). The fresh answer, with whether it may still push, or null.
 */
export async function recheckGitKey(authorization: string | null, before: GitPass, graceSeconds = 0): Promise<GitPass | null> {
  const now = await checkGitKey(authorization, graceSeconds);
  if (!now) return null;
  const same = now.jobId === before.jobId && now.generation === before.generation && now.botId === before.botId && now.connectionId === before.connectionId && now.ownerId === before.ownerId;
  return same ? now : null;
}

const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/;
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

export interface RelayTarget {
  repo: string;
  /** `info/refs` (with its service), or one of the two services. */
  step: 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
}

/** Reads `owner/repo(.git)/info/refs` or `owner/repo(.git)/git-(upload|receive)-pack`. Null for anything else (LFS, the dumb protocol). */
export function readRelayPath(parts: string[]): RelayTarget | null {
  if (parts.length < 3) return null;
  const tail = parts.slice(2).join('/');
  const match = REPO_RE.exec(`${parts[0]}/${parts[1]}`);
  if (!match) return null;
  const repo = `${match[1]}/${match[2]}`;
  if (tail === 'info/refs') return { repo, step: 'info/refs' };
  if (SERVICES.has(tail)) return { repo, step: tail as RelayTarget['step'] };
  return null;
}

/**
 * A request body read as it streams, stopping as soon as it passes `max` bytes: null then, and the rest is never read. A chunked
 * request says nothing of its size up front, so its Content-Length cannot be trusted to say it.
 */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number, timeoutMs = UPLOAD_MS): Promise<Buffer | null | 'late'> {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === 'late') {
        reader.cancel().catch(() => undefined);
        return 'late';
      }
      const { done, value } = next;
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, size);
}

/**
 * The start of a gzipped body, unpacked up to `max` bytes and no further, so a small body that unpacks to gigabytes costs nothing.
 * Null when it is not gzip.
 */
export function unzipStart(body: Buffer, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const unzip = createGunzip();
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      unzip.destroy();
      resolve(value);
    };
    unzip.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= max) finish(Buffer.concat(chunks, size).subarray(0, max));
    });
    unzip.on('end', () => finish(Buffer.concat(chunks, size)));
    unzip.on('error', () => finish(null));
    unzip.end(body);
  });
}

export interface RefUpdate {
  oldId: string;
  newId: string;
  ref: string;
}

/** git's probe before a push it sends in pieces: one flush packet and nothing else. */
const isProbe = (body: Buffer | null): boolean => !!body && body.length === 4 && body.toString('ascii') === '0000';

/**
 * The ref updates at the start of a push (git's receive-pack request: pkt-lines up to the first flush). Null when the request is
 * not one that can be read: a push that cannot be read is refused, never passed on unchecked.
 */
export function readPushCommands(body: Buffer): { updates: RefUpdate[]; capabilities: string[]; packAt: number } | null {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const length = parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) return null;
    if (length === 0) return updates.length ? { updates, capabilities, packAt: at + 4 } : null;
    if (length < 4 || at + length > body.length) return null;
    let line = body.subarray(at + 4, at + length).toString('utf8');
    at += length;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (updates.length === 0) capabilities = line.slice(nul + 1).trim().split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    // A push certificate or shallow line comes first in some pushes: only ref updates matter here
    if (line.startsWith('shallow ') || line.startsWith('push-cert')) continue;
    const [oldId, newId, ref] = line.split(' ');
    if (!oldId || !newId || !ref) return null;
    updates.push({ oldId, newId, ref });
  }
  return null;
}

/** What a Brick may not push: a deleted branch (or anything deleted), and any tag. The reason, or null when it may go. */
export function refusedPush(updates: RefUpdate[]): string | null {
  for (const update of updates) {
    if (update.ref.startsWith('refs/tags/')) return `Pushing tags is not allowed for Bricks (${update.ref}).`;
    if (ZERO_ID.test(update.newId)) return `Deleting is not allowed for Bricks (${update.ref}).`;
    if (!update.ref.startsWith('refs/heads/')) return `Only branches can be pushed (${update.ref}).`;
  }
  return null;
}

/**
 * A push that moves an existing branch (it had a commit before) must build on it: its new tip has to come from the old one through
 * commits the push carries. That is how a forced overwrite is told from an addition, since both look alike in the ref update.
 * Nothing is guessed: a push that cannot be read, is too big to check, or moves a branch back or sideways is turned down, and the
 * Brick is told to push a new branch instead. The reason, or null when it may go.
 */
export async function refusedOverwrite(
  updates: RefUpdate[],
  body: Buffer,
  contentEncoding: 'gzip' | null,
  packAt: number,
  /** Asks GitHub whether `newId`, a commit it already has, comes after `oldId`. Not asked for a tip the push carries itself. */
  onGitHub: (oldId: string, newId: string) => Promise<boolean>,
): Promise<string | null> {
  const existing = updates.filter((update) => !ZERO_ID.test(update.oldId) && update.oldId !== update.newId);
  if (existing.length === 0) return null;
  const why = (ref: string, what: string) => `${what} (${ref}). Bricks add to a branch, they never overwrite one: push to a new branch instead.`;
  // The commands were read from the start of the body; the pack comes after them, in the same body unzipped
  const whole = contentEncoding === 'gzip' ? await unzipStart(body, VERIFY_MAX_BYTES + 1) : body;
  if (!whole || whole.length > VERIFY_MAX_BYTES) return why(existing[0].ref, 'This push is too big to check against the branch');
  const commits = readPackCommits(whole.subarray(packAt));
  if (!commits) return why(existing[0].ref, 'The history of this push could not be read');
  for (const update of existing) {
    // A tip the push carries is followed through the commits it carries. A tip GitHub has already (a branch pushed earlier, now
    // being moved up to) is asked of GitHub, which knows its history
    let proved: boolean;
    if (!commits.has(update.newId)) {
      proved = await onGitHub(update.oldId, update.newId);
    } else {
      const walked = buildsOn(commits, update.oldId, update.newId);
      proved = walked === true;
      // The new commits may stand on a commit GitHub already has on another branch (git leaves it out of the pack): then GitHub says
      // whether that commit comes after the branch as it is. A few are asked, never a crowd
      if (Array.isArray(walked)) for (const parent of walked.slice(0, 5)) if (!proved && (await onGitHub(update.oldId, parent))) proved = true;
    }
    if (!proved) return why(update.ref, 'This push does not build on the branch as it is, so it would overwrite it');
  }
  return null;
}

/** Whether GitHub says `newId` comes after `oldId` (ahead of it, or the same): GitHub's compare. Anything else, or no answer, is no. */
async function commitFollows(repo: string, oldId: string, newId: string, token: string, fetchImpl: FetchLike): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(oldId) || !/^[0-9a-f]{40}$/.test(newId)) return false;
  try {
    const answer = await fetchImpl(`https://api.github.com/repos/${repo}/compare/${oldId}...${newId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'BAWES-Universe-Orbit', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (!answer.ok) return false;
    const body = (await answer.json()) as { status?: unknown };
    return body.status === 'ahead' || body.status === 'identical';
  } catch {
    return false;
  }
}

export type RelayOutcome =
  | { status: 'pass'; response: Response }
  | { status: 'refused'; message: string; response: Response }
  | { status: 'reconnect' | 'unavailable' | 'too_big' | 'bad_request' | 'revoked' };

/** What a computer that may only read is told when it tries to push. */
export const READ_ONLY_MESSAGE = 'This computer may only read from GitHub for this job (the job is only to look), so pushing is not allowed.';

/**
 * The answer git shows as "remote error: …" to a clone, fetch or push that is not allowed before it starts: git's own advertisement for
 * the service, with an error line in place of the branches.
 */
function refusedAdvertisement(service: 'git-upload-pack' | 'git-receive-pack', message: string): Response {
  const line = message.replace(/[\r\n]+/g, ' ');
  const text = (value: string) => {
    const data = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
  };
  const body = Buffer.concat([text(`# service=${service}\n`), Buffer.from('0000', 'ascii'), text(`ERR ${line}\n`)]);
  return new Response(new Uint8Array(body), { status: 200, headers: { 'Content-Type': `application/x-${service}-advertisement`, 'Cache-Control': 'no-cache' } });
}

const refusedPost = (message: string): Response => new Response(`${message}\n`, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** Why this pass may not push at all now, or null: a job that may only read, or Commit files not Right away for the Brick. */
const pushStop = (pass: GitPass): string | null => (pass.readOnly ? READ_ONLY_MESSAGE : pass.stops.push);

/** A push that makes a branch that was not there needs Make a branch too: why it may not, or null. */
const newBranchStop = (pass: GitPass, updates: RefUpdate[]): string | null => (updates.some((update) => ZERO_ID.test(update.oldId)) ? pass.stops.branch : null);

/**
 * What a request may say about compressing its body: nothing (or "identity"), or exactly "gzip", the only thing git sends. Anything
 * else is turned down, so the relay reads a body exactly the way GitHub will: a body that one side unpacks and the other does not is
 * how a push gets past the check. `undefined` for something that is not allowed; `null` for no compression.
 */
export function readEncoding(value: string | null): 'gzip' | null | undefined {
  const coding = value?.trim().toLowerCase() ?? '';
  if (coding === '' || coding === 'identity') return null;
  return coding === 'gzip' ? 'gzip' : undefined;
}

/**
 * One git request, passed to github.com with the owner's own token. A push is read first and refused when it deletes or tags. The
 * answer is GitHub's own, streamed back as it comes.
 */
export async function relayGit(
  pass: GitPass,
  target: RelayTarget,
  input: {
    method: string;
    search: string;
    contentType: string | null;
    contentEncoding: string | null;
    gitProtocol: string | null;
    body: Buffer | null;
    /**
     * Looks at the sign-in once more (see `recheckGitKey`). Called last, right before a push is passed to GitHub, after the push was
     * read, checked and the owner's token fetched: whatever happened to the job while that took (a take-over, the end of the job,
     * GitHub taken from the Brick, a change of what it may do) is seen here. A push that is not allowed any more never goes to GitHub.
     */
    recheck?: () => Promise<GitPass | null>;
  },
  fetchImpl: FetchLike = fetch,
): Promise<RelayOutcome> {
  const encoding = readEncoding(input.contentEncoding);
  if (encoding === undefined) return { status: 'bad_request' };
  if (target.step === 'info/refs') {
    const service = new URLSearchParams(input.search).get('service');
    if (input.method !== 'GET' || !service || !SERVICES.has(service)) return { status: 'bad_request' };
    // A step the computer may not take is told as git starts it, not after it has packed everything
    const stop = service === 'git-receive-pack' ? pushStop(pass) : pass.stops.read;
    if (stop) return { status: 'refused', message: stop, response: refusedAdvertisement(service as 'git-upload-pack' | 'git-receive-pack', stop) };
  } else if (target.step === 'git-receive-pack' && pushStop(pass)) {
    const stop = pushStop(pass)!;
    return { status: 'refused', message: stop, response: refusedPost(stop) };
  } else if (target.step === 'git-upload-pack' && pass.stops.read) {
    return { status: 'refused', message: pass.stops.read, response: refusedPost(pass.stops.read) };
  } else if (input.method !== 'POST' || !input.body) {
    return { status: 'bad_request' };
  }
  let checkedPush: NonNullable<ReturnType<typeof readPushCommands>> | null = null;
  if (target.step === 'git-receive-pack' && input.body) {
    if (input.body.length > MAX_PUSH_BYTES) return { status: 'too_big' };
    const raw = encoding === 'gzip' ? await unzipStart(input.body, COMMANDS_MAX_BYTES) : input.body;
    // A push too big for git to send in one go starts with a bare flush ("0000") to check it may push at all: it changes nothing,
    // so it is passed on, and the push itself comes next and is read like any other
    if (!isProbe(raw)) {
      const read = raw ? readPushCommands(raw) : null;
      if (!read) return { status: 'bad_request' };
      const refused = refusedPush(read.updates) ?? newBranchStop(pass, read.updates);
      if (refused) return { status: 'refused', message: refused, response: rejectedPush(read.updates, refused, read.capabilities) };
      checkedPush = read;
    }
  }
  const token = await gitHubToken(pass.connectionId, fetchImpl);
  if (token.status === 'reconnect') return { status: 'reconnect' };
  if (token.status !== 'ok') return { status: 'unavailable' };
  if (checkedPush && input.body) {
    // Needs the owner's token (it may ask GitHub), so it comes after the token; nothing was sent to GitHub before it passes
    const overwrite = await refusedOverwrite(checkedPush.updates, input.body, encoding, checkedPush.packAt, (oldId, newId) =>
      commitFollows(target.repo, oldId, newId, token.token, fetchImpl),
    );
    if (overwrite) return { status: 'refused', message: overwrite, response: rejectedPush(checkedPush.updates, overwrite, checkedPush.capabilities) };
  }
  if (target.step === 'git-receive-pack' && input.recheck) {
    const fresh = await input.recheck();
    if (!fresh) return { status: 'revoked' };
    // What the Brick may do is read again too: a choice the owner changed while the push was read and checked holds for this push
    const stop = pushStop(fresh) ?? (checkedPush ? newBranchStop(fresh, checkedPush.updates) : null);
    if (stop) return { status: 'refused', message: stop, response: refusedPost(stop) };
  }

  const query = target.step === 'info/refs' ? `?service=${new URLSearchParams(input.search).get('service')}` : '';
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`x-access-token:${token.token}`).toString('base64')}`,
    'User-Agent': 'git/2 (BAWES-Universe-Orbit)',
  };
  if (input.contentType) headers['Content-Type'] = input.contentType;
  if (encoding) headers['Content-Encoding'] = encoding;
  if (input.gitProtocol) headers['Git-Protocol'] = input.gitProtocol;
  headers.Accept = target.step === 'info/refs' ? '*/*' : `application/x-${target.step}-result`;
  // GitHub must start answering in time; once it does, a long clone may take as long as it needs
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), target.step === 'git-receive-pack' ? GITHUB_PUSH_ANSWER_MS : GITHUB_ANSWER_MS);
  let upstream: Response;
  try {
    upstream = await fetchImpl(`https://github.com/${target.repo}.git/${target.step}${query}`, {
      method: input.method,
      headers,
      body: input.body ? new Uint8Array(input.body) : undefined,
      // Never followed: a redirect would carry the token to another address
      redirect: 'manual',
      signal: stop.signal,
    });
  } catch (error) {
    console.warn('[git relay] GitHub could not be reached', error);
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
  if (upstream.status === 401) {
    // GitHub refused the token itself: the owner sees Reconnect in Apps
    await gitHubTokenRefused(pass.connectionId, token.token);
    return { status: 'reconnect' };
  }
  const out = new Headers();
  for (const name of ['content-type', 'cache-control', 'expires', 'pragma']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return { status: 'pass', response: new Response(upstream.body, { status: upstream.status, headers: out }) };
}

const pkt = (text: string) => {
  const data = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
};
const FLUSH = Buffer.from('0000', 'ascii');

/**
 * The answer git expects from a push that is turned down: every ref "ng" with the reason, so the Brick reads
 * "! [remote rejected] main (Deleting is not allowed for Bricks)" instead of a bare HTTP error. Nothing reached GitHub.
 */
export function rejectedPush(updates: RefUpdate[], reason: string, capabilities: string[]): Response {
  const why = reason.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const report = Buffer.concat([pkt('unpack ok\n'), ...updates.map((update) => pkt(`ng ${update.ref} ${why}\n`)), FLUSH]);
  let body = report;
  const band = capabilities.includes('side-band-64k') ? 65515 : capabilities.includes('side-band') ? 995 : 0;
  if (band) {
    // Sent on band 1 (the data), in pieces no bigger than the band allows, then the closing flush
    const pieces: Buffer[] = [];
    for (let at = 0; at < report.length; at += band) {
      const piece = report.subarray(at, at + band);
      pieces.push(Buffer.concat([Buffer.from((piece.length + 5).toString(16).padStart(4, '0'), 'ascii'), Buffer.from([1]), piece]));
    }
    body = Buffer.concat([...pieces, FLUSH]);
  }
  return new Response(new Uint8Array(body), { status: 200, headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' } });
}
