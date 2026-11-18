// Decides which old images to delete from one GitHub container package (#741, #309-era clean-up).
//
// Nothing here talks to the network: the caller hands in the package's versions and what it knows
// about the repository, and gets back a plan. The command line wrapper (prune-images-cli.mjs) does the
// reading and the deleting, and the plan is printed before anything is deleted.
//
// What is never deleted:
//   - a release image: any version with a release tag (`latest`, the production branch and its
//     `<branch>-<sha>`, `sha-<sha>`, version numbers, the older `main-<sha>` names);
//   - the build that carries the moving dev tag (`develop` / `universe-develop`);
//   - the newest KEEP builds of the dev branch, so a dev rollback to the previous build still works;
//   - a build that dev is running right now;
//   - anything younger than MIN_AGE_DAYS (a push may still be in flight), except when a PR has just closed;
//   - a branch that is the dev branch, the production branch, main or master, even if a PR closes from it
//     (a release PR comes from the dev branch).
//
// What goes: older dev builds, the images of branches that have no open PR any more (the images a PR put
// on dev as `<branch>` and `<branch>-<sha7>`), and untagged versions that no kept image points to.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_KEEP = 10;
/** Builds kept for each branch that still has an open PR: the one under test and a couple to roll back to. */
export const OPEN_PR_KEEP = 3;
export const MIN_AGE_DAYS = 2;

/** The tag docker/metadata-action and the dev-server workflow give a branch: anything outside [A-Za-z0-9._-] becomes '-'. */
export const sanitizeBranch = (ref) => String(ref).replace(/[^A-Za-z0-9._-]+/g, '-');

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The tag rules for one repository. `prodBranch` is `main` (Orbit) or `universe` (game); `devBranch` is `develop` or `universe-develop`. */
export function tagRules({ prodBranch, devBranch }) {
  const prod = escapeRe(sanitizeBranch(prodBranch));
  const release = [
    /^latest$/,
    new RegExp(`^${prod}(-[0-9a-f]+)?$`),
    /^(main|master)(-[0-9a-f]+)?$/,
    /^sha-[0-9a-f]+$/,
    /^v?\d+(\.\d+)*$/,
    /^v\d.*$/,
  ];
  const dev = sanitizeBranch(devBranch);
  const protectedBranches = new Set([dev, sanitizeBranch(prodBranch), 'main', 'master']);
  return { release, dev, protectedBranches };
}

/** The dev, production, main and master branches: a PR closing from one of them (a release PR) never clears images. */
export const isProtectedBranch = (rules, ref) => rules.protectedBranches.has(sanitizeBranch(ref));

/**
 * What a tag is: `release`, `moving` (the dev branch's own tag), or a dev build of some branch (`lineage`).
 * `<branch>-<7+ hex>` belongs to `<branch>`; any other tag is a branch name itself.
 */
export function classifyTag(tag, rules) {
  if (rules.release.some((pattern) => pattern.test(tag))) return { kind: 'release' };
  if (tag === rules.dev) return { kind: 'moving', lineage: rules.dev };
  const sha = /^(.+)-[0-9a-f]{7,40}$/.exec(tag);
  return { kind: 'dev', lineage: sha ? sha[1] : tag };
}

/**
 * The branch a dev build belongs to. A build is tagged `<branch>` and `<branch>-<sha>` together, so a tag that has a
 * sibling extending it by a sha is the branch itself (this keeps a branch called `issue-1234567` apart from the
 * `issue` branch's build `issue-1234567`). A tag on its own is read as `<branch>-<sha>`.
 */
export function lineageOf(tags, rules) {
  const bare = tags.find((tag) => tags.some((other) => other !== tag && new RegExp(`^${escapeRe(tag)}-[0-9a-f]{7,40}$`).test(other)));
  return bare ?? classifyTag(tags[0], rules).lineage;
}

const tagsOf = (version) => version?.metadata?.container?.tags ?? [];
const createdAt = (version) => Date.parse(version.created_at);
const newestFirst = (a, b) => createdAt(b) - createdAt(a);

/**
 * Plans the clean-up of the tagged versions of one package.
 *
 * @param {object} input
 * @param {Array} input.versions        every version of the package, as GitHub lists them
 * @param {object} input.rules          from tagRules()
 * @param {number} [input.keep]         dev branch builds to keep
 * @param {Set<string>} input.openBranches  sanitized head branches of open PRs
 * @param {Set<string>} input.running   tags dev runs right now
 * @param {string} [input.closedBranch] a PR just closed from this branch: the images it built go now, whatever their age
 * @param {Set<string>} [input.closedShas] the 7-character shas of that PR's commits. Tags are made from the sanitized branch name,
 *                                         so a distinct branch like `fix-a` shares tags with `fix/a`; only an image tagged with one of
 *                                         these shas is the closing PR's own and goes at once, the rest follow the normal age rule
 * @param {number} [input.now]
 * @returns {{ remove: Array<{version: object, reason: string}>, kept: Array<{version: object, reason: string}> }}
 */
