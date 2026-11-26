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
    bot: { findUnique: jest.fn(async () => ({ roomId: null, ownerId: 'o', name: 'Nudge' })) },
    meterEvent: {
      deleteMany: jest.fn(async ({ where }: { where: { eventId: string } }) => ({ count: written.delete(where.eventId) ? 1 : 0 })),
    },
  },
}));
jest.mock('@/lib/github/connection', () => ({
  GITHUB_SOURCE: 'github',
  gitHubToken: jest.fn(),
  gitHubTokenRefused: jest.fn(),
}));

/** The Brick's choice per GitHub action, as lib/github/judge.ts would give it: Right away unless named here. */
const choices = new Map<string, 'rightAway' | 'asksFirst' | 'off'>();
jest.mock('@/lib/github/judge', () => ({
  gitHubJudgeFor: jest.fn(async () => ({
    toolkit: 'universe:github',
    knows: () => true,
    judge: (slug: string) => ({
      slug,
      title: ({ github_run_workflow: 'Run a workflow', github_merge_pull_request: 'Merge a pull request', github_create_branch: 'Make a branch' } as Record<string, string>)[slug] ?? slug,
      heading: 'changesThings',
      setting: choices.get(slug) ?? 'rightAway',
    }),
  })),
}));

import { gitHubToken, gitHubTokenRefused } from '@/lib/github/connection';
import { recordMeterEvent } from '@/lib/meter';
import { linkGitHub } from '@/lib/github/link';

const READ = { name: 'github_read_file', arguments: { repo: 'acme/tools', path: 'README.md' } };
const OPEN_ISSUE = { name: 'github_create_issue', arguments: { repo: 'acme/tools', title: 'Broken' } };

const call = (callId: string, fetchImpl: typeof fetch, params: { name: string; arguments: Record<string, unknown> } = READ) =>
  linkGitHub({ botId: 'b', connectionId: 'c', ownerId: 'o', callId, message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params } }, fetchImpl);

/** GitHub answering each request in turn (the last answer repeats); a thrown error is a request that got no answer. */
const answers = (...replies: (number | Error)[]) => {
  let index = 0;
  return jest.fn(async () => {
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    const body = reply < 300 ? { number: 7, html_url: 'https://github.com/acme/tools/issues/7' } : { message: 'Validation Failed' };
    return new Response(JSON.stringify(body), { status: reply });
  }) as unknown as typeof fetch & jest.Mock;
};

