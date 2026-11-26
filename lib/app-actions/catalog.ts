import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { getAdapter, type ProviderAction } from '@/lib/app-adapter';
import type { Heading } from '@/lib/mcp-tool-policy';
import { acceptSorterPick, actionTitle, sortAction, withoutProvider } from '@/lib/app-actions/sort';
import { ownActionList, type OwnAction } from '@/lib/github/actions';

/**
 * Each ready-made App's list of actions, kept once for everyone (table `app_actions`), sorted by Universe (lib/app-actions/sort.ts).
 *
 * It is read from the provider when an App is first granted to a Brick, again once it is a day old, and sooner when a Brick calls an
 * action the list does not have. One reader at a time for an App, across Orbit's processes (a claim on `app_action_catalogs`), and a
 * failed read leaves the list as it was. An action the sorter already sorted keeps its heading while the provider still gives it no tag.
 */

export const CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
/** An action the list does not have makes it be read again, at most this often. */
export const UNKNOWN_SLUG_RETRY_MS = 10 * 60_000;
/**
 * How long a reader holds an App's list before another may read it. Longer than the longest read of the provider (10 pages of at
 * most 30 seconds each, retries included), so a reader that is still working never loses its claim; a reader that died frees the
 * list after this long. A read that ends after its claim ran out writes nothing.
 */
const CLAIM_MS = 6 * 60_000;
/** After a read that failed, how long before the provider is asked again (every poll would ask it otherwise). */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/**
 * A list this much shorter than the one kept (or empty) is not believed at once: one bad answer must never drop actions. When the
 * provider keeps answering it, on every read for this long and on at least SHRINK_BELIEVED_READS reads in a row, it is believed (the
 * App really lost those actions). Any read that is not shorter starts the count again. A person's own choice for an action stays on
 * the grant either way.
 */
const SHRINK_LIMIT = 0.5;
const SHRINK_CHECK_FROM = 10;
export const SHRINK_BELIEVED_AFTER_MS = 6 * 60 * 60_000;
export const SHRINK_BELIEVED_READS = 3;
const DESCRIPTION_MAX = 2000;

const running = new Map<string, Promise<boolean>>();

/**
 * Universe's own lists (lib/github/actions.ts: GitHub) live in the code, not at a provider: they are saved from the code once per process
 * (a new release brings its list at the first read) and never wait for the adapter, which they do not use.
 */
const ownListsSaved = new Set<string>();

/** One action as it is saved: a provider's (sorted here) or one of Universe's own list (already sorted, with its own words). */
type ListedAction = ProviderAction & { own?: OwnAction };

const fromOwnList = (list: readonly OwnAction[]): ListedAction[] =>
  list.map((action) => ({ slug: action.slug, description: action.description, tags: [], version: null, own: action }));

/** The reader's claim ran out and another reader took the App's list: what this one read is not written. */
class ClaimLost extends Error {}