export function planTagged({ versions, rules, keep = DEFAULT_KEEP, openBranches = new Set(), running = new Set(), closedBranch, closedShas = new Set(), now = Date.now() }) {
  const closed = closedBranch === undefined ? undefined : sanitizeBranch(closedBranch);
  if (closed !== undefined && isProtectedBranch(rules, closed)) {
    throw new Error(`Refusing to clear the images of "${closedBranch}": it is the dev or production branch, not a pull request branch.`);
  }
  const kept = [];
  const remove = [];
  const candidates = new Map(); // lineage -> versions that no hard rule keeps

  for (const version of versions) {
    const tags = tagsOf(version);
    if (tags.length === 0) continue; // untagged: planUntagged()
    const kinds = tags.map((tag) => classifyTag(tag, rules));
    if (kinds.some((kind) => kind.kind === 'release')) {
      kept.push({ version, reason: 'release' });
    } else if (kinds.some((kind) => kind.kind === 'moving')) {
      kept.push({ version, reason: 'current dev build' });
    } else if (tags.some((tag) => running.has(tag))) {
      kept.push({ version, reason: 'dev runs it now' });
    } else {
      const lineage = lineageOf(tags, rules);
      if (!candidates.has(lineage)) candidates.set(lineage, []);
      candidates.get(lineage).push(version);
    }
  }

  for (const [lineage, group] of candidates) {
    group.sort(newestFirst);
    const isDevBranch = lineage === rules.dev;
    const isThisPr = closed !== undefined && lineage === closed;
    const stillOpen = openBranches.has(lineage);
    // The closed PR's branch goes at once, unless another open PR still uses the same branch: then it is an ordinary open-PR branch.
    const isClosed = isThisPr && !stillOpen;
    // The dev branch keeps its newest builds. A branch with an open PR keeps a few. Any other branch keeps nothing, once it is old enough.
    const allowed = isClosed ? 0 : isDevBranch ? keep : stillOpen ? OPEN_PR_KEEP : 0;
    if (closed !== undefined && !isThisPr) {
      // A closed PR clears only its own branch. The weekly run does the rest.
      for (const version of group) kept.push({ version, reason: 'not this PR' });
      continue;
    }
    const builtByThisPr = (version) =>
      isClosed && tagsOf(version).some((tag) => tag.startsWith(`${lineage}-`) && closedShas.has(tag.slice(lineage.length + 1)));
    group.forEach((version, index) => {
      if (index < allowed) {
        kept.push({ version, reason: isDevBranch ? `one of the newest ${keep} dev builds` : 'branch has an open PR' });
      } else if (!builtByThisPr(version) && now - createdAt(version) < MIN_AGE_DAYS * DAY_MS) {
        kept.push({ version, reason: `younger than ${MIN_AGE_DAYS} days` });
      } else {
        remove.push({ version, reason: isDevBranch ? 'older dev build' : builtByThisPr(version) ? 'its PR is closed' : stillOpen ? 'beyond the newest builds its open PR keeps' : 'branch has no open PR' });
      }
    });
  }
  return { remove, kept };
}

/**
 * Untagged versions are usually the child manifests of a tagged image (the platform image and its attestation),
 * so one is only removed when no kept image points to it and it is old enough that no push is still in flight.
 */
export function planUntagged({ versions, referenced, now = Date.now() }) {
  const remove = [];
  const kept = [];
  for (const version of versions) {
    if (tagsOf(version).length > 0) continue;
    if (referenced.has(version.name)) kept.push({ version, reason: 'part of a kept image' });
    else if (now - createdAt(version) < MIN_AGE_DAYS * DAY_MS) kept.push({ version, reason: `younger than ${MIN_AGE_DAYS} days` });
    else remove.push({ version, reason: 'untagged and no kept image uses it' });
  }
  return { remove, kept };
}

const describe = ({ version, reason }) => `  ${version.id}  ${version.created_at}  ${tagsOf(version).join(',') || '(untagged ' + String(version.name).slice(0, 19) + ')'}  — ${reason}`;

/**
 * Runs one package's clean-up through `api`, which does all the reading and deleting:
 *   listVersions(), openBranches(), runningTags(), children(version) -> digests, deleteVersion(version)
 * Returns what it planned; deletes only when `live` is true.
 */
