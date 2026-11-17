import { GITHUB_API } from '@/lib/github/app';

/** One answer from GitHub's API: the status, the parsed JSON (or text), and the headers that matter. */
export interface GitHubAnswer<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  /** Set when GitHub sent the person somewhere else (a log's download address). */
  location: string | null;
}

export const GITHUB_TIMEOUT_MS = 20_000;

export type FetchLike = typeof fetch;

/**
 * Calls GitHub's REST API with a token. Only ever api.github.com: the path is joined to it, never a full address from a caller, so
 * a token is never sent anywhere else. Redirects are not followed (a log download address would carry the token to another host).
 */
export async function gitHubRequest<T = unknown>(
  token: string | null,
  path: string,
  init: { method?: string; body?: unknown; accept?: string; basicAuth?: { user: string; password: string } } = {},
  fetchImpl: FetchLike = fetch,
): Promise<GitHubAnswer<T>> {
  if (!path.startsWith('/')) throw new Error('A GitHub path starts with /');
  const headers: Record<string, string> = {
    Accept: init.accept ?? 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'BAWES-Universe-Orbit',
  };
  if (init.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${init.basicAuth.user}:${init.basicAuth.password}`).toString('base64')}`;
  else if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const text = response.status === 204 ? '' : await response.text();
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, ok: response.status >= 200 && response.status < 300, data: data as T, location: response.headers.get('location') };
}

/** GitHub's own message in an error answer, short. */
export function gitHubMessage(answer: GitHubAnswer): string {
  const data = answer.data as { message?: unknown; errors?: unknown } | string | null;
  let message = typeof data === 'object' && data && typeof data.message === 'string' ? data.message : typeof data === 'string' ? data : '';
  if (typeof data === 'object' && data && Array.isArray(data.errors)) {
    const details = (data.errors as { message?: unknown; code?: unknown; field?: unknown }[])
      .map((error) => (typeof error?.message === 'string' ? error.message : [error?.field, error?.code].filter((part) => typeof part === 'string').join(' ')))
      .filter(Boolean);
    if (details.length) message = `${message}${message ? ': ' : ''}${details.join('; ')}`;
  }
  return (message || `HTTP ${answer.status}`).slice(0, 500);
}