describe('a GitHub tool call', () => {
  beforeEach(() => {
    written.clear();
    choices.clear();
  });

  it('may be sent again when GitHub could not be reached for a token, and runs once after that', async () => {
    const github = answers(201);
    jest.mocked(gitHubToken).mockResolvedValueOnce({ status: 'unavailable' });
    expect(await call('call-1', github, OPEN_ISSUE)).toEqual({ status: 'unavailable' });
    jest.mocked(gitHubToken).mockResolvedValue({ status: 'ok', token: 'ghu_x', login: 'sara' });
    expect((await call('call-1', github, OPEN_ISSUE)).status).toBe('done');
    expect(await call('call-1', github, OPEN_ISSUE)).toEqual({ status: 'already_asked' });
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

  describe('that failed', () => {
    beforeEach(() => jest.mocked(gitHubToken).mockResolvedValue({ status: 'ok', token: 'ghu_x', login: 'sara' }));

    it('may be asked again when GitHub turned the change down, so nothing was made', async () => {
      const github = answers(422, 201);
      const first = await call('call-4', github, OPEN_ISSUE);
      expect(JSON.stringify(first)).toContain('isError\\":true');
      expect(written.has('github:b:call-4')).toBe(false);
      const again = await call('call-4', github, OPEN_ISSUE);
      expect(JSON.stringify(again)).toContain('issues/7');
      expect(await call('call-4', github, OPEN_ISSUE)).toEqual({ status: 'already_asked' });
      expect(github).toHaveBeenCalledTimes(2);
    });

    it('is never made twice when GitHub did not answer a change, and says to check first', async () => {
      for (const [callId, reply] of [['call-5', new Error('The operation was aborted due to timeout')], ['call-6', 502]] as const) {
        const github = answers(reply, 201);
        const first = await call(callId, github, OPEN_ISSUE);
        expect(JSON.stringify(first)).toMatch(/check on GitHub before asking for it again/i);
        expect(await call(callId, github, OPEN_ISSUE)).toEqual({ status: 'already_asked' });
        expect(github).toHaveBeenCalledTimes(1);
      }
    });

    it('may always be asked again when it only looked, answered or not', async () => {
      const github = answers(new Error('socket hang up'), 500, 200);
      for (let attempt = 0; attempt < 2; attempt++) expect(JSON.stringify(await call('call-7', github))).toContain('isError\\":true');
      expect(written.has('github:b:call-7')).toBe(false);
      for (let attempt = 0; attempt < 2; attempt++) expect(JSON.stringify(await call('call-7', github))).toContain('isError\\":false');
      expect(written.has('github:b:call-7')).toBe(false);
      expect(github).toHaveBeenCalledTimes(4);
    });
  });
});

describe('what the Brick may do with each GitHub action (second guard after the gate)', () => {
  beforeEach(() => {
    written.clear();
    choices.clear();
    jest.mocked(gitHubToken).mockResolvedValue({ status: 'ok', token: 'ghu_x', login: 'sara' });
  });

  const list = () => linkGitHub({ botId: 'b', connectionId: 'c', ownerId: 'o', callId: null, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, jest.fn() as unknown as typeof fetch);
  const listed = async () => {
    const outcome = await list();
    if (outcome.status !== 'done') throw new Error(outcome.status);
    return (JSON.parse(outcome.answer.body).result.tools as { name: string }[]).map((tool) => tool.name);
  };

  it('never lists an action that is Off, and lists the rest with Run a workflow among them', async () => {
    expect(await listed()).toEqual(expect.arrayContaining(['github_run_workflow', 'github_merge_pull_request']));
    choices.set('github_merge_pull_request', 'off');
    choices.set('github_run_workflow', 'asksFirst');
    const names = await listed();
    expect(names).not.toContain('github_merge_pull_request');
    // Asks first is the gate's to ask: it stays offered
    expect(names).toContain('github_run_workflow');
  });

  it('refuses an Off action without running it or keeping the call, and says what is off', async () => {
    choices.set('github_merge_pull_request', 'off');
    const github = answers(200);
    const outcome = await call('off-1', github, { name: 'github_merge_pull_request', arguments: { repo: 'acme/tools', number: 3 } });
    expect(outcome.status).toBe('done');
    const body = JSON.parse((outcome as { answer: { body: string } }).answer.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Merge a pull request is off for Nudge in GitHub');
    expect(github).not.toHaveBeenCalled();
    expect(written.has('github:b:off-1')).toBe(false);
  });

  it('runs an action that asks first once the call comes (the gate asked)', async () => {
    choices.set('github_run_workflow', 'asksFirst');
    const github = jest.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch & jest.Mock;
    const outcome = await call('wf-1', github, { name: 'github_run_workflow', arguments: { repo: 'acme/tools', workflow: 'deploy.yml', branch: 'main' } });
    expect(outcome.status).toBe('done');
    expect(JSON.parse((outcome as { answer: { body: string } }).answer.body).result.isError).toBe(false);
    expect(github).toHaveBeenCalledWith('https://api.github.com/repos/acme/tools/actions/workflows/deploy.yml/dispatches', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ref: 'main' }) }));
    // A change: it stays asked, so it is never started twice
    expect(written.has('github:b:wf-1')).toBe(true);
  });

  describe('Commit files onto a branch that is not there (that is Make a branch)', () => {
    const commit = (callId: string, fetchImpl: typeof fetch) =>
      call(callId, fetchImpl, { name: 'github_write_files', arguments: { repo: 'acme/tools', branch: 'new-one', message: 'Add a', files: [{ path: 'a.txt', content: 'a' }] } });
    // GitHub: the branch is not there; the default branch is main at commit m
    const noBranch = () =>
      jest.fn(async (url: string) => {
        if (url.endsWith('/git/ref/heads/new-one')) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        if (url.endsWith('/repos/acme/tools')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
        if (url.endsWith('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'm' } }), { status: 200 });
        return new Response(JSON.stringify({}), { status: 500 });
      }) as unknown as typeof fetch & jest.Mock;
    const text = (outcome: Awaited<ReturnType<typeof call>>) => JSON.parse((outcome as { answer: { body: string } }).answer.body).result as { content: { text: string }[]; isError: boolean };

    it('makes nothing while Make a branch asks first, and says to use it first', async () => {
      choices.set('github_create_branch', 'asksFirst');
      const github = noBranch();
      const result = text(await commit('wb-1', github));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('making it is Make a branch, which asks first. Nothing was committed. Use Make a branch first');
      // Only the branch was looked up: no tree, commit or branch was written
      expect(github.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);
      expect(written.has('github:b:wb-1')).toBe(false);
    });

    it('says it is off when Make a branch is Off', async () => {
      choices.set('github_create_branch', 'off');
      expect(text(await commit('wb-2', noBranch())).content[0].text).toContain('which is off for Nudge in GitHub. Nothing was committed.');
    });

    it('still commits onto a branch that is there while Make a branch asks first', async () => {
      choices.set('github_create_branch', 'asksFirst');
      const github = jest.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/git/ref/heads/new-one')) return new Response(JSON.stringify({ object: { sha: 'p' } }), { status: 200 });
        if (url.endsWith('/git/commits/p')) return new Response(JSON.stringify({ tree: { sha: 't' } }), { status: 200 });
        if (url.includes('/git/trees/t')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
        if (url.endsWith('/git/trees')) return new Response(JSON.stringify({ sha: 't2' }), { status: 201 });
        if (url.endsWith('/git/commits')) return new Response(JSON.stringify({ sha: 'c2' }), { status: 201 });
        if (url.endsWith('/git/refs/heads/new-one') && init?.method === 'PATCH') return new Response(JSON.stringify({}), { status: 200 });
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }) as unknown as typeof fetch & jest.Mock;
      const result = text(await commit('wb-3', github));
      expect(result.content[0].text).not.toContain('Make a branch');
      expect(result.isError).toBe(false);
    });
  });

  describe('running a run again', () => {
    const rerun = (callId: string, fetchImpl: typeof fetch) => call(callId, fetchImpl, { name: 'github_rerun_ci', arguments: { repo: 'acme/tools', run_id: 42 } });
    const runOf = (event: string) =>
      jest.fn(async (url: string) =>
        url.endsWith('/actions/runs/42') ? new Response(JSON.stringify({ id: 42, event }), { status: 200 }) : new Response(null, { status: 201 }),
      ) as unknown as typeof fetch & jest.Mock;
    const text = (outcome: Awaited<ReturnType<typeof call>>) => JSON.parse((outcome as { answer: { body: string } }).answer.body).result.content[0].text as string;

    it('turns down a run started by hand (a deploy) while Run a workflow asks first, and points to it', async () => {
      choices.set('github_run_workflow', 'asksFirst');
      const github = runOf('workflow_dispatch');
      const outcome = await rerun('re-1', github);
      expect(text(outcome)).toContain('started by hand');
      expect(text(outcome)).toContain('Use Run a workflow');
      expect(github).toHaveBeenCalledTimes(1);
      expect(github.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'GET' }));
      // Nothing changed: the call may be asked again
      expect(written.has('github:b:re-1')).toBe(false);
    });

    it('says it is off when Run a workflow is Off', async () => {
      choices.set('github_run_workflow', 'off');
      expect(text(await rerun('re-2', runOf('workflow_dispatch')))).toContain('is off for Nudge in GitHub');
    });

    it('runs again a run started by a push, and any run while Run a workflow is Right away', async () => {
      choices.set('github_run_workflow', 'asksFirst');
      const pushed = runOf('push');
      expect(JSON.parse(((await rerun('re-3', pushed)) as { answer: { body: string } }).answer.body).result.isError).toBe(false);
      expect(pushed).toHaveBeenCalledWith('https://api.github.com/repos/acme/tools/actions/runs/42/rerun-failed-jobs', expect.objectContaining({ method: 'POST' }));
      choices.set('github_run_workflow', 'rightAway');
      const byHand = runOf('workflow_dispatch');
      expect(JSON.parse(((await rerun('re-4', byHand)) as { answer: { body: string } }).answer.body).result.isError).toBe(false);
      // Not even looked up: nothing to check
      expect(byHand).toHaveBeenCalledTimes(1);
    });

    it('does not run again a run it could not read while Run a workflow asks first', async () => {
      choices.set('github_run_workflow', 'asksFirst');
      const github = jest.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })) as unknown as typeof fetch & jest.Mock;
      expect(text(await rerun('re-5', github))).toContain('GitHub said no to reading the run');
      expect(github).toHaveBeenCalledTimes(1);
    });
  });
});