export async function prunePackage({ api, rules, packageName, keep = DEFAULT_KEEP, live, closedBranch, closedShas, log = console.log, now = Date.now() }) {
  const versions = await api.listVersions();
  const tagged = versions.filter((version) => tagsOf(version).length > 0);
  const isGuarded = (version) => tagsOf(version).some((tag) => ['release', 'moving'].includes(classifyTag(tag, rules).kind));
  // If nothing looks like a release or the current dev build, the tag names probably changed (or the list is only untagged
  // versions): delete nothing. An empty package just has nothing to do.
  if (versions.length > 0 && !tagged.some(isGuarded)) {
    throw new Error(`${packageName}: none of its ${versions.length} versions (${tagged.length} tagged) looks like a release or the current dev build, so the tag rules may be out of date. Nothing was deleted.`);
  }
  const openBranches = await api.openBranches();
  const running = await api.runningTags();
  const first = planTagged({ versions, rules, keep, openBranches, running, closedBranch, closedShas, now });

  // Untagged versions follow their parents: keep whatever a kept image points to. An image we cannot read keeps everything untagged.
  let untagged = { remove: [], kept: [] };
  let untaggedNote = '';
  if (closedBranch === undefined) {
    const referenced = new Set();
    let readable = true;
    for (const { version } of first.kept) {
      try {
        for (const digest of await api.children(version)) referenced.add(digest);
      } catch (error) {
        readable = false;
        untaggedNote = `could not read ${version.name}: ${error.message}`;
        break;
      }
    }
    untagged = readable ? planUntagged({ versions, referenced, now }) : planUntagged({ versions, referenced: new Set(versions.map((v) => v.name)), now });
  }

  const remove = [...first.remove, ...untagged.remove];
  log(`${packageName}: ${versions.length} versions, ${first.kept.length} kept (${first.kept.filter((k) => k.reason === 'release').length} releases), ${remove.length} to delete`);
  if (untaggedNote) log(`  untagged versions left alone: ${untaggedNote}`);
  for (const item of remove) log(describe(item));
  if (remove.length === 0) return { remove, deleted: 0 };
  if (!live) {
    log(`${packageName}: dry run, nothing deleted.`);
    return { remove, deleted: 0 };
  }
  // A PR that was reopened while this run was planning keeps its images: read the open PRs once more before deleting for a close.
  const reopened = closedBranch !== undefined && (await api.openBranches()).has(sanitizeBranch(closedBranch));
  if (reopened) log(`  ${packageName}: ${closedBranch} has an open PR again, so its images are kept.`);
  // Read what dev and production run again right before each tagged delete: a deployment may have switched since the plan was made.
  // A tagged image that turns out to be running takes its untagged children with it (they were planned for deletion because
  // nothing kept pointed to them), so once one is skipped the untagged versions are left for the next run. Tagged ones go first.
  let deleted = 0;
  let sawRunning = false;
  for (const { version, reason } of remove) {
    if (reopened && reason === 'its PR is closed') continue;
    if (tagsOf(version).length > 0) {
      const runningNow = await api.runningTags();
      if (tagsOf(version).some((tag) => runningNow.has(tag))) {
        sawRunning = true;
        log(`  kept ${version.id}: it started running while this plan was being made`);
        continue;
      }
    } else if (sawRunning) {
      continue;
    }
    await api.deleteVersion(version);
    deleted += 1;
  }
  if (sawRunning) log(`${packageName}: untagged versions left alone this time, because an image started running.`);
  log(`${packageName}: deleted ${deleted}.`);
  return { remove, deleted };
}

/**
 * Reads the command line: `--live` is a switch, every other `--flag` takes a value. A flag with no value (or followed by
 * another flag) is an error, so an incomplete `--closed-branch` can never turn into a whole-package run.
 */
export function parseArgs(argv) {
  const out = { live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') {
      out.live = true;
    } else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    }
  }
  return out;
}

/**
 * Deletes one package version through the GitHub API. `github(path, init)` is a fetch against it. A 404 only counts as
 * "already gone" when the version is really not there: GitHub also answers 404 when the token may not delete.
 */
export function makeDeleter({ github, packagePath, packageName }) {
  return async (version) => {
    const response = await github(`${packagePath}/versions/${version.id}`, { method: 'DELETE' });
    if (response.status === 404) {
      const check = await github(`${packagePath}/versions/${version.id}`);
      if (check.status === 404) return;
      throw new Error(`could not delete version ${version.id} of ${packageName}: GitHub answered 404 but the version still exists (does this repository have the Admin role under the package's "Manage Actions access"?)`);
    }
    if (!response.ok) {
      const hint = response.status === 403 ? ` Give this repository the Admin role under the package's "Manage Actions access" (package settings; deleting a version needs Admin, not Write) and run it again.` : '';
      throw new Error(`could not delete version ${version.id} of ${packageName}: GitHub answered ${response.status}.${hint}`);
    }
  };
}
