import { prisma } from '@/lib/db';
import { orbitBase } from '@/lib/github/app';
import { GITHUB_SOURCE, readGitHubAuth } from '@/lib/github/connection';
import { computerStops, gitHubJudgeFor, type ComputerStep } from '@/lib/github/judge';

/**
 * A running job's git login (game #2041, the computer's half). A Brick's computer has real git, and its remote is Orbit's git relay
 * (`/api/git/<owner>/<repo>.git`, see git-relay.ts). What the computer holds to sign in is a job key of scope "git" (computer-token.ts):
 * the same short-lived, revocable key kind as the model key, so the take-over fence, the end of the job and the job's lease treat it
 * exactly like it. The owner's GitHub token is never on the computer; Orbit adds it on the way to github.com.
 *
 * Who may have it, read from Orbit's own records every time (a name or id the computer sends is never authority):
 *  - the job is the OWNER's own (a job somebody else gave the owner's Brick never acts as the owner on GitHub),
 *  - the Brick is a person's own Brick (not a room's, not deleted), and its owner let it use their GitHub (the grant is on),
 *  - the GitHub connection is the owner's and signed in.
 * Which repositories: the ones the owner's GitHub connection reaches, and GitHub itself decides that. A sign-in through Universe's GitHub
 * App reaches only the repositories the owner picked when they installed the App (a user token never goes beyond the App's installs),
 * so a Brick can clone, fetch and push exactly there; a key the owner pasted reaches what that key was made for.
 * What it may do: push only when the job is one that may change things (`writes`). Each step also follows the Brick's choice for the
 * GitHub action it stands for (lib/github/judge.ts: clone and fetch are Read a file, a push is Commit files, a new branch is Make a branch,
 * open-pr is Open a pull request), and only Right away runs: a computer can't ask its owner, so Asks first stops the step as Off does,
 * with words the Brick reads. Whatever it may do, the relay still refuses deleting, tags and overwriting a branch.
 */

export interface GitAccess {
  botId: string;
  connectionId: string;
  ownerId: string;
  /** False when the computer may only read (clone, fetch): the job is only to look. */
  mayPush: boolean;
  /** Why each step may not run now (its GitHub action is not Right away for this Brick), or null when it may. */
  stops: Record<ComputerStep, string | null>;
  /** Who the commits are by: the owner's GitHub name and their GitHub no-reply address, so their own email is never written into a repo. */
  name: string;
  email: string;
}

/** The commit identity for a GitHub sign-in: the login, and the no-reply address that GitHub itself gives. */
export function committerOf(auth: { login?: string; githubId?: number }): { name: string; email: string } | null {
  if (!auth.login) return null;
  return { name: auth.login, email: auth.githubId ? `${auth.githubId}+${auth.login}@users.noreply.github.com` : `${auth.login}@users.noreply.github.com` };
}

const live = (status: string) => status === 'running' || status === 'waiting';

/** The git login this job may use, or null when it may use none (and so gets no key). */
export async function jobGitAccess(jobId: string): Promise<GitAccess | null> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true, personId: true, status: true, writes: true } });
  if (!job || !live(job.status)) return null;
  const bot = await prisma.bot.findUnique({ where: { id: job.botId }, select: { ownerId: true, roomId: true, deletedAt: true, name: true } });
  if (!bot || !bot.ownerId || bot.roomId !== null || bot.deletedAt !== null) return null;
  // Only the owner's own jobs work as the owner
  if (job.personId !== bot.ownerId) return null;
  const grant = await prisma.botMcpServer.findFirst({
    where: { botId: job.botId, enabled: true, connection: { ownerId: bot.ownerId, source: GITHUB_SOURCE } },
    include: { connection: true },
  });
  if (!grant?.connection) return null;
  const auth = readGitHubAuth(grant.connection);
  if (!auth?.accessToken) return null;
  const who = committerOf(auth);
  if (!who) return null;
  const judge = await gitHubJudgeFor(job.botId, grant.connection.id);
  if (!judge) return null;
  return { botId: job.botId, connectionId: grant.connection.id, ownerId: bot.ownerId, mayPush: job.writes, stops: computerStops(judge, bot.name), ...who };
}

/** The pieces a shell command may carry unquoted by accident: only plain characters, or nothing is written. */
const SAFE_ADDRESS = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._-]+)*$/;
// An underscore is a plain character in a shell word, and GitHub Enterprise Managed Users have one in every login (`name_shortcode`)
const SAFE_NAME = /^[A-Za-z0-9_-]{1,39}$/;
const SAFE_EMAIL = /^[0-9]*\+?[A-Za-z0-9_-]{1,39}@users\.noreply\.github\.com$/;
const SAFE_TOKEN = /^cjt_[A-Za-z0-9_-]{20,100}$/;

/** The git relay's address on this Orbit (https, no login, query or fragment), or null when Orbit has no public address to give. */
export function relayBase(): string | null {
  const base = orbitBase();
  if (!base) return null;
  const address = `${base.replace(/\/+$/, '')}/api/git`;
  return SAFE_ADDRESS.test(address) ? address : null;
}

