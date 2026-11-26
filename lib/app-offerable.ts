import { prisma } from '@/lib/db';
import { connectedState, confirmIfPending } from '@/lib/app-connections';
import { ownerAskingThrough } from '@/lib/brick-make';
import { getAdapter } from '@/lib/app-adapter';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { getGitHubApp } from '@/lib/github/app';
import { GITHUB_BLURB, GITHUB_CATALOG_KEY, GITHUB_ROW_KEY } from '@/lib/github/connection';
import { ownCopyWorks, sameApp } from '@/lib/app-same';

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
 *  - every ready-made app that is on, while the adapter is (none without it; it answers as if it did not exist);
 *  - never an App the person already added themselves, by its link or with their key (lib/app-same.ts): their own copy comes first.
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
  // The Apps the person added themselves, by their link or with their key, that work: a listed or ready-made App that is the same App (lib/app-same.ts) is
  // never suggested, so the Brick never pushes another copy (one Universe may pay for) of an App the person already has
  // Only one that works counts (ownCopyWorks): a signed-out link, a key the service stopped taking or a server that stopped answering
  // never hides a working way to the same App
  // A listed App they connected counts against a ready-made copy too, the same own copies the bot server's list gives way to (lib/app-same.ts
  // isOwnApp); a listed entry is only checked against their links and keys, since their listed connections are already shown as theirs
  const added = (await prisma.appConnection.findMany({ where: { ownerId, OR: [{ kind: 'direct' }, { kind: 'mcp', source: { in: ['link', 'listed'] } }] } })).filter((own) => ownCopyWorks(connectedState(own).connected, own));
  const alreadyAdded = (app: { key: string; name: string }, withListed = false) => added.some((own) => (withListed || own.source !== 'listed') && sameApp(own, app));
  // Only the connections this answer can show are asked about: a ready-made one whose app is off, or any while the adapter is
  // off, never makes the owner wait for the provider (or fail on its answer)
  const shownReadyMade = new Set(readyMade.filter((app) => app.enabled).map((app) => app.key));
  const showable = mine.filter((row) => {
    if (row.catalogKey) return true;
    if (!row.providerToolkit || !adapterOn) return false;
    // The older ready-made GitHub connection is only read for the GitHub row below
    if (row.providerToolkit === GITHUB_ROW_KEY && githubApp) return true;
    return shownReadyMade.has(row.providerToolkit);
  });
  const confirmedFirst = await Promise.all(showable.map(confirmIfPending));
  // A sign-in the provider just confirmed may have been granted to this Brick while it was being asked: connection and grant are
  // read together again for those, so a connection that already had its grant is not reported as not used yet
  const asked = showable.filter((row) => row.source === 'ready_made' && !row.providerConfirmedAt).map((row) => row.id);
  const reread =
    asked.length > 0
      ? await prisma.appConnection.findMany({
          where: { id: { in: asked }, ownerId },
          include: { grants: { where: { botId: viaBrickId }, select: { id: true } } },
        })
      : [];
  const confirmed = confirmedFirst.flatMap((row) => {
    if (!asked.includes(row.id)) return [row];
    const fresh = reread.find((one) => one.id === row.id);
    // Gone while it was being asked: not offered as connected
    return fresh ? [{ ...fresh, providerConfirmedAt: fresh.providerConfirmedAt ?? row.providerConfirmedAt }] : [];
  });
  const byCatalogKey = new Map(confirmed.filter((row) => row.catalogKey).map((row) => [row.catalogKey as string, row]));
  const byToolkit = new Map(confirmed.filter((row) => row.providerToolkit).map((row) => [row.providerToolkit as string, row]));
  const view = (row: (typeof confirmed)[number] | undefined) => ({
    connectionId: row?.id ?? null,
    connected: row ? connectedState(row).connected : false,
    usable: !!row && row.grants.length > 0,
  });

  const out: OfferableApp[] = [];
  // Listed apps are all offered, each once by its key (two may share a name, as "Connect another" lists them). A ready-made
  // app that has the key or the name of a listed one is shown once, as the listed one (the Apps page does the same); two
  // ready-made apps with the same name stay separate.
  const listedKeys = new Set<string>();
  const listedNames = new Set<string>();
  const addListed = (app: OfferableApp) => {
    if (listedKeys.has(app.key)) return;
    listedKeys.add(app.key);
    listedNames.add(nameKey(app.name));
    out.push(app);
  };

  if (githubApp) {
    // An older ready-made GitHub connection that still works is the person's GitHub: they are not asked to connect a second one.
    // Never while the adapter is off: the ready-made routes answer as if it did not exist, so it could not be used.
    const older = byToolkit.get(GITHUB_ROW_KEY);
    const own = byCatalogKey.get(GITHUB_CATALOG_KEY) ?? (adapterOn && older && connectedState(older).connected ? older : undefined);
    addListed({ key: GITHUB_ROW_KEY, name: 'GitHub', blurb: GITHUB_BLURB, kind: 'listed', ...view(own) });
  }
  for (const entry of entries) {
    const own = byCatalogKey.get(entry.key);
    // A listed App the person already connected is shown as connected; one they only have by their own link is not suggested at all
    if (!own && alreadyAdded(entry)) continue;
    addListed({ key: entry.key, name: entry.name, blurb: entry.blurb, kind: 'listed', ...view(own) });
  }
  for (const app of readyMade) {
    if (!app.enabled) continue;
    if (listedKeys.has(app.key) || listedNames.has(nameKey(app.name))) continue;
    // One they already connected is still shown as it is; one they only have by their own link or key is not suggested
    if (!byToolkit.get(app.key) && alreadyAdded(app, true)) continue;
    out.push({ key: app.key, name: app.name, blurb: '', kind: 'readyMade', ...view(byToolkit.get(app.key)) });
  }
  return out;
}