/** Whether the list was read and saved now. False when another reader holds it, or the provider could not be asked (the list stays as it was). */
export function refreshAppActions(toolkit: string): Promise<boolean> {
  const key = toolkit.toLowerCase();
  const already = running.get(key);
  if (already) return already;
  const run = readAndSave(key).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

async function readAndSave(toolkit: string): Promise<boolean> {
  const own = ownActionList(toolkit);
  const adapter = getAdapter();
  if (!own && !adapter?.actions) return false;
  const now = new Date();
  // Two readers making the App's row at the same moment: the one that loses finds it made
  await prisma.appActionCatalog.createMany({ data: [{ toolkit }], skipDuplicates: true });
  // The claim's end is this reader's mark: a later claim always ends later (it is taken only once this one is over), so every write
  // below that names it is made only while this reader still holds the list, and never over a newer reader's
  const claim = new Date(now.getTime() + CLAIM_MS);
  const claimed = await prisma.appActionCatalog.updateMany({
    where: { toolkit, AND: [{ OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] }, { OR: [{ retryAfter: null }, { retryAfter: { lt: now } }] }] },
    data: { claimedUntil: claim },
  });
  if (claimed.count !== 1) return false;
  // This reader's claim, as a filter: still this reader's (no one took it over) and not run out
  const mine = () => ({ equals: claim, gt: new Date() });
  // After a failed read the provider is not asked again for a while (retry_after), so the next polls do not each ask it
  const backOff = () =>
    prisma.appActionCatalog.updateMany({ where: { toolkit, claimedUntil: mine() }, data: { claimedUntil: null, retryAfter: new Date(Date.now() + RETRY_AFTER_FAILURE_MS) } }).catch(() => undefined);
  let listed: ListedAction[];
  try {
    listed = own ? fromOwnList(own) : await adapter!.actions!(toolkit);
  } catch (error) {
    console.error('[AppActions] Could not read the actions of an App:', error instanceof Error ? error.message : 'unknown');
    await backOff();
    return false;
  }
  // Universe's own list is the list: it is never held back as a short answer
  const kept = own ? 0 : await prisma.appAction.count({ where: { toolkit } });
  if (kept > 0 && (listed.length === 0 || (kept >= SHRINK_CHECK_FROM && listed.length < kept * SHRINK_LIMIT))) {
    // This read counts as one more in a row that gave the shorter list (the first one starts the clock)
    const bumped = await prisma.appActionCatalog.updateMany({ where: { toolkit, claimedUntil: mine() }, data: { shrunkReads: { increment: 1 } } }).catch(() => null);
    // Another reader holds the list now: this read counts for nothing
    if (bumped?.count === 0) return false;
    const counted = bumped ? await prisma.appActionCatalog.findUnique({ where: { toolkit }, select: { shrunkSince: true, shrunkReads: true } }).catch(() => null) : null;
    const since = counted?.shrunkSince ?? null;
    if (!counted || !since || Date.now() - since.getTime() < SHRINK_BELIEVED_AFTER_MS || counted.shrunkReads < SHRINK_BELIEVED_READS) {
      console.error(`[AppActions] The provider listed ${listed.length} actions for an App that had ${kept}: the list is kept as it was for now`);
      if (counted && !since) await prisma.appActionCatalog.updateMany({ where: { toolkit, claimedUntil: mine(), shrunkSince: null }, data: { shrunkSince: now } }).catch(() => undefined);
      await backOff();
      return false;
    }
    console.error(`[AppActions] The provider has listed ${listed.length} actions for an App that had ${kept}, on ${counted.shrunkReads} reads in a row since ${since.toISOString()}: the shorter list is taken`);
  }
  try {
    await save(toolkit, listed, claim);
    if (own) ownListsSaved.add(toolkit);
    return true;
  } catch (error) {
    if (error instanceof ClaimLost) {
      console.error('[AppActions] A read of an App’s actions ended after its claim ran out: nothing of it is written');
      return false;
    }
    Sentry.captureException(error, { tags: { area: 'app-actions' } });
    console.error('[AppActions] Could not save the actions of an App:', error instanceof Error ? error.message : 'unknown');
    await backOff();
    return false;
  }
}

