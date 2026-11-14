import { Prisma, type AppCatalogEntry } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { createMcpServerSchema } from '@/lib/mcp/server-input';
import { createConnection } from '@/lib/app-connections';
import { getGitHubApp } from '@/lib/github/app';
import { connectGitHub, GITHUB_CATALOG_KEY, GITHUB_ROW_KEY } from '@/lib/github/connection';

/**
 * The apps a person can connect with one tap (game #2001, "Connect another"): a list a super admin keeps in Orbit, never
 * written in code. Until a ready-made adapter is on (a separate step that needs Khalid's own OK), the list holds only apps that
 * sign in through their own official link, or need no sign-in. An app that is not here can still be added by its link.
 *
 * An entry holds what that sign-in needs, encrypted, and it never leaves Orbit: a person sees only its name, its one line, its
 * icon and whether they have connected it. Connecting makes a connection that is theirs alone (`source: listed`); nothing is
 * shared between people, and a person has at most one connection made from an entry.
 */

const KEY = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** The only names a listed app's sign-in setup may carry: how to start a sign-in, never a token a sign-in produces. */
const PROVIDER_SETUP_FIELDS = new Set(['clientId', 'clientSecret', 'authorizeUrl', 'tokenUrl', 'scopes', 'scopesSupported', 'revocationUrl']);

function onlyProviderSetup(authConfig: string | null | undefined): boolean {
  if (!authConfig) return true;
  try {
    const parsed: unknown = JSON.parse(authConfig);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const setup = parsed as Record<string, unknown>;
    if (!Object.keys(setup).every((name) => PROVIDER_SETUP_FIELDS.has(name))) return false;
    // A wrong type here would break the sign-in for everyone who taps Connect (the scopes are split as a string)
    if (setup.scopes !== undefined && setup.scopes !== null && typeof setup.scopes !== 'string') return false;
    const supported = setup.scopesSupported;
    return supported === undefined || supported === null || (Array.isArray(supported) && supported.every((scope) => typeof scope === 'string'));
  } catch {
    return false;
  }
}

export const catalogEntrySchema = createMcpServerSchema
  .safeExtend({
    key: z.string().trim().regex(KEY, 'key must be lower case letters, digits and dashes'),
    blurb: z.string().trim().min(1).max(200),
    icon: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).default('plug'),
    sortOrder: z.number().int().min(-1000).max(1000).default(0),
  })
  // A key or token in the list would be one key for everyone: only apps that sign in on their own page, or need none
  .refine((entry) => entry.authType === 'oauth' || entry.authType === 'none', { path: ['authType'], message: 'A listed app signs in on its own page or needs no sign-in' })
  // The sign-in setup may hold only what sets a sign-in up. A token (access, refresh, expiry, anything a person's own sign-in writes)
  // would be copied into every connection made from the entry and shared by everyone who taps Connect
  .refine((entry) => entry.authType !== 'oauth' || onlyProviderSetup(entry.authConfig), { path: ['authConfig'], message: 'A listed app may hold only its sign-in setup, never a token' })
  .refine((entry) => entry.authType !== 'none' || !entry.authConfig, { path: ['authConfig'], message: 'An app that needs no sign-in has no sign-in setup' })
  // Extra headers would be copied into every person's connection like a token would, and can carry a key the same way
  .refine((entry) => !entry.headers || Object.keys(entry.headers).length === 0, { path: ['headers'], message: 'A listed app takes no extra headers' });

export const catalogPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    blurb: z.string().trim().min(1).max(200).optional(),
    icon: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().min(-1000).max(1000).optional(),
  })
  .strict();

/** What a super admin sees of an entry: never the way in itself. */
export interface CatalogAdminView {
  id: string;
  key: string;
  name: string;
  blurb: string;
  icon: string;
  serverUrl: string;
  authType: string;
  enabled: boolean;
  sortOrder: number;
}

const adminView = (entry: AppCatalogEntry): CatalogAdminView => ({
  id: entry.id,
  key: entry.key,
  name: entry.name,
  blurb: entry.blurb,
  icon: entry.icon,
  serverUrl: entry.serverUrl,
  authType: entry.authType,
  enabled: entry.enabled,
  sortOrder: entry.sortOrder,
});

