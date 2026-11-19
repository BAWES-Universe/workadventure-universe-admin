import crypto from 'crypto';
import { appJwt, buildManifest, installUrl, OWN_KEY_PAGE } from '@/lib/github/app';
import { GITHUB_TOOLS, runGitHubTool } from '@/lib/github/tools';

/** A pretend GitHub: each call is matched by method and path, in order, and every call is kept to look at. */
function fakeGitHub(routes: [string, string, number, unknown, Record<string, string>?][]) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const index = routes.findIndex(([m, path]) => m === method && url.endsWith(path));
    if (index < 0) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const [, , status, body, extra] = routes.splice(index, 1)[0];
    return new Response(status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: extra });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("the form GitHub's Create page is filled in with", () => {
  const manifest = buildManifest('https://orbit.example');

  it('sends people back to Orbit and signs them in at the end of the install (one step), with no Setup URL GitHub would ignore', () => {
    expect(manifest.name).toBe('BAWES Universe');
    expect(manifest.public).toBe(true);
    expect(manifest.callback_urls).toEqual(['https://orbit.example/api/github/callback']);
    expect(manifest).not.toHaveProperty('setup_url');
    expect(manifest).not.toHaveProperty('setup_on_update');
    expect(manifest.redirect_url).toBe('https://orbit.example/api/admin/github-app/created');
    expect(manifest.request_oauth_on_install).toBe(true);
    expect(manifest.hook_attributes).toEqual({ url: 'https://orbit.example/api/github/webhook', active: true });
  });

  it('asks for what a Brick needs to work on code, and nothing about people or the organization itself', () => {
    expect(manifest.default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      workflows: 'write',
      actions: 'write',
      administration: 'write',
      checks: 'read',
      statuses: 'read',
      metadata: 'read',
    });
  });

  it('links to the install page with a state, and to a classic key page filled in', () => {
    expect(installUrl({ slug: 'bawes-universe' }, 'abc')).toBe('https://github.com/apps/bawes-universe/installations/new?state=abc');
    expect(OWN_KEY_PAGE).toBe('https://github.com/settings/tokens/new?scopes=repo,workflow,read:org&description=Universe');
  });
});