async function save(toolkit: string, listed: readonly ListedAction[], claim: Date): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // Only while this reader still holds the list: the row stays locked to the end, so no other reader can take it in between
      const held = await tx.appActionCatalog.updateMany({ where: { toolkit, claimedUntil: { equals: claim, gt: new Date() } }, data: { claimedUntil: claim } });
      if (held.count !== 1) throw new ClaimLost();
      const before = await tx.appAction.findMany({ where: { toolkit }, select: { id: true, slug: true, title: true, description: true, heading: true, source: true, catalogVersion: true, position: true } });
      const bySlug = new Map(before.map((row) => [row.slug, row]));
      const fresh: { toolkit: string; slug: string; title: string; description: string | null; heading: string; source: string; catalogVersion: string | null; position: number }[] = [];
      let changed = false;
      // An action the provider calls deprecated still runs: it is kept, after the others, so the first 500 a grant holds are the current ones
      const ordered = [...listed.filter((action) => !action.deprecated), ...listed.filter((action) => action.deprecated)];
      for (const [position, action] of ordered.entries()) {
        const old = bySlug.get(action.slug);
        // Universe's own list comes sorted, with its own words ('universe': never handed to the sorter)
        let sorted: { heading: Heading; source: string } = action.own ? { heading: action.own.heading, source: 'universe' } : sortAction(toolkit, action.slug, action.tags);
        // The sorter's answer stands while the provider still says nothing more than it did when the sorter read it
        if (sorted.source === 'fallback' && old?.source === 'sorter') sorted = { heading: old.heading as Heading, source: 'sorter' };
        const row = {
          toolkit,
          slug: action.slug.slice(0, 255),
          title: action.own ? action.own.title.slice(0, 255) : actionTitle(toolkit, action.slug),
          description: action.description ? withoutProvider(action.description).slice(0, DESCRIPTION_MAX) || null : null,
          heading: sorted.heading,
          source: sorted.source,
          catalogVersion: action.version ? action.version.slice(0, 60) : null,
          position,
        };
        if (!old) fresh.push(row);
        else if (old.title !== row.title || old.description !== row.description || old.heading !== row.heading || old.source !== row.source || old.catalogVersion !== row.catalogVersion || old.position !== row.position) {
          await tx.appAction.update({ where: { id: old.id }, data: row });
          changed = true;
        }
      }
      if (fresh.length > 0) await tx.appAction.createMany({ data: fresh, skipDuplicates: true });
      const kept = new Set(listed.map((action) => action.slug));
      const gone = before.filter((row) => !kept.has(row.slug)).map((row) => row.id);
      if (gone.length > 0) await tx.appAction.deleteMany({ where: { id: { in: gone } } });
      changed ||= fresh.length > 0 || gone.length > 0;
      await tx.appActionCatalog.updateMany({
        where: { toolkit, claimedUntil: claim },
        data: { refreshedAt: new Date(), claimedUntil: null, retryAfter: null, shrunkSince: null, shrunkReads: 0, actionCount: listed.length, ...(changed ? { version: { increment: 1 } } : {}) },
      });
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
}

export interface CatalogState {
  /** When the list was last read; null while it never was. */
  refreshedAt: Date | null;
  version: number;
}

/**
 * Makes sure an App's list is there and not older than a day. A list that is there is used as it is while a newer one is read in the
 * background; a list never read is waited for up to `waitMs` (a grant's first read), and else read in the background too. Never throws.
 */