export async function listCatalogForAdmin(): Promise<CatalogAdminView[]> {
  return (await prisma.appCatalogEntry.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map(adminView);
}

export async function addCatalogEntry(input: z.infer<typeof catalogEntrySchema>): Promise<CatalogAdminView | 'taken'> {
  try {
    const entry = await prisma.appCatalogEntry.create({
      data: {
        key: input.key,
        name: input.name,
        blurb: input.blurb,
        icon: input.icon,
        serverUrl: input.serverUrl,
        authType: input.authType,
        authConfig: input.authConfig ? encryptApiKey(input.authConfig) : null,
        headers: input.headers ?? undefined,
        enabled: input.enabled,
        sortOrder: input.sortOrder,
      },
    });
    return adminView(entry);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'taken';
    throw error;
  }
}

export async function changeCatalogEntry(id: string, patch: z.infer<typeof catalogPatchSchema>): Promise<CatalogAdminView | null> {
  const done = await prisma.appCatalogEntry.updateMany({ where: { id }, data: patch });
  if (done.count === 0) return null;
  return adminView(await prisma.appCatalogEntry.findUniqueOrThrow({ where: { id } }));
}

/**
 * Takes an app off the list. Connections people already made from it are theirs and keep working, but they let go of the entry's
 * key in the same step: a new entry that later takes the same key is a different app, and must not count them as connected to it
 * or hold them to the old link.
 */
export async function removeCatalogEntry(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // The entry's row is held first, so a person's Connect that is making a connection from it (which holds the same row shared)
    // finishes before the connections are let go, and one that starts after finds the entry gone
    const locked = await tx.$queryRaw<{ key: string }[]>`SELECT "key" FROM "app_catalog_entries" WHERE "id" = ${id} FOR UPDATE`;
    const entry = locked[0];
    if (!entry) return false;
    await tx.appConnection.updateMany({ where: { catalogKey: entry.key }, data: { catalogKey: null } });
    return (await tx.appCatalogEntry.deleteMany({ where: { id } })).count === 1;
  });
}

/** One row of "Connect another": what a person may know of an app on the list. */
export interface CatalogRow {
  key: string;
  name: string;
  blurb: string;
  icon: string;
  /** The id of their connection made from it, when they have one. */
  connectionId: string | null;
}

/**
 * The list a person sees, narrowed by what they typed (the name, the line under it or the key, any case). Apps that are off
 * are not shown. Their own connected apps come from `listConnections`; the app search shows both.
 */
export async function listCatalogForPerson(ownerId: string, query?: string): Promise<CatalogRow[]> {
  const q = query?.trim();
  const [entries, mine] = await Promise.all([
    prisma.appCatalogEntry.findMany({
      where: {
        enabled: true,
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { blurb: { contains: q, mode: 'insensitive' } }, { key: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.appConnection.findMany({ where: { ownerId, catalogKey: { not: null } }, select: { id: true, catalogKey: true } }),
  ]);
  const connected = new Map(mine.map((row) => [row.catalogKey as string, row.id]));
  const rows = entries.map((entry) => ({ key: entry.key, name: entry.name, blurb: entry.blurb, icon: entry.icon, connectionId: connected.get(entry.key) ?? null }));
  // GitHub, through Universe's own GitHub App (game #2041), once a super admin has made it: always first, for everyone
  if (!(await getGitHubApp())) return rows;
  const github: CatalogRow = { key: GITHUB_ROW_KEY, name: 'GitHub', blurb: 'Code, pull requests, issues and CI', icon: 'github', connectionId: connected.get(GITHUB_CATALOG_KEY) ?? null };
  const wanted = !q || [github.name, github.blurb, github.key].some((field) => field.toLowerCase().includes(q.toLowerCase()));
  return [...(wanted ? [github] : []), ...rows.filter((row) => row.key !== GITHUB_ROW_KEY)];
}

/**
 * "Connect" on a listed app: a connection for this person, with the entry's link and sign-in, and no Brick using it yet. Asked
 * twice (or twice at once), the second answer is the first connection. Null when the app is not on the list or is off.
 */
export async function connectFromCatalog(ownerId: string, key: string): Promise<{ id: string; created: boolean } | null> {
  // The GitHub row is Universe's own GitHub App once it is made (game #2041); the person signs in next
  if (key === GITHUB_ROW_KEY && (await getGitHubApp())) return connectGitHub(ownerId);
  try {
    // The entry is read and held shared while the connection is made, so removing it at the same moment either waits for this
    // or is waited for: a connection is never made from an entry that is already gone
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_catalog_entries" WHERE "key" = ${key} AND "enabled" = true FOR SHARE`;
      if (rows.length === 0) return null;
      const entry = await tx.appCatalogEntry.findUniqueOrThrow({ where: { id: rows[0].id } });
      const existing = await tx.appConnection.findFirst({ where: { ownerId, catalogKey: key }, select: { id: true } });
      if (existing) return { id: existing.id, created: false };
      const connection = await createConnection(
        ownerId,
        {
          name: entry.name,
          serverUrl: entry.serverUrl,
          authType: entry.authType as 'oauth' | 'none',
          authConfig: entry.authConfig ? decryptApiKey(entry.authConfig) : null,
          headers: (entry.headers as Record<string, string> | null) ?? undefined,
          source: 'listed',
          catalogKey: key,
        },
        tx,
      );
      return { id: connection.id, created: true };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.appConnection.findFirst({ where: { ownerId, catalogKey: key }, select: { id: true } });
      if (winner) return { id: winner.id, created: false };
    }
    throw error;
  }
}
