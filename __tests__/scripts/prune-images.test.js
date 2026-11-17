import * as lib from '@/scripts/prune-images.mjs';

// The test bodies. Shared by both repos: Orbit runs them under jest, the game repo under `node --test`.
import assert from 'node:assert/strict';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
let nextId = 1;

/** A version of a package, `ageDays` old. */
const version = (tags, ageDays, name) => ({
  id: nextId++,
  name: name ?? `sha256:${String(nextId).padStart(64, '0')}`,
  created_at: new Date(NOW - ageDays * DAY).toISOString(),
  metadata: { container: { tags } },
});

const idsOf = (items) => items.map(({ version: v }) => v.id).sort((a, b) => a - b);

export function defineTests({ lib }) {
  const { classifyTag, lineageOf, planTagged, planUntagged, prunePackage, sanitizeBranch, tagRules, DEFAULT_KEEP, OPEN_PR_KEEP } = lib;
  const orbit = tagRules({ prodBranch: 'main', devBranch: 'develop' });
  const game = tagRules({ prodBranch: 'universe', devBranch: 'universe-develop' });
  const plan = (versions, extra = {}) => planTagged({ versions, rules: orbit, now: NOW, ...extra });

  describe('classifyTag', () => {
    it('knows Orbit release tags', () => {
      for (const tag of ['latest', 'main', 'sha-1a2b3c4', '0.3.44', '0.3', 'v0.3.44', 'main-1a2b3c4']) {
        assert.equal(classifyTag(tag, orbit).kind, 'release', tag);
      }
    });
    it('knows game release tags, and that universe-develop is not one', () => {
      for (const tag of ['latest', 'universe', 'universe-752de31', 'v0.4.3']) assert.equal(classifyTag(tag, game).kind, 'release', tag);
      assert.equal(classifyTag('universe-develop', game).kind, 'moving');
      assert.equal(classifyTag('universe-develop-07b6ca1', game).kind, 'dev');
      assert.equal(classifyTag('universe-develop-07b6ca1', game).lineage, 'universe-develop');
    });
    it('puts a branch build under its branch', () => {
      assert.deepEqual(classifyTag('claude-project-thread-4y14p9-abc1234', orbit), { kind: 'dev', lineage: 'claude-project-thread-4y14p9' });
      assert.deepEqual(classifyTag('claude-project-thread-4y14p9', orbit), { kind: 'dev', lineage: 'claude-project-thread-4y14p9' });
      assert.deepEqual(classifyTag('develop-abc1234', orbit), { kind: 'dev', lineage: 'develop' });
    });
    it('keeps a branch named like a sha tag apart from the branch it resembles', () => {
      // `issue-1234567` the branch: its build is tagged `issue-1234567` and `issue-1234567-<sha>` together
      assert.equal(lineageOf(['issue-1234567', 'issue-1234567-abcdef0'], orbit), 'issue-1234567');
      assert.equal(lineageOf(['issue-1234567-abcdef0'], orbit), 'issue-1234567');
      // `issue`'s own build `issue-1234567` has no longer sibling
      assert.equal(lineageOf(['issue-1234567'], orbit), 'issue');
      assert.equal(lineageOf(['issue', 'issue-1234567'], orbit), 'issue');
    });
    it('clears the right branch when two branches look alike', () => {
      const lookalike = version(['issue-1234567', 'issue-1234567-abcdef0'], 0);
      const plain = version(['issue-7654321'], 0);
      const result = plan([lookalike, plain], { closedBranch: 'issue' });
      assert.deepEqual(idsOf(result.remove), [plain.id]);
    });
    it('tags a branch the way the dev server does', () => {
      assert.equal(sanitizeBranch('claude/project-thread-4y14p9'), 'claude-project-thread-4y14p9');
    });
  });

  describe('planTagged', () => {
    it('keeps every release, the current dev build and the newest 10 dev builds, and removes the older ones', () => {
      const releases = [version(['latest', 'main', 'sha-aaaaaaa', '0.3.44'], 30), version(['sha-bbbbbbb', '0.3.43'], 60)];
      const current = version(['develop', 'develop-ccccccc'], 0);
      const devs = Array.from({ length: 14 }, (_, index) => version([`develop-d${String(index).padStart(6, '0')}`], 3 + index));
      const result = plan([...releases, current, ...devs]);
      assert.equal(DEFAULT_KEEP, 10);
      // the 10 newest of the 14 old dev builds stay (the current build is separate), the 4 oldest go
      assert.deepEqual(idsOf(result.remove), idsOf(devs.slice(10).map((v) => ({ version: v }))));
      assert.ok(result.remove.every((item) => item.reason === 'older dev build'));
      for (const keep of [...releases, current]) assert.ok(!result.remove.some((item) => item.version.id === keep.id));
    });

    it('never removes a version that carries a release tag next to a dev tag', () => {
      const mixed = version(['develop-1111111', 'sha-1111111'], 90);
      assert.equal(plan([mixed]).remove.length, 0);
    });

    it('keeps the build dev runs now, however old', () => {
      const old = version(['develop-1111111'], 90);
      const newer = Array.from({ length: 12 }, (_, index) => version([`develop-2${String(index).padStart(6, '0')}`], 3 + index));
      const result = plan([old, ...newer, version(['develop'], 0)], { running: new Set(['develop-1111111']) });
      assert.ok(!result.remove.some((item) => item.version.id === old.id));
      assert.ok(result.kept.some((item) => item.version.id === old.id && item.reason === 'dev runs it now'));
    });

    it('removes the images of a branch with no open PR once they are two days old, and keeps a few for one with an open PR', () => {
      const closedOld = version(['fix-a-1111111', 'fix-a'], 5);
      const closedYoung = version(['fix-a-2222222'], 0.5);
      const openBranch = Array.from({ length: 5 }, (_, index) => version([`feature-b-${index}000000`], index + 1));
      const result = plan([closedOld, closedYoung, ...openBranch], { openBranches: new Set(['feature-b']) });
      assert.deepEqual(idsOf(result.remove), [closedOld.id, ...openBranch.slice(OPEN_PR_KEEP).map((v) => v.id)].sort((a, b) => a - b));
      assert.ok(result.kept.some((item) => item.version.id === closedYoung.id && /younger/.test(item.reason)));
    });

    it('clears just the closed PR branch at once, whatever the age, and leaves everything else to the weekly run', () => {
      const closing = [version(['fix-a', 'fix-a-1111111'], 0), version(['fix-a-2222222'], 0.1)];
      const other = version(['fix-z-2222222'], 20);
      const oldDev = Array.from({ length: 12 }, (_, index) => version([`develop-3${String(index).padStart(6, '0')}`], 3 + index));
      const result = plan([...closing, other, ...oldDev], { closedBranch: 'fix/a' });
      assert.deepEqual(idsOf(result.remove), idsOf(closing.map((v) => ({ version: v }))));
      assert.ok(result.remove.every((item) => item.reason === 'its PR is closed'));
    });

    it('does not clear the image dev runs when its PR closes before dev has switched back', () => {
      const closing = [version(['fix-a', 'fix-a-1111111'], 0)];
      const result = plan(closing, { closedBranch: 'fix-a', running: new Set(['fix-a-1111111']) });
      assert.equal(result.remove.length, 0);
    });

    it('refuses a closed PR that comes from the dev or production branch (a release PR)', () => {
      for (const branch of ['develop', 'main', 'master']) {
        assert.throws(() => plan([version(['develop-1111111'], 5)], { closedBranch: branch }), /Refusing/);
      }
      assert.throws(() => planTagged({ versions: [], rules: game, closedBranch: 'universe-develop', now: NOW }), /Refusing/);
      assert.throws(() => planTagged({ versions: [], rules: game, closedBranch: 'universe', now: NOW }), /Refusing/);
    });
  });

  describe('planUntagged', () => {
    it('removes an old untagged version nothing points to, and keeps the rest', () => {
      const child = version([], 30, 'sha256:child');
      const orphan = version([], 30, 'sha256:orphan');
      const fresh = version([], 0.2, 'sha256:fresh');
      const tagged = version(['latest'], 1);
      const result = planUntagged({ versions: [child, orphan, fresh, tagged], referenced: new Set(['sha256:child']), now: NOW });
      assert.deepEqual(idsOf(result.remove), [orphan.id]);
    });
  });

  describe('prunePackage', () => {
    const makeApi = (versions, { children = {}, running = [], open = [], failChildren = false } = {}) => {
      const deleted = [];
      return {
        deleted,
        listVersions: async () => versions,
        openBranches: async () => new Set(open),
        runningTags: async () => new Set(running),
        children: async (v) => {
          if (failChildren) throw new Error('registry down');
          return children[v.name] ?? [];
        },
        deleteVersion: async (v) => deleted.push(v.id),
      };
    };
    const quiet = () => {};

    it('lists what it would delete on a dry run and deletes nothing', async () => {
      const latest = version(['latest', 'main'], 3, 'sha256:latest');
      const old = version(['develop-1111111'], 40);
      const current = version(['develop', 'develop-2222222'], 0);
      const newer = version(['develop-3333333'], 5);
      const api = makeApi([latest, old, current, newer]);
      const logged = [];
      const result = await prunePackage({ api, rules: orbit, packageName: 'x', keep: 1, live: false, now: NOW, log: (line) => logged.push(line) });
      assert.deepEqual(api.deleted, []);
      assert.equal(result.remove.length, 1);
      assert.ok(logged.some((line) => line.includes(String(old.id)) && line.includes('develop-1111111')));
      assert.ok(logged.some((line) => /dry run/.test(line)));
    });

    it('deletes exactly the planned versions when live, orphaned children included', async () => {
      const latest = version(['latest'], 3, 'sha256:latest');
      const kid = version([], 40, 'sha256:kid');
      const orphan = version([], 40, 'sha256:orphan');
      const oldA = version(['develop-1111111'], 40);
      const oldB = version(['develop-2222222'], 41);
      const newest = version(['develop-3333333'], 5);
      const api = makeApi([latest, kid, orphan, oldA, oldB, newest], { children: { 'sha256:latest': ['sha256:kid'] } });
      await prunePackage({ api, rules: orbit, packageName: 'x', keep: 1, live: true, now: NOW, log: quiet });
      assert.deepEqual(api.deleted.sort((a, b) => a - b), [orphan.id, oldA.id, oldB.id].sort((a, b) => a - b));
    });

    it('leaves untagged versions alone when a kept image cannot be read', async () => {
      const latest = version(['latest'], 3, 'sha256:latest');
      const orphan = version([], 40, 'sha256:orphan');
      const old = version(['develop-1111111'], 40);
      const api = makeApi([latest, orphan, old, version(['develop-3333333'], 5)], { failChildren: true });
      await prunePackage({ api, rules: orbit, packageName: 'x', keep: 1, live: true, now: NOW, log: quiet });
      assert.deepEqual(api.deleted, [old.id]);
    });

    it('deletes nothing when no tag looks like a release or the current dev build', async () => {
      const api = makeApi([version(['weird-1'], 40), version(['weird-2'], 41)]);
      await assert.rejects(prunePackage({ api, rules: orbit, packageName: 'x', live: true, now: NOW, log: quiet }), /Nothing was deleted/);
      assert.deepEqual(api.deleted, []);
    });

    it('on a closed PR clears only that branch and does not ask the registry', async () => {
      const latest = version(['latest'], 3);
      const closing = version(['fix-a-1111111'], 0);
      const orphan = version([], 40, 'sha256:orphan');
      const api = makeApi([latest, closing, orphan], { failChildren: true });
      await prunePackage({ api, rules: orbit, packageName: 'x', live: true, closedBranch: 'fix/a', now: NOW, log: quiet });
      assert.deepEqual(api.deleted, [closing.id]);
    });
  });
}

defineTests({ lib });
