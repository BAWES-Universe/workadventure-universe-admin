import { createGunzip } from 'zlib';
import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { orbitBase } from '@/lib/github/app';
import { gitHubToken, gitHubTokenRefused, GITHUB_SOURCE, readGitHubAuth } from '@/lib/github/connection';
import type { FetchLike } from '@/lib/github/api';

/**
 * The git relay (game #2041): a Brick's computer has full git, but never the owner's GitHub key. Its remote is Orbit
 * (`https://orbit…/api/git/<owner>/<repo>.git`), signed in with a job pass that lasts 15 minutes. Orbit checks the pass, puts the
 * owner's own token on the request and passes it to github.com. What a Brick may not do through it, whatever it is told: delete a
 * branch, or push a tag.
 */

/** How long a job pass lasts. A job that runs longer asks for a new one. */
export const GIT_PASS_SECONDS = 15 * 60;
/** The most a push may carry through the relay. */
export const MAX_PUSH_BYTES = 200 * 1024 * 1024;
/**
 * A push must finish uploading within this long. The pass is checked again once it has (the owner may have turned GitHub off
 * meanwhile); a pass that ran out during the upload still counts for this long after, so a big push on a slow line is not lost.
 */
export const UPLOAD_MS = 10 * 60_000;
export const UPLOAD_GRACE_SECONDS = UPLOAD_MS / 1000;
/** The most of a gzipped push that is unpacked to read its ref updates: they come first, and the rest is passed on as it was. */
const COMMANDS_MAX_BYTES = 1024 * 1024;
/** How long GitHub has to start answering a git request: a push gets longer, GitHub answers it after taking the whole pack in. */
const GITHUB_ANSWER_MS = 60_000;
const GITHUB_PUSH_ANSWER_MS = 10 * 60_000;
const ZERO_ID = /^0{40}$|^0{64}$/;

interface GitPass {
  kind: 'git-pass';
  botId: string;
  connectionId: string;
  ownerId: string;
  exp: number;
}

export type PassIssue =
  | { status: 'ok'; pass: string; expiresAt: string; remoteBase: string; name: string; email: string }
  | { status: 'no_github' | 'not_found' | 'unavailable' };

/**
 * A pass for one Brick's computer to use git as its owner, for 15 minutes. Only for a Brick its owner let use their GitHub (the
 * grant is on); the pass names that grant's connection, so taking GitHub away from the Brick stops the pass at once. Also says who
 * the commits are by: the owner's GitHub name and their GitHub no-reply address, so their own email is never written into a repo.
 */
export async function issueGitPass(botId: string): Promise<PassIssue> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true, roomId: true, deletedAt: true } });
  if (!bot || !bot.ownerId || bot.roomId !== null || bot.deletedAt !== null) return { status: 'not_found' };
  const grant = await prisma.botMcpServer.findFirst({
    where: { botId, enabled: true, connection: { ownerId: bot.ownerId, source: GITHUB_SOURCE } },
    include: { connection: true },
  });
  if (!grant?.connection) return { status: 'no_github' };
  const base = orbitBase();
  if (!base) return { status: 'unavailable' };
  const auth = readGitHubAuth(grant.connection);
  if (!auth?.accessToken || !auth.login) return { status: 'no_github' };
  const exp = Math.floor(Date.now() / 1000) + GIT_PASS_SECONDS;
  const pass: GitPass = { kind: 'git-pass', botId, connectionId: grant.connection.id, ownerId: bot.ownerId, exp };
  return {
    status: 'ok',
    pass: encryptApiKey(JSON.stringify(pass)),
    expiresAt: new Date(exp * 1000).toISOString(),
    remoteBase: `${base}/api/git`,
    name: auth.login,
    email: auth.githubId ? `${auth.githubId}+${auth.login}@users.noreply.github.com` : `${auth.login}@users.noreply.github.com`,
  };
}

/** The pass in a git request (HTTP Basic: any user name, the pass as the password), still good and still allowed, or null. */
export async function checkGitPass(authorization: string | null, graceSeconds = 0): Promise<GitPass | null> {
  if (!authorization?.startsWith('Basic ')) return null;
  let pass: GitPass;
  try {
    const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
    const secret = decoded.slice(decoded.indexOf(':') + 1);
    pass = JSON.parse(decryptApiKey(secret)) as GitPass;
  } catch {
    return null;
  }
  if (!pass || pass.kind !== 'git-pass' || typeof pass.exp !== 'number' || pass.exp + graceSeconds < Date.now() / 1000) return null;
  // Still the owner's Brick, still allowed to use this GitHub: a pass outlives none of these
  const bot = await prisma.bot.findUnique({ where: { id: pass.botId }, select: { ownerId: true, roomId: true, deletedAt: true } });
  if (!bot || bot.ownerId !== pass.ownerId || bot.roomId !== null || bot.deletedAt !== null) return null;
  const grant = await prisma.botMcpServer.findFirst({ where: { botId: pass.botId, connectionId: pass.connectionId, enabled: true }, select: { id: true } });
  return grant ? pass : null;
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
export function readPushCommands(body: Buffer): { updates: RefUpdate[]; capabilities: string[] } | null {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const length = parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) return null;
    if (length === 0) return updates.length ? { updates, capabilities } : null;
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

export type RelayOutcome =
  | { status: 'pass'; response: Response }
  | { status: 'refused'; message: string; response: Response }
  | { status: 'reconnect' | 'unavailable' | 'too_big' | 'bad_request' };

/**
 * One git request, passed to github.com with the owner's own token. A push is read first and refused when it deletes or tags. The
 * answer is GitHub's own, streamed back as it comes.
 */
export async function relayGit(
  pass: GitPass,
  target: RelayTarget,
  input: { method: string; search: string; contentType: string | null; contentEncoding: string | null; gitProtocol: string | null; body: Buffer | null },
  fetchImpl: FetchLike = fetch,
): Promise<RelayOutcome> {
  if (target.step === 'info/refs') {
    const service = new URLSearchParams(input.search).get('service');
    if (input.method !== 'GET' || !service || !SERVICES.has(service)) return { status: 'bad_request' };
  } else if (input.method !== 'POST' || !input.body) {
    return { status: 'bad_request' };
  }
  if (target.step === 'git-receive-pack' && input.body) {
    if (input.body.length > MAX_PUSH_BYTES) return { status: 'too_big' };
    const raw = input.contentEncoding === 'gzip' ? await unzipStart(input.body, COMMANDS_MAX_BYTES) : input.body;
    // A push too big for git to send in one go starts with a bare flush ("0000") to check it may push at all: it changes nothing,
    // so it is passed on, and the push itself comes next and is read like any other
    if (!isProbe(raw)) {
      const read = raw ? readPushCommands(raw) : null;
      if (!read) return { status: 'bad_request' };
      const refused = refusedPush(read.updates);
      if (refused) return { status: 'refused', message: refused, response: rejectedPush(read.updates, refused, read.capabilities) };
    }
  }
  const token = await gitHubToken(pass.connectionId, fetchImpl);
  if (token.status === 'reconnect') return { status: 'reconnect' };
  if (token.status !== 'ok') return { status: 'unavailable' };

  const query = target.step === 'info/refs' ? `?service=${new URLSearchParams(input.search).get('service')}` : '';
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`x-access-token:${token.token}`).toString('base64')}`,
    'User-Agent': 'git/2 (BAWES-Universe-Orbit)',
  };
  if (input.contentType) headers['Content-Type'] = input.contentType;
  if (input.contentEncoding) headers['Content-Encoding'] = input.contentEncoding;
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
