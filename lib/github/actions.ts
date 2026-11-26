import type { Heading, Setting } from '@/lib/mcp-tool-policy';
import { GITHUB_TOOLS } from '@/lib/github/tools';

/**
 * Universe's own GitHub (game #2041) as an App's actions on a Brick (Orbit #1042, lib/app-actions): each GitHub tool is one action, sorted
 * here under one of the four headings, so a Brick's GitHub gets the same Right away, Asks first or Off per heading and per action as any
 * App. The list is Universe's own, kept in the same tables as an App's list under its own key (GITHUB_ACTIONS_KEY, never a provider's
 * App name), so a person's older GitHub through the provider keeps its own list.
 *
 * Sorted by the agreed rule (the approved per-action mock, 26 Nov 2026): what only looks is Looks things up; everything GitHub makes or
 * changes can be seen by others, so it is Changes things (Makes new things is only for what stays private, like a draft). Nothing
 * deletes or sends out: there is no tool that deletes a repository, a branch or a tag.
 *
 * Every heading of a Brick's GitHub starts on Right away (it works as its owner says in chat, game #2041). One action starts on its own
 * choice instead: Run a workflow asks first, since a deploy is hard to take back (Khalid, 26 Nov 2026). A person can change either.
 */

/** The key Universe's GitHub list is kept under (`app_actions.toolkit`): a provider's App names never hold a colon. */
export const GITHUB_ACTIONS_KEY = 'universe:github';

export interface OwnAction {
  slug: string;
  /** Plain words for people, as the Brick's screen shows them. */
  title: string;
  /** One short line under the title. */
  description: string;
  heading: Heading;
  /** The action's own choice when a Brick first gets it, over its heading's. */
  startsOn?: Setting;
}

const WORDS: Readonly<Record<string, string>> = {
  github_whoami: 'The GitHub account your Brick works as',
  github_list_repos: 'Repositories your Brick can work on',
  github_get_repo: 'Its default branch, whether it is private, its description',
  github_list_branches: 'The branches of a repository',
  github_read_file: 'A file or a folder of a repository',
  github_list_pull_requests: 'Pull requests of a repository',
  github_get_pull_request: 'Its text, branches and the files it changes',
  github_list_issues: 'Issues of a repository',
  github_get_issue: 'One issue or pull request, with its latest comments',
  github_ci_status: 'The checks of a branch, pull request or commit',
  github_list_ci_runs: 'Recent workflow runs of a repository',
  github_ci_job_log: 'The end of one CI job’s log',
  github_create_repo: 'A new repository in your account, private unless asked',
  github_create_branch: 'A new branch, from another branch or commit',
  github_write_files: 'One commit on a branch that writes or deletes files',
  github_create_pull_request: 'A pull request from a branch, draft or ready',
  github_create_issue: 'A new issue',
  github_comment: 'A comment on an issue or pull request',
  github_merge_pull_request: 'Merges a pull request',
  github_update_issue: 'Its title, text, labels, or open or closed',
  github_rerun_ci: 'Runs a workflow run again',
  github_run_workflow: 'Starts a workflow that waits for a button press, like a deploy',
};

/** Actions that start on their own choice. */
const STARTS_ON: Readonly<Record<string, Setting>> = { github_run_workflow: 'asksFirst' };

/** Every GitHub action in the tools' order, sorted by Universe. */
export const GITHUB_ACTIONS: readonly OwnAction[] = GITHUB_TOOLS.map((tool) => ({
  slug: tool.name,
  title: tool.title,
  description: WORDS[tool.name] ?? tool.description,
  heading: tool.annotations.readOnlyHint ? 'looksUp' : 'changesThings',
  ...(STARTS_ON[tool.name] ? { startsOn: STARTS_ON[tool.name] } : {}),
}));

/** Universe's own lists of actions, by key: only GitHub today. Null for a provider's App (its list comes from the provider). */
export function ownActionList(key: string): readonly OwnAction[] | null {
  return key.toLowerCase() === GITHUB_ACTIONS_KEY ? GITHUB_ACTIONS : null;
}

/** The choice an action of an own list starts on, or null when it follows its heading. */
export function startsOn(key: string, slug: string): Setting | null {
  const wanted = slug.trim().toLowerCase();
  return ownActionList(key)?.find((action) => action.slug === wanted)?.startsOn ?? null;
}
