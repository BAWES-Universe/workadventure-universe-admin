/**
 * A GitHub tool call sent twice runs once (game #2041), but a call that never ran because GitHub could not be reached may be sent again.
 * "Once" is kept in the meter (a database row), so it holds across Orbit servers and restarts.
 */
const written = new Set<string>();
jest.mock('@/lib/meter', () => ({
  recordMeterEvent: jest.fn(async (event: { eventId: string }) => {
    const recorded = !written.has(event.eventId);
    written.add(event.eventId);
    return { recorded, conflict: false };
  }),
}));
jest.mock('@/lib/db', () => ({
  prisma: {
    appConnection: { findFirst: jest.fn(async () => ({ id: 'c' })) },
    bot: { findUnique: jest.fn(async () => ({ roomId: null, ownerId: 'o' })) },
  },
}));
jest.mock('@/lib/github/connection', () => ({
  GITHUB_SOURCE: 'github',
  gitHubToken: jest.fn(),
  gitHubTokenRefused: jest.fn(),
}));

import { gitHubToken, gitHubTokenRefused } from '@/lib/github/connection';
import { recordMeterEvent } from '@/lib/meter';
import { linkGitHub } from '@/lib/github/link';

const call = (callId: string, fetchImpl: typeof fetch) =>
  linkGitHub(
    { botId: 'b', connectionId: 'c', ownerId: 'o', callId, message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'github_read_file', arguments: { repo: 'acme/tools', path: 'README.md' } } } },
    fetchImpl,
  );

describe('a GitHub tool call', () => {
  beforeEach(() => written.clear());

  it('may be sent again when GitHub could not be reached for a token, and runs once after that', async () => {
    const github = jest.fn(async () => new Response(JSON.stringify({ content: Buffer.from('hi').toString('base64'), encoding: 'base64', size: 2 }), { status: 200 })) as unknown as typeof fetch;
    jest.mocked(gitHubToken).mockResolvedValueOnce({ status: 'unavailable' });
    expect(await call('call-1', github)).toEqual({ status: 'unavailable' });
    jest.mocked(gitHubToken).mockResolvedValue({ status: 'ok', token: 'ghu_x', login: 'sara' });
    expect((await call('call-1', github)).status).toBe('done');
    expect(await call('call-1', github)).toEqual({ status: 'already_asked' });
    expect(github).toHaveBeenCalledTimes(1);
    // Written as no use and no money, paid by the person, and not on the route Composio's calls are counted by
    expect(recordMeterEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'github:b:call-1', kind: 'app_use', route: 'github', quantity: 0, costMicros: 0, payerKind: 'person', payerPersonId: 'o' }),
    );
  });

  it('keeps nothing while the owner must sign in again, so the same call works once they have', async () => {
    const github = jest.fn(async () => new Response(JSON.stringify({ content: Buffer.from('hi').toString('base64'), encoding: 'base64', size: 2 }), { status: 200 })) as unknown as typeof fetch;
    jest.mocked(gitHubToken).mockResolvedValueOnce({ status: 'reconnect', reason: 'GitHub asked for a new sign-in' });
    const asked = await call('call-2', github);
    expect(asked.status).toBe('done');
    expect(JSON.stringify(asked)).toContain('sign in again');
    expect(written.has('github:b:call-2')).toBe(false);
    jest.mocked(gitHubToken).mockResolvedValue({ status: 'ok', token: 'ghu_x', login: 'sara' });
    expect((await call('call-2', github)).status).toBe('done');
    expect(github).toHaveBeenCalledTimes(1);
  });

  it('clears only the token GitHub turned down', async () => {
    const github = jest.fn(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as unknown as typeof fetch;
    jest.mocked(gitHubToken).mockResolvedValue({ status: 'ok', token: 'ghu_old', login: 'sara' });
    await call('call-3', github);
    expect(gitHubTokenRefused).toHaveBeenCalledWith('c', 'ghu_old');
  });
});