/**
 * The shell that gives a computer its git login, run by Orbit inside the same locked step that writes the model key (so a write delayed
 * past a take-over is dropped the same way). `d` is the machine's own `$HOME/.universe` folder, already made. It writes, whole and moved
 * into place, with nothing but the machine's own user able to read them:
 *   git-token       the job key (what the credential helper hands to git)
 *   git-credential  the credential helper: git asks it for the password, it prints the key
 *   open-pr         opens a pull request for a pushed branch through Orbit (POST /api/computer/github/pull, same key)
 *   gitconfig       who commits, the relay as the way to github.com (`https://github.com/` and `git@github.com:` both go through it), the helper
 * and makes `~/.gitconfig` include that file. Nothing here is allowed to fail the key's own write: every step is best-effort.
 * Returns null when the pieces are not plain enough to put in a command.
 */
export function gitLoginCommand(token: string, base: string, who: { name: string; email: string }): string | null {
  if (!SAFE_TOKEN.test(token) || !SAFE_ADDRESS.test(base) || !SAFE_NAME.test(who.name) || !SAFE_EMAIL.test(who.email)) return null;
  const origin = new URL(base).origin;
  const pullAddress = `${origin}/api/computer/github/pull`;
  const credential = ['#!/bin/sh', '[ "$1" = get ] || exit 0', 'cat > /dev/null', 'echo username=x-universe-job', 'echo "password=$(cat "$HOME/.universe/git-token")"', ''].join('\n');
  // `open-pr`: opens the pull request for a pushed branch through Orbit (the owner's GitHub token stays in Orbit). Python is in the image.
  // Written with double quotes only: the whole file sits inside single quotes in the command.
  const openPr = [
    '#!/usr/bin/env python3',
    '# Usage: python3 ~/.universe/open-pr OWNER/REPO BRANCH "Title" ["Body"] ["BASE-BRANCH"]',
    'import base64, json, os, sys, urllib.error, urllib.request',
    'if len(sys.argv) < 4:',
    '    sys.exit("Usage: open-pr OWNER/REPO BRANCH TITLE [BODY] [BASE-BRANCH]")',
    'repo, head, title = sys.argv[1:4]',
    'payload = {"repo": repo, "head": head, "title": title}',
    'if len(sys.argv) > 4 and sys.argv[4]:',
    '    payload["body"] = sys.argv[4]',
    'if len(sys.argv) > 5 and sys.argv[5]:',
    '    payload["base"] = sys.argv[5]',
    'token = open(os.path.expanduser("~/.universe/git-token")).read().strip()',
    'login = base64.b64encode(("x-universe-job:" + token).encode()).decode()',
    `request = urllib.request.Request("${pullAddress}", data=json.dumps(payload).encode(), method="POST", headers={"Authorization": "Basic " + login, "Content-Type": "application/json"})`,
    'try:',
    '    answer = json.load(urllib.request.urlopen(request, timeout=60))',
    'except urllib.error.HTTPError as error:',
    '    try:',
    '        answer = json.load(error)',
    '    except Exception:',
    '        answer = {"error": "Orbit answered " + str(error.code)}',
    'except Exception:',
    '    sys.exit("Orbit could not be reached just now. Try again in a minute.")',
    'if answer.get("ok"):',
    '    print(answer.get("url"))',
    'else:',
    '    sys.exit("Pull request not opened: " + str(answer.get("error")))',
    '',
  ].join('\n');
  const config = [
    '[user]',
    `    name = ${who.name}`,
    `    email = ${who.email}`,
    `[url "${base}/"]`,
    '    insteadOf = https://github.com/',
    '    insteadOf = git@github.com:',
    `[credential "${origin}"]`,
    '    helper = !sh "$HOME/.universe/git-credential"',
    '',
  ].join('\n');
  // Every value above passed a plain-characters check, and none holds a single quote, so single quotes carry them whole
  return (
    `{ printf '%s' '${token}' > "$d/git-token.new" && mv "$d/git-token.new" "$d/git-token" && ` +
    `printf '%s' '${credential}' > "$d/git-credential.new" && mv "$d/git-credential.new" "$d/git-credential" && ` +
    `printf '%s' '${openPr}' > "$d/open-pr.new" && chmod 700 "$d/open-pr.new" && mv "$d/open-pr.new" "$d/open-pr" && ` +
    `printf '%s' '${config}' > "$d/gitconfig.new" && mv "$d/gitconfig.new" "$d/gitconfig" && ` +
    `{ git config --global --get-all include.path 2>/dev/null | grep -qxF "$d/gitconfig" || git config --global --add include.path "$d/gitconfig"; }; } >/dev/null 2>&1 || true`
  );
}

/** No git login for this job: whatever an earlier job left is removed (the key is already revoked, this is tidiness). Best-effort. */
export const NO_GIT_COMMAND = `rm -f "$d/git-token" "$d/git-credential" "$d/gitconfig" "$d/open-pr" >/dev/null 2>&1 || true`;