export async function ensureAppActions(toolkit: string, waitMs = 0): Promise<CatalogState | null> {
  const key = toolkit.toLowerCase();
  const read = () => prisma.appActionCatalog.findUnique({ where: { toolkit: key }, select: { refreshedAt: true, version: true, claimedUntil: true, retryAfter: true } });
  try {
    // Universe's own list is saved from the code before its first use in this process (quick: no provider is asked), so a release's
    // new action is there at once; a save that could not run (another process holds the list) leaves what is there
    if (ownActionList(key) && !ownListsSaved.has(key)) {
      await refreshAppActions(key).catch(() => false);
      const saved = await read();
      if (saved?.refreshedAt) return saved;
    }
    const catalog = await read();
    if (catalog?.refreshedAt && Date.now() - catalog.refreshedAt.getTime() < CATALOG_MAX_AGE_MS) return catalog;
    // A failed read is waited out: nothing to start, and nothing would come to wait for
    if (catalog?.retryAfter && catalog.retryAfter.getTime() > Date.now()) return catalog;
    // Another reader holds it (here or in another process): nothing to start, but its result may be waited for
    const claimed = !!catalog?.claimedUntil && catalog.claimedUntil.getTime() > Date.now();
    const run = claimed ? (running.get(key) ?? null) : refreshAppActions(key).catch(() => false);
    if (catalog?.refreshedAt || waitMs <= 0) return catalog;
    const until = Date.now() + waitMs;
    // Done: read, waited long enough, or nothing more will come (a read that failed is waited out, or no reader holds the claim)
    const settled = (state: Awaited<ReturnType<typeof read>>) =>
      !!state?.refreshedAt ||
      Date.now() >= until ||
      (!!state?.retryAfter && state.retryAfter.getTime() > Date.now()) ||
      !state?.claimedUntil ||
      state.claimedUntil.getTime() <= Date.now();
    if (run) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      if (timer) clearTimeout(timer);
      const after = await read();
      // This process may have lost the claim to another one at the same moment: that one's result is then looked for below
      if (settled(after)) return after;
    }
    // Another process reads it: its result is looked for until the wait is over
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const now = await read();
      if (settled(now)) return now;
    }
  } catch (error) {
    console.error('[AppActions] Could not check the list of an App:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** A Brick called an action the list does not have: the list is read again in the background, at most every few minutes. */
export async function noteUnknownAction(toolkit: string): Promise<void> {
  const key = toolkit.toLowerCase();
  try {
    const catalog = await prisma.appActionCatalog.findUnique({ where: { toolkit: key }, select: { refreshedAt: true } });
    if (catalog?.refreshedAt && Date.now() - catalog.refreshedAt.getTime() < UNKNOWN_SLUG_RETRY_MS) return;
    void refreshAppActions(key).catch(() => false);
  } catch {
    // Only a hint: the daily read still comes
  }
}

/* --------------------------------- the sorter --------------------------------- */

export interface UnsortedAction {
  toolkit: string;
  slug: string;
  title: string;
  description: string | null;
}

/** Actions nothing has sorted yet (no tag, no name rule): the bot server's small model sorts them, a batch at a time. */
export async function unsortedActions(limit: number): Promise<UnsortedAction[]> {
  return prisma.$transaction(async (tx) => {
    // Rows the sorter's answer is being saved on right now are passed over (SKIP LOCKED): this read never waits on that write, so the two never deadlock
    const rows = await tx.$queryRaw<{ id: string; toolkit: string; slug: string; title: string; description: string | null }[]>`
      SELECT "id", "toolkit", "slug", "title", "description" FROM "app_actions"
      WHERE "source" = 'fallback' ORDER BY "updated_at" ASC, "id" ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    // Handed out: they go to the back of the line, so a batch the sorter never answers does not hold up the ones behind it
    if (rows.length > 0) await tx.appAction.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { updatedAt: new Date() } });
    return rows.map(({ id: _id, ...row }) => row);
  });
}

/**
 * The sorter's picks. Only an action still waiting for it changes (one a newer read sorted by tag stays as it is); Makes new things
 * only for an action Universe knows stays private, else Changes things. Answers how many changed.
 */
export async function saveSorterPicks(picks: readonly { toolkit: string; slug: string; heading: Heading }[]): Promise<number> {
  // One write: the picks and the versions that make each grant follow them land together, or neither does (a pick saved without its
  // version would never reach a grant, and asking again would not help: it is no longer waiting for the sorter)
  return prisma.$transaction(
    async (tx) => {
      // The Apps' lists are held first, as a read of the provider holds them before it writes their actions: the two never wait on each other
      const toolkits = [...new Set(picks.map((pick) => pick.toolkit.toLowerCase()))].sort();
      if (toolkits.length > 0) await tx.$queryRaw`SELECT 1 AS one FROM "app_action_catalogs" WHERE "toolkit" = ANY(${toolkits}) ORDER BY "toolkit" FOR UPDATE`;
      let changed = 0;
      const touched = new Set<string>();
      for (const pick of picks) {
        const toolkit = pick.toolkit.toLowerCase();
        const done = await tx.appAction.updateMany({
          where: { toolkit, slug: pick.slug, source: 'fallback' },
          data: { heading: acceptSorterPick(toolkit, pick.slug, pick.heading), source: 'sorter' },
        });
        changed += done.count;
        if (done.count > 0) touched.add(toolkit);
      }
      // Each Brick's grant of these Apps follows at its next read
      for (const toolkit of touched) await tx.appActionCatalog.updateMany({ where: { toolkit }, data: { version: { increment: 1 } } });
      return changed;
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
}
