import type { ReadyMadeTestResult } from '@/lib/app-adapter/ready-made';
import type { FetchLike } from '@/lib/github/api';
import { gitHubRequest } from '@/lib/github/api';
import { gitHubToken, gitHubTokenRefused } from '@/lib/github/connection';
import { GITHUB_TOOLS } from '@/lib/github/tools';

/** The same shape as any app's test result, so the Test button reads it the same way. */
export type GitHubTestResult = ReadyMadeTestResult;

/** "Test" on a Brick's GitHub, and the list of what it can do: the person's sign-in is asked who it is, with their own token. */
export async function testGitHub(connectionId: string, fetchImpl: FetchLike = fetch): Promise<GitHubTestResult> {
  const failed = (error: string, status: number | null = null): GitHubTestResult => ({ success: false, toolCount: 0, toolNames: [], error, status });
  const token = await gitHubToken(connectionId, fetchImpl);
  if (token.status === 'reconnect') return failed(`Reconnect required: ${token.reason}`);
  if (token.status !== 'ok') return failed('GitHub could not be reached just now.');
  try {
    const me = await gitHubRequest(token.token, '/user', {}, fetchImpl);
    if (me.status === 401) {
      await gitHubTokenRefused(connectionId, token.token);
      return failed('Reconnect required: GitHub asked for a new sign-in', 401);
    }
    if (!me.ok) return failed(`GitHub answered ${me.status}.`, me.status);
  } catch {
    return failed('GitHub could not be reached just now.');
  }
  return { success: true, toolCount: GITHUB_TOOLS.length, toolNames: GITHUB_TOOLS.map((tool) => tool.name) };
}
