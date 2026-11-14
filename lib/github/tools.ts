import { gitHubMessage, gitHubRequest, type FetchLike, type GitHubAnswer } from '@/lib/github/api';

/**
 * What a Brick can do on GitHub (game #2041), always as its owner with the owner's own sign-in. Served by Orbit as an app link
 * (POST /api/ready-made/link), so the token never leaves Orbit. There is no tool that deletes a repository, a branch or a tag.
 *
 * Each tool says whether it only looks (readOnlyHint) or changes something, which the Brick's four headings are suggested from.
 */

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
}

const REPO = { type: 'string', description: 'The repository as owner/name, for example BAWES-Universe/workadventure-universe' };
const NUMBER = { type: 'integer', minimum: 1 };

const look = (name: string, title: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition => ({
  name,
  title,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { title, readOnlyHint: true, openWorldHint: true },
});

const make = (name: string, title: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
  name,
  title,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { title, readOnlyHint: false, openWorldHint: true },
});

const change = (name: string, title: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
  name,
  title,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { title, readOnlyHint: false, destructiveHint: false, openWorldHint: true },
});

export const GITHUB_TOOLS: ToolDefinition[] = [
  look('github_whoami', 'Who am I on GitHub', 'The GitHub account this Brick works as (its owner).', {}),
  look('github_list_repos', 'List repositories', 'Repositories this Brick can work on, most recently changed first.', { query: { type: 'string', description: 'Only names containing this' } }),
  look('github_get_repo', 'Read a repository', 'A repository: its default branch, whether it is private, and its description.', { repo: REPO }, ['repo']),
  look('github_list_branches', 'List branches', 'The branches of a repository.', { repo: REPO }, ['repo']),
  look('github_read_file', 'Read a file', 'A file of a repository (or the list of a folder), at a branch, tag or commit.', { repo: REPO, path: { type: 'string' }, ref: { type: 'string', description: 'Branch, tag or commit; the default branch when left out' } }, ['repo', 'path']),
  look('github_list_pull_requests', 'List pull requests', 'Pull requests of a repository.', { repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['repo']),
  look('github_get_pull_request', 'Read a pull request', 'One pull request: its text, branches, whether it can be merged, and the files it changes.', { repo: REPO, number: NUMBER }, ['repo', 'number']),
  look('github_list_issues', 'List issues', 'Issues of a repository (not pull requests).', { repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'] }, labels: { type: 'string', description: 'Comma-separated label names' } }, ['repo']),
  look('github_get_issue', 'Read an issue', 'One issue or pull request conversation, with its latest comments.', { repo: REPO, number: NUMBER }, ['repo', 'number']),
  look('github_ci_status', 'Check CI', 'The checks of a branch, pull request head or commit: each job, its result and its id (for its log).', { repo: REPO, ref: { type: 'string', description: 'Branch, tag or commit' } }, ['repo', 'ref']),
  look('github_list_ci_runs', 'List CI runs', 'Recent workflow runs of a repository, with their ids (for running them again).', { repo: REPO, branch: { type: 'string' } }, ['repo']),
  look('github_ci_job_log', 'Read a CI log', 'The end of one CI job’s log (the job id comes from Check CI).', { repo: REPO, job_id: NUMBER }, ['repo', 'job_id']),
  make('github_create_repo', 'Make a repository', 'A new repository in the owner’s account, or in an organization where Universe’s GitHub app works.', { name: { type: 'string' }, owner: { type: 'string', description: 'An organization; the owner’s own account when left out' }, private: { type: 'boolean' }, description: { type: 'string' } }, ['name']),
  make('github_create_branch', 'Make a branch', 'A new branch, from another branch or commit (the default branch when left out).', { repo: REPO, branch: { type: 'string' }, from: { type: 'string' } }, ['repo', 'branch']),
  make('github_write_files', 'Commit files', 'One commit on a branch that writes (or deletes) files. Makes the branch from the default branch when it does not exist yet.', {
    repo: REPO,
    branch: { type: 'string' },
    message: { type: 'string' },
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'The whole new text of the file' }, delete: { type: 'boolean' } }, required: ['path'], additionalProperties: false },
    },
  }, ['repo', 'branch', 'message', 'files']),
  make('github_create_pull_request', 'Open a pull request', 'A pull request from a branch.', { repo: REPO, head: { type: 'string', description: 'The branch with the changes' }, base: { type: 'string', description: 'Where it goes; the default branch when left out' }, title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } }, ['repo', 'head', 'title']),
  make('github_create_issue', 'Open an issue', 'A new issue.', { repo: REPO, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, ['repo', 'title']),
  make('github_comment', 'Comment', 'A comment on an issue or pull request.', { repo: REPO, number: NUMBER, body: { type: 'string' } }, ['repo', 'number', 'body']),
  change('github_merge_pull_request', 'Merge a pull request', 'Merges a pull request.', { repo: REPO, number: NUMBER, method: { type: 'string', enum: ['merge', 'squash', 'rebase'] } }, ['repo', 'number']),
  change('github_update_issue', 'Change an issue', 'Changes an issue or pull request: its title, text, labels, or open or closed.', { repo: REPO, number: NUMBER, title: { type: 'string' }, body: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] }, labels: { type: 'array', items: { type: 'string' } } }, ['repo', 'number']),
  change('github_rerun_ci', 'Run CI again', 'Runs a workflow run again (only its failed jobs, unless all is asked).', { repo: REPO, run_id: NUMBER, all: { type: 'boolean' } }, ['repo', 'run_id']),
];