describe("the app's own short token", () => {
  it('is an RS256 token GitHub can check with the app’s public key, issued a minute early and good for under ten minutes', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const now = 1_800_000_000_000;
    const token = appJwt({ appId: 42, pem }, now);
    const [head, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '42' });
    expect(crypto.createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('what a Brick can do on GitHub', () => {
  it('says which tools only look, and has no tool that deletes a repository, a branch or a tag', () => {
    const names = GITHUB_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name) => /delete|remove|tag/.test(name))).toBe(false);
    const looks = GITHUB_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name);
    expect(looks).toEqual(expect.arrayContaining(['github_read_file', 'github_ci_status', 'github_ci_job_log', 'github_list_repos']));
    expect(looks).not.toContain('github_merge_pull_request');
    expect(GITHUB_TOOLS.find((tool) => tool.name === 'github_merge_pull_request')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('calls only api.github.com, with the person’s token', async () => {
    const github = fakeGitHub([['GET', '/user', 200, { login: 'khalid', name: 'Khalid', html_url: 'https://github.com/khalid' }]]);
    const result = await runGitHubTool('ghu_token', 'github_whoami', {}, github.impl);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ login: 'khalid', name: 'Khalid', url: 'https://github.com/khalid' });
    expect(github.calls[0].url).toBe('https://api.github.com/user');
    expect(github.calls[0].headers.Authorization).toBe('Bearer ghu_token');
  });

  it('refuses a repository that is not owner/name before asking GitHub', async () => {
    const github = fakeGitHub([]);
    const result = await runGitHubTool('t', 'github_get_repo', { repo: '../../user' }, github.impl);
    expect(result).toEqual({ text: 'Give the repository as owner/name.', isError: true, changedNothing: true });
    expect(github.calls).toHaveLength(0);
  });

  it('reads a file as text', async () => {
    const github = fakeGitHub([['GET', '/repos/o/r/contents/src/a%20b.ts?ref=dev', 200, { type: 'file', encoding: 'base64', content: Buffer.from('hello').toString('base64') }]]);
    const result = await runGitHubTool('t', 'github_read_file', { repo: 'o/r', path: '/src/a b.ts', ref: 'dev' }, github.impl);
    expect(result).toEqual({ text: 'hello', isError: false, changedNothing: true });
  });

  it('commits files in one commit on an existing branch, never forcing it', async () => {
    const github = fakeGitHub([
      ['GET', '/repos/o/r/git/ref/heads/feature/x', 200, { object: { sha: 'parent' } }],
      ['GET', '/repos/o/r/git/commits/parent', 200, { tree: { sha: 'tree0' } }],
      ['GET', '/repos/o/r/git/trees/tree0?recursive=1', 200, { tree: [{ path: 'run.sh', mode: '100755', type: 'blob' }, { path: 'a.txt', mode: '100644', type: 'blob' }] }],
      ['POST', '/repos/o/r/git/trees', 201, { sha: 'tree1' }],
      ['POST', '/repos/o/r/git/commits', 201, { sha: 'c1', html_url: 'https://github.com/o/r/commit/c1' }],
      ['PATCH', '/repos/o/r/git/refs/heads/feature/x', 200, {}],
    ]);
    const files = [
      { path: 'a.txt', content: 'A' },
      { path: 'old.txt', delete: true },
      { path: 'run.sh', content: '#!/bin/sh' },
      { path: 'new.sh', content: '#!/bin/sh', executable: true },
    ];
    const result = await runGitHubTool('t', 'github_write_files', { repo: 'o/r', branch: 'feature/x', message: 'Add', files }, github.impl);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ branch: 'feature/x', commit: 'c1', newBranch: false, files: 4 });
    // An executable that is changed stays executable; a new script is executable when asked
    expect(github.calls[3].body).toEqual({
      base_tree: 'tree0',
      tree: [
        { path: 'a.txt', mode: '100644', type: 'blob', content: 'A' },
        { path: 'old.txt', mode: '100644', type: 'blob', sha: null },
        { path: 'run.sh', mode: '100755', type: 'blob', content: '#!/bin/sh' },
        { path: 'new.sh', mode: '100755', type: 'blob', content: '#!/bin/sh' },
      ],
    });
    expect(github.calls[4].body).toEqual({ message: 'Add', tree: 'tree1', parents: ['parent'] });
    expect(github.calls[5].body).toEqual({ sha: 'c1', force: false });
  });

  it('makes the branch from the default branch when it is new', async () => {
    const github = fakeGitHub([
      ['GET', '/repos/o/r/git/ref/heads/new', 404, { message: 'Not Found' }],
      ['GET', '/repos/o/r', 200, { default_branch: 'main' }],
      ['GET', '/repos/o/r/git/ref/heads/main', 200, { object: { sha: 'm' } }],
      ['GET', '/repos/o/r/git/commits/m', 200, { tree: { sha: 't' } }],
      ['POST', '/repos/o/r/git/trees', 201, { sha: 't2' }],
      ['POST', '/repos/o/r/git/commits', 201, { sha: 'c' }],
      ['GET', '/repos/o/r/git/trees/t?recursive=1', 200, { tree: [] }],
      ['POST', '/repos/o/r/git/refs', 201, {}],
    ]);
    const result = await runGitHubTool('t', 'github_write_files', { repo: 'o/r', branch: 'new', message: 'm', files: [{ path: 'x', content: '' }] }, github.impl);
    expect(JSON.parse(result.text)).toMatchObject({ newBranch: true });
    expect(github.calls[7].body).toEqual({ ref: 'refs/heads/new', sha: 'c' });
  });

  it('never writes inside .git or outside the repository', async () => {
    for (const [path, said] of [
      ['.git/config', '.git/config cannot be written.'],
      ['a/../../b', 'a/../../b is not a file path.'],
      ['./x', './x is not a file path.'],
    ]) {
      const github = fakeGitHub([]);
      const result = await runGitHubTool('t', 'github_write_files', { repo: 'o/r', branch: 'b', message: 'm', files: [{ path, content: 'x' }] }, github.impl);
      expect(result).toEqual({ text: said, isError: true, changedNothing: true });
      // Turned down before GitHub is asked anything
      expect(github.calls).toHaveLength(0);
    }
  });

  it('keeps a script executable in a repository too big for one tree answer, reading only the folders it needs', async () => {
    const github = fakeGitHub([
      ['GET', '/repos/o/r/git/ref/heads/main', 200, { object: { sha: 'parent' } }],
      ['GET', '/repos/o/r/git/commits/parent', 200, { tree: { sha: 'root' } }],
      ['GET', '/repos/o/r/git/trees/root?recursive=1', 200, { tree: [{ path: 'README.md', mode: '100644', type: 'blob' }], truncated: true }],
      ['GET', '/repos/o/r/git/trees/root', 200, { tree: [{ path: 'bin', mode: '040000', type: 'tree', sha: 'binTree' }, { path: 'README.md', mode: '100644', type: 'blob' }] }],
      ['GET', '/repos/o/r/git/trees/binTree', 200, { tree: [{ path: 'run', mode: '100755', type: 'blob' }, { path: 'link', mode: '120000', type: 'blob' }] }],
      ['POST', '/repos/o/r/git/trees', 201, { sha: 'tree1' }],
      ['POST', '/repos/o/r/git/commits', 201, { sha: 'c1' }],
      ['PATCH', '/repos/o/r/git/refs/heads/main', 200, {}],
    ]);
    const files = [
      { path: 'bin/run', content: 'x' },
      { path: 'bin/link', content: 'target' },
      { path: 'bin/new', content: 'y' },
      { path: 'docs/new.md', content: 'z' },
    ];
    const result = await runGitHubTool('t', 'github_write_files', { repo: 'o/r', branch: 'main', message: 'm', files }, github.impl);
    expect(result.isError).toBe(false);
    const posted = github.calls.find((call) => call.method === 'POST' && call.url.endsWith('/git/trees'));
    expect((posted?.body as { tree: { path: string; mode: string }[] }).tree.map((entry) => [entry.path, entry.mode])).toEqual([
      ['bin/run', '100755'],
      ['bin/link', '120000'],
      ['bin/new', '100644'],
      ['docs/new.md', '100644'],
    ]);
    // Each folder is read once
    expect(github.calls.filter((call) => call.url.endsWith('/git/trees/binTree'))).toHaveLength(1);
  });

  it('writes nothing when it cannot tell which files are already there', async () => {
    const github = fakeGitHub([
      ['GET', '/repos/o/r/git/ref/heads/main', 200, { object: { sha: 'parent' } }],
      ['GET', '/repos/o/r/git/commits/parent', 200, { tree: { sha: 'root' } }],
      ['GET', '/repos/o/r/git/trees/root?recursive=1', 502, { message: 'Server Error' }],
    ]);
    const result = await runGitHubTool('t', 'github_write_files', { repo: 'o/r', branch: 'main', message: 'm', files: [{ path: 'run.sh', content: 'x' }] }, github.impl);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('reading the files already there');
    expect(github.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('still asks for a new sign-in when GitHub turns the token down in a step inside a tool', async () => {
    const github = fakeGitHub([['GET', '/repos/o/r/git/ref/heads/main', 401, { message: 'Bad credentials' }]]);
    const result = await runGitHubTool('t', 'github_write_files', { repo: 'o/r', branch: 'main', message: 'm', files: [{ path: 'a', content: 'x' }] }, github.impl);
    expect(result).toMatchObject({ isError: true, unauthorized: true });
  });

  it('turns down labels that are not all names, and never clears them by mistake', async () => {
    for (const tool of ['github_update_issue', 'github_create_issue']) {
      const github = fakeGitHub([]);
      const result = await runGitHubTool('t', tool, { repo: 'o/r', number: 7, title: 'T', labels: [123] }, github.impl);
      expect(result).toEqual({ text: 'labels must be a list of label names.', isError: true, changedNothing: true });
      expect(github.calls).toHaveLength(0);
    }
    // An empty list is asked for in so many words: it clears them
    const cleared = fakeGitHub([['PATCH', '/repos/o/r/issues/7', 200, { number: 7, state: 'open', html_url: 'u' }]]);
    await runGitHubTool('t', 'github_update_issue', { repo: 'o/r', number: 7, labels: [] }, cleared.impl);
    expect(cleared.calls[0].body).toEqual({ labels: [] });
  });

  it('merges with the method asked', async () => {
    const github = fakeGitHub([['PUT', '/repos/o/r/pulls/7/merge', 200, { merged: true, sha: 'abc' }]]);
    const result = await runGitHubTool('t', 'github_merge_pull_request', { repo: 'o/r', number: 7, method: 'squash' }, github.impl);
    expect(JSON.parse(result.text)).toEqual({ merged: true, sha: 'abc' });
    expect(github.calls[0].body).toEqual({ merge_method: 'squash' });
  });

  it('reads the latest 30 comments even when the last page holds only one', async () => {
    const comment = (n: number) => ({ user: { login: 's' }, body: `c${n}`, created_at: '2026-11-14T00:00:00Z' });
    const { impl, calls } = fakeGitHub([
      ['GET', '/repos/acme/tools/issues/7', 200, { number: 7, title: 't', state: 'open', body: 'b', labels: [], user: { login: 's' }, html_url: 'https://github.com/acme/tools/issues/7', comments: 31 }],
      ['GET', '/repos/acme/tools/issues/7/comments?per_page=30&page=1', 200, Array.from({ length: 30 }, (_, i) => comment(i + 1))],
      ['GET', '/repos/acme/tools/issues/7/comments?per_page=30&page=2', 200, [comment(31)]],
    ]);
    const result = await runGitHubTool('ghu_x', 'github_get_issue', { repo: 'acme/tools', number: 7 }, impl);
    const read = JSON.parse(result.text) as { comments: { body: string }[] };
    expect(read.comments).toHaveLength(30);
    expect(read.comments[0].body).toBe('c2');
    expect(read.comments[29].body).toBe('c31');
    expect(calls).toHaveLength(3);
  });

  it('clears an issue body when asked with an empty one', async () => {
    const { impl, calls } = fakeGitHub([['PATCH', '/repos/acme/tools/issues/7', 200, { number: 7, state: 'open', html_url: 'u' }]]);
    const result = await runGitHubTool('ghu_x', 'github_update_issue', { repo: 'acme/tools', number: 7, body: '' }, impl);
    expect(result.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ body: '' });
  });

  it('says plainly when GitHub no longer takes the sign-in', async () => {
    const github = fakeGitHub([['GET', '/user', 401, { message: 'Bad credentials' }]]);
    const result = await runGitHubTool('t', 'github_whoami', {}, github.impl);
    expect(result).toMatchObject({ isError: true, unauthorized: true });
  });

  it('points at Where it works when GitHub hides a repository', async () => {
    const github = fakeGitHub([['GET', '/repos/o/r', 404, { message: 'Not Found' }]]);
    const result = await runGitHubTool('t', 'github_get_repo', { repo: 'o/r' }, github.impl);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Where it works');
  });

  describe('an organization that has not allowed Universe', () => {
    it('tells the Brick to offer the card when GitHub hides a repository of an organization the app is not added on', async () => {
      const github = fakeGitHub([
        ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp', id: 4242 }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: [{ account: { login: 'BAWES-Universe' } }, { account: { login: 'khalid' } }] }],
      ]);
      const result = await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, github.impl);
      expect(result).toMatchObject({ isError: true, status: 404, orgNeedsOk: 'acme-corp', changedNothing: true });
      expect(result.text).toContain('only lets in apps its owner allows');
      expect(result.text).toContain('offer_github_owner_ok with org "acme-corp"');
    });

    it('keeps the plain refusal when the app is added on that organization, when the owner is a person, or when installs cannot be listed', async () => {
      const added = fakeGitHub([
        ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: [{ account: { login: 'ACME-Corp' } }] }],
      ]);
      expect((await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, added.impl)).orgNeedsOk).toBeUndefined();

      const person = fakeGitHub([
        ['GET', '/repos/sara/private', 404, { message: 'Not Found' }],
        ['GET', '/users/sara', 200, { type: 'User', login: 'sara' }],
      ]);
      const plain = await runGitHubTool('t', 'github_get_repo', { repo: 'sara/private' }, person.impl);
      expect(plain.orgNeedsOk).toBeUndefined();
      expect(plain.text).toContain('Where it works');

      const ownKey = fakeGitHub([
        ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/user/installations?per_page=100&page=1', 403, { message: 'You must authenticate with an access token authorized to a GitHub App' }],
      ]);
      expect((await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, ownKey.impl)).orgNeedsOk).toBeUndefined();
    });

    it('keeps the plain refusal for a missing file in a repository the person can read', async () => {
      const github = fakeGitHub([
        ['GET', '/repos/acme-corp/website/contents/nope.md', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/repos/acme-corp/website', 200, { name: 'website', private: false }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: [] }],
      ]);
      const result = await runGitHubTool('t', 'github_read_file', { repo: 'acme-corp/website', path: 'nope.md' }, github.impl);
      expect(result).toMatchObject({ isError: true, status: 404 });
      expect(result.orgNeedsOk).toBeUndefined();
      // The installations were never asked about: a readable repository is not an approval problem
      expect(github.calls.some((call) => call.url.includes('/user/installations'))).toBe(false);
    });

    it('keeps the plain refusal when GitHub cannot say whether the repository is readable (a server error, a slow-down, a 403 that may be a rate limit)', async () => {
      for (const [status, message] of [[500, 'Server Error'], [429, 'Slow down'], [403, 'API rate limit exceeded']] as const) {
        const github = fakeGitHub([
          ['GET', '/repos/acme-corp/website/contents/nope.md', 404, { message: 'Not Found' }],
          ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
          ['GET', '/repos/acme-corp/website', status, { message }],
          ['GET', '/user/installations?per_page=100&page=1', 200, { installations: [] }],
        ]);
        const result = await runGitHubTool('t', 'github_read_file', { repo: 'acme-corp/website', path: 'nope.md' }, github.impl);
        expect(result).toMatchObject({ isError: true, status: 404 });
        expect(result.orgNeedsOk).toBeUndefined();
        expect(github.calls.some((call) => call.url.includes('/user/installations'))).toBe(false);
      }
    });

    it('keeps the plain refusal when the app itself says it is added on the organization, though the person\'s own list does not show it', async () => {
      const github = fakeGitHub([
        ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: [] }],
      ]);
      const result = await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, github.impl, async () => true);
      expect(result.orgNeedsOk).toBeUndefined();
      expect(github.calls.some((call) => call.url.includes('/user/installations'))).toBe(false);
      // Not added there, or the app cannot say: the person's own list decides, as before
      for (const answer of [false, null]) {
        const again = fakeGitHub([
          ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
          ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
          ['GET', '/user/installations?per_page=100&page=1', 200, { installations: [] }],
        ]);
        expect((await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, again.impl, async () => answer)).orgNeedsOk).toBe('acme-corp');
      }
      // A check that fails is the same as one that cannot say
      const broken = fakeGitHub([
        ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: [] }],
      ]);
      expect((await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, broken.impl, async () => { throw new Error('down'); })).orgNeedsOk).toBe('acme-corp');
    });

    it('reads every page of a person\'s installations before saying the organization is missing', async () => {
      const filler = Array.from({ length: 100 }, (_, i) => ({ account: { login: `org-${i}` } }));
      const onSecond = fakeGitHub([
        ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: filler }],
        ['GET', '/user/installations?per_page=100&page=2', 200, { installations: [{ account: { login: 'acme-corp' } }] }],
      ]);
      expect((await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, onSecond.impl)).orgNeedsOk).toBeUndefined();

      const onNone = fakeGitHub([
        ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: filler }],
        ['GET', '/user/installations?per_page=100&page=2', 200, { installations: [{ account: { login: 'other' } }] }],
      ]);
      expect((await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, onNone.impl)).orgNeedsOk).toBe('acme-corp');

      // A later page that fails leaves the plain refusal
      const broken = fakeGitHub([
        ['GET', '/repos/acme-corp/website', 404, { message: 'Not Found' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: filler }],
        ['GET', '/user/installations?per_page=100&page=2', 502, { message: 'Bad gateway' }],
      ]);
      expect((await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, broken.impl)).orgNeedsOk).toBeUndefined();
    });

    it('also covers making a repository in such an organization, and never runs for a refused sign-in', async () => {
      const github = fakeGitHub([
        ['GET', '/user', 200, { login: 'khalid' }],
        ['POST', '/orgs/acme-corp/repos', 403, { message: 'Forbidden' }],
        ['GET', '/users/acme-corp', 200, { type: 'Organization', login: 'acme-corp' }],
        ['GET', '/user/installations?per_page=100&page=1', 200, { installations: [] }],
      ]);
      const result = await runGitHubTool('t', 'github_create_repo', { name: 'site', owner: 'acme-corp' }, github.impl);
      expect(result.orgNeedsOk).toBe('acme-corp');
      const refused = fakeGitHub([['GET', '/repos/acme-corp/website', 401, { message: 'Bad credentials' }]]);
      const gone = await runGitHubTool('t', 'github_get_repo', { repo: 'acme-corp/website' }, refused.impl);
      expect(gone).toMatchObject({ unauthorized: true });
      expect(refused.calls).toHaveLength(1);
    });
  });

  it('reads the end of a CI log from where GitHub keeps it, without sending the token there', async () => {
    const github = fakeGitHub([
      ['GET', '/repos/o/r/actions/jobs/9/logs', 302, '', { location: 'https://logs.example.net/job9?sig=1' }],
      ['GET', 'https://logs.example.net/job9?sig=1', 200, 'line 1\nline 2'],
    ]);
    const result = await runGitHubTool('t', 'github_ci_job_log', { repo: 'o/r', job_id: 9 }, github.impl);
    expect(result).toEqual({ text: 'line 1\nline 2', isError: false, changedNothing: true });
    expect(github.calls[1].headers.Authorization).toBeUndefined();
  });

  it('makes a repository in an organization, or in the person’s own account', async () => {
    const org = fakeGitHub([
      ['GET', '/user', 200, { login: 'khalid' }],
      ['POST', '/orgs/BAWES-Universe/repos', 201, { full_name: 'BAWES-Universe/new', html_url: 'u', default_branch: 'main' }],
    ]);
    await runGitHubTool('t', 'github_create_repo', { name: 'new', owner: 'BAWES-Universe' }, org.impl);
    expect(org.calls[1].body).toMatchObject({ name: 'new', private: true, auto_init: true });
    const mine = fakeGitHub([['POST', '/user/repos', 201, { full_name: 'khalid/new', html_url: 'u', default_branch: 'main' }]]);
    const result = await runGitHubTool('t', 'github_create_repo', { name: 'new', private: false }, mine.impl);
    expect(JSON.parse(result.text)).toMatchObject({ repo: 'khalid/new' });
    expect(mine.calls[0].body).toMatchObject({ private: false });
  });

  it('never makes a public repository from a private value that is not true or false', async () => {
    const github = fakeGitHub([]);
    for (const value of ['true', null, 1]) {
      const result = await runGitHubTool('t', 'github_create_repo', { name: 'new', private: value }, github.impl);
      expect(result).toEqual({ text: 'private must be true or false.', isError: true, changedNothing: true });
    }
    expect(github.calls).toHaveLength(0);
  });
});
