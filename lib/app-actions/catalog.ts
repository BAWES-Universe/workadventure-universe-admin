import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { getAdapter, type ProviderAction } from '@/lib/app-adapter';
import type { Heading } from '@/lib/mcp-tool-policy';
import { acceptSorterPick, actionTitle, sortAction, withoutProvider } from '@/lib/app-actions/sort';

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
/** How long a reader holds an App's list before another may read it. */
const CLAIM_MS = 2 * 60_000;
const DESCRIPTION_MAX = 2000;

const running = new Map<string, Promise<boolean>>();

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
  const adapter = getAdapter();
  if (!adapter?.actions) return false;
  const now = new Date();
  // Two readers making the App's row at the same moment: the one that loses finds it made
  await prisma.appActionCatalog.createMany({ data: [{ toolkit }], skipDuplicates: true });
  const claimed = await prisma.appActionCatalog.updateMany({
    where: { toolkit, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] },
    data: { claimedUntil: new Date(now.getTime() + CLAIM_MS) },
  });
  if (claimed.count !== 1) return false;
  let listed: ProviderAction[];
  try {
    listed = await adapter.actions(toolkit);
  } catch (error) {
    console.error('[AppActions] Could not read the actions of an App:', error instanceof Error ? error.message : 'unknown');
    await prisma.appActionCatalog.updateMany({ where: { toolkit }, data: { claimedUntil: null } });
    return false;
  }
  try {
    await save(toolkit, listed);
    return true;
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'app-actions' } });
    console.error('[AppActions] Could not save the actions of an App:', error instanceof Error ? error.message : 'unknown');
    await prisma.appActionCatalog.updateMany({ where: { toolkit }, data: { claimedUntil: null } }).catch(() => undefined);
    return false;
  }
}

async function save(toolkit: string, listed: readonly ProviderAction[]): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const before = await tx.appAction.findMany({ where: { toolkit }, select: { id: true, slug: true, title: true, description: true, heading: true, source: true, catalogVersion: true, position: true } });
      const bySlug = new Map(before.map((row) => [row.slug, row]));
      const fresh: { toolkit: string; slug: string; title: string; description: string | null; heading: string; source: string; catalogVersion: string | null; position: number }[] = [];
      for (const [position, action] of listed.entries()) {
        const old = bySlug.get(action.slug);
        let sorted: { heading: Heading; source: string } = sortAction(toolkit, action.slug, action.tags);
        // The sorter's answer stands while the provider still says nothing more than it did when the sorter read it
        if (sorted.source === 'fallback' && old?.source === 'sorter') sorted = { heading: old.heading as Heading, source: 'sorter' };
        const row = {
          toolkit,
          slug: action.slug.slice(0, 255),
          title: actionTitle(toolkit, action.slug),
          description: action.description ? withoutProvider(action.description).slice(0, DESCRIPTION_MAX) || null : null,
          heading: sorted.heading,
          source: sorted.source,
          catalogVersion: action.version ? action.version.slice(0, 60) : null,
          position,
        };
        if (!old) fresh.push(row);
        else if (old.title !== row.title || old.description !== row.description || old.heading !== row.heading || old.source !== row.source || old.catalogVersion !== row.catalogVersion || old.position !== row.position) {
          await tx.appAction.update({ where: { id: old.id }, data: row });
        }
      }
      if (fresh.length > 0) await tx.appAction.createMany({ data: fresh, skipDuplicates: true });
      const kept = new Set(listed.map((action) => action.slug));
      const gone = before.filter((row) => !kept.has(row.slug)).map((row) => row.id);
      if (gone.length > 0) await tx.appAction.deleteMany({ where: { id: { in: gone } } });
      await tx.appActionCatalog.update({ where: { toolkit }, data: { refreshedAt: new Date(), claimedUntil: null, actionCount: listed.length } });
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
}

/**
 * Makes sure an App's list is there and not older than a day. A list that is there is used as it is while a newer one is read in the
 * background; a list never read is waited for up to `waitMs` (a grant's first read), and else read in the background too. Never throws.
 */
export async function ensureAppActions(toolkit: string, waitMs = 0): Promise<void> {
  const key = toolkit.toLowerCase();
  try {
    const catalog = await prisma.appActionCatalog.findUnique({ where: { toolkit: key }, select: { refreshedAt: true } });
    if (catalog?.refreshedAt && Date.now() - catalog.refreshedAt.getTime() < CATALOG_MAX_AGE_MS) return;
    const run = refreshAppActions(key).catch(() => false);
    if (!catalog?.refreshedAt && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    console.error('[AppActions] Could not check the list of an App:', error instanceof Error ? error.message : 'unknown');
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
  return prisma.appAction.findMany({
    where: { source: 'fallback' },
    select: { toolkit: true, slug: true, title: true, description: true },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

/**
 * The sorter's picks. Only an action still waiting for it changes (one a newer read sorted by tag stays as it is); Makes new things
 * only for an action Universe knows stays private, else Changes things. Answers how many changed.
 */
export async function saveSorterPicks(picks: readonly { toolkit: string; slug: string; heading: Heading }[]): Promise<number> {
  let changed = 0;
  for (const pick of picks) {
    const toolkit = pick.toolkit.toLowerCase();
    const done = await prisma.appAction.updateMany({
      where: { toolkit, slug: pick.slug, source: 'fallback' },
      data: { heading: acceptSorterPick(toolkit, pick.slug, pick.heading), source: 'sorter' },
    });
    changed += done.count;
  }
  return changed;
}