const NAMES = new Set(GITHUB_TOOLS.map((tool) => tool.name));
export const isGitHubTool = (name: string) => NAMES.has(name);

/** The most text a tool hands back: a long file or log is cut, and says so. */
const MAX_TEXT = 60_000;
const LOG_TAIL = 30_000;

export interface ToolResult {
  text: string;
  isError: boolean;
  /** GitHub refused the token itself: the person must sign in again. */
  unauthorized?: boolean;
}

class ToolError extends Error {}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

function repoPath(value: unknown): string {
  if (typeof value !== 'string' || !REPO_RE.test(value.trim())) throw new ToolError('Give the repository as owner/name.');
  const [owner, name] = value.trim().split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function text(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolError(`${field} is needed.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ToolError(`${field} must be text.`);
  return value;
}

function whole(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new ToolError(`${field} must be a whole number.`);
  return n;
}

const filePath = (path: string) =>
  path
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');

/** A ref name as it goes in a path (branch names keep their slashes). */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

const cut = (value: string, max = MAX_TEXT) => (value.length > max ? `${value.slice(0, max)}\n… (cut: ${value.length - max} more characters)` : value);

const out = (value: unknown): ToolResult => ({ text: cut(typeof value === 'string' ? value : JSON.stringify(value, null, 2)), isError: false });

/** What GitHub's refusal means, in words a Brick can pass on. */
function refusal(answer: GitHubAnswer, what: string): ToolResult {
  const message = gitHubMessage(answer);
  if (answer.status === 401) return { text: 'GitHub no longer takes this sign-in. The owner needs to reconnect GitHub in Apps.', isError: true, unauthorized: true };
  if (answer.status === 404 || answer.status === 403) {
    return {
      text: `GitHub said no to ${what} (${answer.status}: ${message}). Either it does not exist, the owner cannot do this there, or Universe's GitHub app is not added where it lives (the owner can add it under Apps, GitHub, Where it works).`,
      isError: true,
    };
  }
  return { text: `GitHub said no to ${what} (${answer.status}: ${message}).`, isError: true };
}

type Request = <T = unknown>(path: string, init?: { method?: string; body?: unknown; accept?: string }) => Promise<GitHubAnswer<T>>;

