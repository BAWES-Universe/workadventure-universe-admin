import { prisma } from '@/lib/db';
import { connectedState, confirmIfPending } from '@/lib/app-connections';
import { ownerAskingThrough } from '@/lib/brick-make';
import { getAdapter } from '@/lib/app-adapter';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { getGitHubApp } from '@/lib/github/app';
import { GITHUB_BLURB, GITHUB_CATALOG_KEY, GITHUB_ROW_KEY } from '@/lib/github/connection';

/** One app on the list as the bot server needs it to tell a Brick what it may offer its owner. Never the link or the sign-in. */
export interface OfferableApp {
  key: string;
  name: string;
  blurb: string;
  /**
   * Which call connects it, the same two the Apps page uses: `listed` is an app of the list a super admin keeps, and GitHub through
   * Universe's own GitHub App (POST /api/me/apps { catalogKey }); `readyMade` is a ready-made app (POST /api/me/apps/ready-made).
   */
  kind: 'listed' | 'readyMade';
  /** The owner's own connection made from it, when they have one. */
  connectionId: string | null;
  /** That connection is signed in and works. */
  connected: boolean;
  /** This Brick already has a grant on it. */
  usable: boolean;
}

const nameKey = (name: string) => name.trim().toLowerCase();

/**
 * The apps a Brick may offer its owner ("Let it use Gmail" once connected, and not yet used by this Brick): every app a person can
 * connect from the Apps page, so the chat offers exactly what "Connect another" shows there, before and after they connect it:
 *  - GitHub through Universe's own GitHub App, first, once a super admin has made that app (never before: it cannot sign anyone in);
 *  - every app of the list a super admin keeps that is on;
 *  - every ready-made app that is on, while the adapter is (none without it; it answers as if it did not exist).
 * Each comes with the owner's own connection of it. Only for the owner of Brick `viaBrickId`; for anyone else, and for a room
 * bot, null, the same as for a Brick that does not exist.
 */
export async function offerableForBrick(viaBrickId: string, userId: string): Promise<OfferableApp[] | null> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  if (!ownerId) return null;
  const adapterOn = getAdapter() !== null;
  const [entries, readyMade, githubApp, mine] = await Promise.all([
    prisma.appCatalogEntry.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    adapterOn ? readReadyMadeApps() : Promise.resolve([]),
    getGitHubApp(),
    prisma.appConnection.findMany({
      where: { ownerId, OR: [{ catalogKey: { not: null } }, { providerToolkit: { not: null } }] },
      include: { grants: { where: { botId: viaBrickId }, select: { id: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const confirmed = await Promise.all(mine.map(confirmIfPending));
  const byCatalogKey = new Map(confirmed.filter((row) => row.catalogKey).map((row) => [row.catalogKey as string, row]));
  const byToolkit = new Map(confirmed.filter((row) => row.providerToolkit).map((row) => [row.providerToolkit as string, row]));
  const view = (row: (typeof confirmed)[number] | undefined) => ({
    connectionId: row?.id ?? null,
    connected: row ? connectedState(row).connected : false,
    usable: !!row && row.grants.length > 0,
  });

  const out: OfferableApp[] = [];
  const taken = new Set<string>();
  const add = (app: OfferableApp) => {
    // One row for one app: a ready-made app with the name or key of a listed one is shown once, as the listed one (the Apps page does the same)
    if (taken.has(app.key) || taken.has(nameKey(app.name))) return;
    taken.add(app.key);
    taken.add(nameKey(app.name));
    out.push(app);
  };

  if (githubApp) {
    // An older ready-made GitHub connection that still works is the person's GitHub: they are not asked to connect a second one
    const older = byToolkit.get(GITHUB_ROW_KEY);
    const own = byCatalogKey.get(GITHUB_CATALOG_KEY) ?? (older && connectedState(older).connected ? older : undefined);
    add({ key: GITHUB_ROW_KEY, name: 'GitHub', blurb: GITHUB_BLURB, kind: 'listed', ...view(own) });
  }
  for (const entry of entries) {
    add({ key: entry.key, name: entry.name, blurb: entry.blurb, kind: 'listed', ...view(byCatalogKey.get(entry.key)) });
  }
  for (const app of readyMade) {
    if (!app.enabled) continue;
    add({ key: app.key, name: app.name, blurb: '', kind: 'readyMade', ...view(byToolkit.get(app.key)) });
  }
  return out;
}