/** Runs one tool as the person whose token this is. Never throws: a failure is a result the Brick reads. */
export async function runGitHubTool(token: string, name: string, args: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<ToolResult> {
  const request: Request = (path, init) => gitHubRequest(token, path, init ?? {}, fetchImpl);
  try {
    return await run(request, name, args ?? {}, fetchImpl);
  } catch (error) {
    if (error instanceof ToolError) return { text: error.message, isError: true };
    console.error('[GitHub] Tool failed:', name, error instanceof Error ? error.message : 'unknown');
    return { text: 'GitHub could not be reached just now. Try again in a moment.', isError: true };
  }
}

async function defaultBranch(request: Request, repo: string): Promise<string> {
  const answer = await request<{ default_branch?: string }>(repo);
  if (!answer.ok || !answer.data.default_branch) throw new ToolError(refusal(answer, 'reading the repository').text);
  return answer.data.default_branch;
}

async function headOf(request: Request, repo: string, branch: string): Promise<string | null> {
  const answer = await request<{ object?: { sha?: string } }>(`${repo}/git/ref/heads/${refPath(branch)}`);
  if (answer.status === 404) return null;
  if (!answer.ok || !answer.data.object?.sha) throw new ToolError(refusal(answer, `reading branch ${branch}`).text);
  return answer.data.object.sha;
}

async function shaOf(request: Request, repo: string, ref: string): Promise<string> {
  const answer = await request<{ sha?: string }>(`${repo}/commits/${refPath(ref)}`);
  if (!answer.ok || !answer.data.sha) throw new ToolError(refusal(answer, `finding ${ref}`).text);
  return answer.data.sha;
}

async function run(request: Request, name: string, args: Record<string, unknown>, fetchImpl: FetchLike): Promise<ToolResult> {
  switch (name) {
    case 'github_whoami': {
      const answer = await request<{ login?: string; name?: string; html_url?: string }>('/user');
      return answer.ok ? out({ login: answer.data.login, name: answer.data.name, url: answer.data.html_url }) : refusal(answer, 'saying who this is');
    }
    case 'github_list_repos': {
      const query = text(args.query, 'query', false)?.toLowerCase();
      const answer = await request<{ full_name: string; private: boolean; default_branch: string; description: string | null; pushed_at: string }[]>('/user/repos?per_page=100&sort=pushed');
      if (!answer.ok) return refusal(answer, 'listing repositories');
      const rows = answer.data.filter((repo) => !query || repo.full_name.toLowerCase().includes(query));
      return out(rows.map((repo) => ({ repo: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, description: repo.description, lastPush: repo.pushed_at })));
    }
    case 'github_get_repo': {
      const answer = await request<Record<string, unknown>>(repoPath(args.repo));
      if (!answer.ok) return refusal(answer, 'reading the repository');
      const repo = answer.data;
      return out({ repo: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, description: repo.description, url: repo.html_url, openIssues: repo.open_issues_count, permissions: repo.permissions });
    }
    case 'github_list_branches': {
      const answer = await request<{ name: string; protected: boolean }[]>(`${repoPath(args.repo)}/branches?per_page=100`);
      return answer.ok ? out(answer.data.map((branch) => ({ name: branch.name, protected: branch.protected }))) : refusal(answer, 'listing branches');
    }
    case 'github_read_file': {
      const ref = text(args.ref, 'ref', false);
      const answer = await request<unknown>(`${repoPath(args.repo)}/contents/${filePath(text(args.path, 'path') as string)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      if (!answer.ok) return refusal(answer, 'reading the file');
      if (Array.isArray(answer.data)) return out((answer.data as { name: string; type: string; path: string }[]).map((entry) => ({ path: entry.path, type: entry.type })));
      const file = answer.data as { type?: string; encoding?: string; content?: string; size?: number; sha?: string };
      if (file.type !== 'file') return out({ type: file.type });
      if (file.encoding !== 'base64' || typeof file.content !== 'string') return { text: `This file is too big to read here (${file.size ?? '?'} bytes).`, isError: true };
      return out(Buffer.from(file.content, 'base64').toString('utf8'));
    }
    case 'github_list_pull_requests': {
      const state = text(args.state, 'state', false) ?? 'open';
      const answer = await request<{ number: number; title: string; state: string; draft: boolean; user: { login: string } | null; head: { ref: string }; base: { ref: string }; html_url: string; updated_at: string }[]>(
        `${repoPath(args.repo)}/pulls?state=${encodeURIComponent(state)}&per_page=50&sort=updated&direction=desc`,
      );
      if (!answer.ok) return refusal(answer, 'listing pull requests');
      return out(answer.data.map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, by: pr.user?.login, head: pr.head.ref, base: pr.base.ref, url: pr.html_url, updated: pr.updated_at })));
    }
    case 'github_get_pull_request': {
      const repo = repoPath(args.repo);
      const number = whole(args.number, 'number');
      const answer = await request<Record<string, unknown> & { head: { ref: string; sha: string }; base: { ref: string }; user: { login: string } | null }>(`${repo}/pulls/${number}`);
      if (!answer.ok) return refusal(answer, 'reading the pull request');
      const pr = answer.data;
      const files = await request<{ filename: string; status: string; additions: number; deletions: number }[]>(`${repo}/pulls/${number}/files?per_page=100`);
      return out({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        merged: pr.merged,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
        by: pr.user?.login,
        head: pr.head.ref,
        headSha: pr.head.sha,
        base: pr.base.ref,
        url: pr.html_url,
        body: pr.body,
        files: files.ok ? files.data.map((file) => ({ path: file.filename, status: file.status, added: file.additions, removed: file.deletions })) : 'not read',
      });
    }
    case 'github_list_issues': {
      const state = text(args.state, 'state', false) ?? 'open';
      const labels = text(args.labels, 'labels', false);
      const answer = await request<{ number: number; title: string; state: string; labels: { name: string }[]; user: { login: string } | null; html_url: string; pull_request?: unknown }[]>(
        `${repoPath(args.repo)}/issues?state=${encodeURIComponent(state)}&per_page=50${labels ? `&labels=${encodeURIComponent(labels)}` : ''}`,
      );
      if (!answer.ok) return refusal(answer, 'listing issues');
      return out(answer.data.filter((issue) => !issue.pull_request).map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, labels: issue.labels.map((label) => label.name), by: issue.user?.login, url: issue.html_url })));
    }
    case 'github_get_issue': {
      const repo = repoPath(args.repo);
      const number = whole(args.number, 'number');
      const answer = await request<{ number: number; title: string; state: string; body: string | null; labels: { name: string }[]; user: { login: string } | null; html_url: string; comments: number }>(`${repo}/issues/${number}`);
      if (!answer.ok) return refusal(answer, 'reading the issue');
      const issue = answer.data;
      // The latest comments (the last page)
      const page = Math.max(1, Math.ceil(issue.comments / 30));
      const comments = issue.comments ? await request<{ user: { login: string } | null; body: string; created_at: string }[]>(`${repo}/issues/${number}/comments?per_page=30&page=${page}`) : null;
      return out({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map((label) => label.name),
        by: issue.user?.login,
        url: issue.html_url,
        body: issue.body,
        comments: comments?.ok ? comments.data.map((comment) => ({ by: comment.user?.login, at: comment.created_at, body: comment.body })) : [],
      });
    }
    case 'github_ci_status': {
      const repo = repoPath(args.repo);
      const ref = refPath(text(args.ref, 'ref') as string);
      const [checks, statuses] = await Promise.all([
        request<{ check_runs?: { id: number; name: string; status: string; conclusion: string | null; html_url: string }[] }>(`${repo}/commits/${ref}/check-runs?per_page=100`),
        request<{ state?: string; statuses?: { context: string; state: string; target_url: string | null }[] }>(`${repo}/commits/${ref}/status`),
      ]);
      if (!checks.ok) return refusal(checks, 'reading CI');
      return out({
        checks: (checks.data.check_runs ?? []).map((run) => ({ jobId: run.id, name: run.name, status: run.status, result: run.conclusion, url: run.html_url })),
        statuses: statuses.ok ? (statuses.data.statuses ?? []).map((status) => ({ name: status.context, state: status.state, url: status.target_url })) : [],
        overall: statuses.ok ? statuses.data.state : undefined,
      });
    }
    case 'github_list_ci_runs': {
      const branch = text(args.branch, 'branch', false);
      const answer = await request<{ workflow_runs?: { id: number; name: string; head_branch: string; head_sha: string; status: string; conclusion: string | null; html_url: string; created_at: string }[] }>(
        `${repoPath(args.repo)}/actions/runs?per_page=20${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`,
      );
      if (!answer.ok) return refusal(answer, 'listing CI runs');
      return out((answer.data.workflow_runs ?? []).map((run) => ({ runId: run.id, name: run.name, branch: run.head_branch, sha: run.head_sha, status: run.status, result: run.conclusion, url: run.html_url, started: run.created_at })));
    }
    case 'github_ci_job_log': {
      const answer = await request(`${repoPath(args.repo)}/actions/jobs/${whole(args.job_id, 'job_id')}/logs`);
      if (answer.status !== 302 || !answer.location) return answer.ok && typeof answer.data === 'string' ? out(answer.data.slice(-LOG_TAIL)) : refusal(answer, 'reading the log');
      // The log is kept elsewhere for a minute, at an address that needs no token: fetched without one
      const location = new URL(answer.location);
      if (location.protocol !== 'https:') return { text: 'The log could not be read.', isError: true };
      const log = await fetchImpl(location.toString(), { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (!log.ok) return { text: `The log could not be read (${log.status}).`, isError: true };
      const body = await log.text();
      return { text: body.length > LOG_TAIL ? `… (only the end)\n${body.slice(-LOG_TAIL)}` : body, isError: false };
    }
    case 'github_create_repo': {
      const owner = text(args.owner, 'owner', false);
      const body = { name: text(args.name, 'name'), private: args.private === undefined ? true : args.private === true, description: text(args.description, 'description', false), auto_init: true };
      const me = owner ? await request<{ login?: string }>('/user') : null;
      const toOrg = owner && me?.data.login?.toLowerCase() !== owner.toLowerCase();
      const answer = await request<{ full_name: string; html_url: string; default_branch: string }>(toOrg ? `/orgs/${encodeURIComponent(owner as string)}/repos` : '/user/repos', { method: 'POST', body });
      if (!answer.ok) return refusal(answer, 'making the repository');
      return out({ repo: answer.data.full_name, url: answer.data.html_url, defaultBranch: answer.data.default_branch });
    }
    case 'github_create_branch': {
      const repo = repoPath(args.repo);
      const branch = text(args.branch, 'branch') as string;
      const from = text(args.from, 'from', false) ?? (await defaultBranch(request, repo));
      const sha = (await headOf(request, repo, from)) ?? (await shaOf(request, repo, from));
      const answer = await request(`${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha } });
      return answer.ok ? out({ branch, from, sha }) : refusal(answer, `making branch ${branch}`);
    }
    case 'github_write_files':
      return writeFiles(request, args);
    case 'github_create_pull_request': {
      const repo = repoPath(args.repo);
      const base = text(args.base, 'base', false) ?? (await defaultBranch(request, repo));
      const answer = await request<{ number: number; html_url: string }>(`${repo}/pulls`, {
        method: 'POST',
        body: { head: text(args.head, 'head'), base, title: text(args.title, 'title'), body: text(args.body, 'body', false), draft: args.draft === true },
      });
      return answer.ok ? out({ number: answer.data.number, url: answer.data.html_url }) : refusal(answer, 'opening the pull request');
    }
    case 'github_create_issue': {
      const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : undefined;
      const answer = await request<{ number: number; html_url: string }>(`${repoPath(args.repo)}/issues`, { method: 'POST', body: { title: text(args.title, 'title'), body: text(args.body, 'body', false), labels } });
      return answer.ok ? out({ number: answer.data.number, url: answer.data.html_url }) : refusal(answer, 'opening the issue');
    }
    case 'github_comment': {
      const answer = await request<{ html_url: string }>(`${repoPath(args.repo)}/issues/${whole(args.number, 'number')}/comments`, { method: 'POST', body: { body: text(args.body, 'body') } });
      return answer.ok ? out({ url: answer.data.html_url }) : refusal(answer, 'commenting');
    }
    case 'github_merge_pull_request': {
      const method = text(args.method, 'method', false) ?? 'merge';
      if (!['merge', 'squash', 'rebase'].includes(method)) throw new ToolError('method is merge, squash or rebase.');
      const answer = await request<{ sha?: string; merged?: boolean; message?: string }>(`${repoPath(args.repo)}/pulls/${whole(args.number, 'number')}/merge`, { method: 'PUT', body: { merge_method: method } });
      return answer.ok ? out({ merged: answer.data.merged, sha: answer.data.sha }) : refusal(answer, 'merging');
    }
    case 'github_update_issue': {
      const body: Record<string, unknown> = {};
      for (const field of ['title', 'body', 'state'] as const) if (args[field] !== undefined) body[field] = text(args[field], field);
      if (Array.isArray(args.labels)) body.labels = args.labels.filter((label): label is string => typeof label === 'string');
      if (Object.keys(body).length === 0) throw new ToolError('Say what to change: title, body, state or labels.');
      const answer = await request<{ number: number; html_url: string; state: string }>(`${repoPath(args.repo)}/issues/${whole(args.number, 'number')}`, { method: 'PATCH', body });
      return answer.ok ? out({ number: answer.data.number, state: answer.data.state, url: answer.data.html_url }) : refusal(answer, 'changing it');
    }
    case 'github_rerun_ci': {
      const answer = await request(`${repoPath(args.repo)}/actions/runs/${whole(args.run_id, 'run_id')}/${args.all === true ? 'rerun' : 'rerun-failed-jobs'}`, { method: 'POST', body: {} });
      return answer.ok ? out({ started: true }) : refusal(answer, 'running CI again');
    }
    default:
      return { text: `There is no GitHub tool called ${name}.`, isError: true };
  }
}

/** One commit that writes (or deletes) files on a branch, through GitHub's git data API. The branch is made when it is new. */
async function writeFiles(request: Request, args: Record<string, unknown>): Promise<ToolResult> {
  const repo = repoPath(args.repo);
  const branch = text(args.branch, 'branch') as string;
  const message = text(args.message, 'message') as string;
  if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 100) throw new ToolError('files is a list of 1 to 100 files.');
  const files = args.files.map((file, index) => {
    if (!file || typeof file !== 'object') throw new ToolError(`File ${index + 1} is not a file.`);
    const entry = file as { path?: unknown; content?: unknown; delete?: unknown };
    const path = text(entry.path, `files[${index}].path`) as string;
    const clean = path.replace(/^\/+/, '');
    if (!clean || clean.split('/').some((part) => part === '..' || part === '.' || part === '')) throw new ToolError(`${path} is not a file path.`);
    if (clean === '.git' || clean.startsWith('.git/')) throw new ToolError(`${path} cannot be written.`);
    if (entry.delete === true) return { path: clean, delete: true as const };
    if (typeof entry.content !== 'string') throw new ToolError(`files[${index}] needs content (or delete: true).`);
    return { path: clean, content: entry.content };
  });

  let parent = await headOf(request, repo, branch);
  let made = false;
  if (!parent) {
    parent = await headOf(request, repo, await defaultBranch(request, repo));
    if (!parent) throw new ToolError('The repository has no commits to start a branch from.');
    made = true;
  }
  const commit = await request<{ tree?: { sha?: string } }>(`${repo}/git/commits/${parent}`);
  if (!commit.ok || !commit.data.tree?.sha) return refusal(commit, 'reading the branch');

  const tree = files.map((file) =>
    'delete' in file ? { path: file.path, mode: '100644', type: 'blob', sha: null } : { path: file.path, mode: '100644', type: 'blob', content: file.content },
  );
  const newTree = await request<{ sha?: string }>(`${repo}/git/trees`, { method: 'POST', body: { base_tree: commit.data.tree.sha, tree } });
  if (!newTree.ok || !newTree.data.sha) return refusal(newTree, 'writing the files');
  const newCommit = await request<{ sha?: string; html_url?: string }>(`${repo}/git/commits`, { method: 'POST', body: { message, tree: newTree.data.sha, parents: [parent] } });
  if (!newCommit.ok || !newCommit.data.sha) return refusal(newCommit, 'making the commit');
  const moved = made
    ? await request(`${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: newCommit.data.sha } })
    : // Never forced: if someone pushed to the branch meanwhile, GitHub refuses and nothing of theirs is lost
      await request(`${repo}/git/refs/heads/${refPath(branch)}`, { method: 'PATCH', body: { sha: newCommit.data.sha, force: false } });
  if (!moved.ok) return refusal(moved, `moving branch ${branch}`);
  return out({ branch, commit: newCommit.data.sha, url: newCommit.data.html_url, newBranch: made, files: files.length });
}
