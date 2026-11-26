import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { Heading, Setting } from '@/lib/mcp-tool-policy';
import { ensureAppActions, noteUnknownAction } from '@/lib/app-actions/catalog';
import { effectiveSetting, nameRule } from '@/lib/app-actions/sort';

/**
 * A Brick's grant of a ready-made App holds the App's actions as its tool rows (`BotMcpTool`), not the provider's four meta tools:
 * name = the action's slug, its title and words from the App's list, under the heading Universe sorted it under, confirmed by Universe
 * (no person confirms an App's actions: there is no review gate on Apps). Each row may carry its own choice (`setting`) over its
 * heading's.
 *
 * A grant is brought over only when a reader that knows App actions asks for it (the bot server's `?actions=1`, a person's choice for
 * one action): until then it keeps the rows it had, so a bot server that does not know App actions yet keeps working as it did. Once
 * brought over (`appActionsVersion` set), its heading settings stay, the meta tool rows go, and nothing a person chose for an action
 * is lost when the list is read again: a row with its own choice is kept even when the App's list no longer holds it.
 *
 * A grant holds the first 500 actions in the App's order (MAX_TOOLS_PER_SERVER); any other action is judged from the App's list and
 * its heading's setting, never refused for being missing.
 */

export const MAX_ACTION_ROWS = 500;
/** How long a grant's first read waits for an App's list that was never read. */
const FIRST_READ_WAIT_MS = 3_000;

/** An action row's fingerprint: its identity is the App and the slug (the list's version is Orbit's, never a reason to ask again). */
export const actionFingerprint = (toolkit: string, slug: string): string => createHash('sha256').update(`app-action:${toolkit.toLowerCase()}:${slug}`).digest('hex');

/** How a slug is matched: case, spaces and dashes never make one action two. */
export const slugKey = (slug: string): string => slug.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** Whether a grant's connection is a ready-made App's: a Brick's (or a bot's) grant that can hold an App's actions. */
export const isAppActionsConnection = (connection: { source: string; providerToolkit: string | null } | null | undefined): connection is { source: 'ready_made'; providerToolkit: string } =>
  !!connection && connection.source === 'ready_made' && !!connection.providerToolkit;

/** Whether a grant's rows are an App's actions now: a ready-made App's grant that was brought over. */
export const holdsAppActions = (server: { appActionsVersion: number | null; connection: { source: string; providerToolkit: string | null } | null }): boolean =>
  server.appActionsVersion !== null && isAppActionsConnection(server.connection);

/** A row changed between the read and the write of the same call: the whole call is read again. */
class StaleRows extends Error {}

const TOOL_SELECT = { id: true, name: true, title: true, description: true, fingerprint: true, heading: true, suggestedHeading: true, suggestionSource: true, confirmedAt: true, movedById: true, confirmedById: true, setting: true } as const;

/**
 * Brings a ready-made App's grant over to the App's actions, and keeps its rows matching the App's list. Cheap when the list did not
 * change since the last call (one small read). True when something changed. Does nothing (false) for a grant that is not a ready-made
 * App's, or while the App's list was never read (the grant keeps the rows it had). Two calls at once are safe: a row is written only
 * while it holds what was read, and the loser reads again.
 */
export async function ensureAppActionTools(serverId: string, attempt = 0): Promise<boolean> {
  const head = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: { appActionsVersion: true, connection: { select: { source: true, providerToolkit: true } } } });
  if (!head || !isAppActionsConnection(head.connection)) return false;
  const toolkit = head.connection.providerToolkit.toLowerCase();
  const catalog = await ensureAppActions(toolkit, attempt === 0 && head.appActionsVersion === null ? FIRST_READ_WAIT_MS : 0);
  // Never read (or Orbit could not check): the grant stays as it is, and the next read tries again
  if (!catalog?.refreshedAt) return false;
  if (head.appActionsVersion === catalog.version) return false;

  const server = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: { appActionsVersion: true, legacyText: true, toolsCut: true, toolsSeen: true, tools: { select: TOOL_SELECT } } });
  if (!server) return false;
  const [actions, total] = await Promise.all([
    prisma.appAction.findMany({ where: { toolkit }, select: { slug: true, title: true, description: true, heading: true }, orderBy: [{ position: 'asc' }, { slug: 'asc' }], take: MAX_ACTION_ROWS }),
    prisma.appAction.count({ where: { toolkit } }),
  ]);
  // A row a person chose for stays a row even past the first 500: it is matched to the App's list when the list still has it
  const chosen = server.tools.filter((tool) => tool.setting !== null && !actions.some((action) => action.slug === tool.name));
  const chosenListed = chosen.length > 0 ? await prisma.appAction.findMany({ where: { toolkit, slug: { in: chosen.map((tool) => tool.name) } }, select: { slug: true, title: true, description: true, heading: true } }) : [];
  const wanted = [...actions, ...chosenListed].map((action) => ({
    name: action.slug,
    title: action.title,
    description: action.description,
    heading: action.heading,
    fingerprint: actionFingerprint(toolkit, action.slug),
  }));
  const byName = new Map(server.tools.map((tool) => [tool.name, tool]));
  const matches = (entry: (typeof wanted)[number]) => {
    const row = byName.get(entry.name);
    return (
      !!row &&
      row.fingerprint === entry.fingerprint &&
      row.title === entry.title &&
      row.description === entry.description &&
      row.heading === entry.heading &&
      row.suggestedHeading === entry.heading &&
      row.suggestionSource === 'builtIn' &&
      !!row.confirmedAt &&
      row.confirmedById === null &&
      row.movedById === null
    );
  };
  const names = new Set(wanted.map((entry) => entry.name));
  // A row the App's list no longer holds goes, unless a person chose for it: that choice stays (the action may come back)
  const gone = server.tools.filter((tool) => !names.has(tool.name) && tool.setting === null);
  const cut = total > MAX_ACTION_ROWS;
  const seen = cut ? total : null;
  const rowsUpToDate = gone.length === 0 && wanted.every(matches);

  try {
    await prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const fresh: Prisma.BotMcpToolCreateManyInput[] = [];
        for (const entry of wanted) {
          if (matches(entry)) continue;
          const data = {
            fingerprint: entry.fingerprint,
            title: entry.title,
            description: entry.description,
            suggestedHeading: entry.heading,
            suggestionSource: 'builtIn',
            heading: entry.heading,
            movedById: null,
            confirmedById: null,
          };
          const before = byName.get(entry.name);
          if (!before) {
            fresh.push({ serverId, name: entry.name, ...data, confirmedAt: now });
          } else {
            // The person's own choice (`setting`) is never touched here: only what Universe says the action is
            const written = await tx.botMcpTool.updateMany({
              where: { id: before.id, fingerprint: before.fingerprint, heading: before.heading, confirmedAt: before.confirmedAt },
              data: { ...data, confirmedAt: before.confirmedAt ?? now },
            });
            if (written.count !== 1) throw new StaleRows();
          }
        }
        // One statement for every new row (a first read makes up to 500): another call that made one of them first fails it, and this call reads again
        if (fresh.length > 0) await tx.botMcpTool.createMany({ data: fresh });
        if (gone.length > 0) await tx.botMcpTool.deleteMany({ where: { id: { in: gone.map((tool) => tool.id) }, setting: null } });
        const marked = await tx.botMcpServer.updateMany({
          where: { id: serverId, appActionsVersion: server.appActionsVersion },
          data: { legacyText: false, toolsCut: cut, toolsSeen: seen, appActionsVersion: catalog.version, ...(rowsUpToDate ? {} : { policyRevision: { increment: 1 } }) },
        });
        if (marked.count !== 1) throw new StaleRows();
        // Up to 500 rows written in one go, on a busy database: more time than the default five seconds
      },
      { maxWait: 15_000, timeout: 60_000 },
    );
  } catch (error) {
    if (attempt < 3 && (error instanceof StaleRows || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))) return ensureAppActionTools(serverId, attempt + 1);
    throw error;
  }
  return !rowsUpToDate || server.appActionsVersion === null;
}

/* ------------------------------ judging an action ------------------------------ */

export interface ActionVerdict {
  slug: string;
  /** Plain words for the action ("Fetch emails"), or the slug when the App's list does not have it. */
  title: string;
  heading: Heading;
  setting: Setting;
}

export interface ActionJudge {
  toolkit: string;
  judge(slug: string): ActionVerdict;
  /** Whether the App's list (or the grant) holds this action. */
  knows(slug: string): boolean;
}

const SETTINGS_SELECT = { lookUpSetting: true, makeSetting: true, changeSetting: true, deleteSendSetting: true } as const;

/**
 * How a grant judges each action of its App: the action's own choice, else its heading's setting. An action past the first 500 is
 * judged from the App's list; one the list does not have at all by its name, else as Deletes or sends out (and the list is read again
 * soon). Null when the Brick has no such grant, the grant is not a ready-made App's, or it was not brought over to App actions yet
 * (it then works as it did before).
 */
export async function actionJudgeFor(botId: string, connectionId: string): Promise<ActionJudge | null> {
  const grant = await prisma.botMcpServer.findFirst({ where: { botId, connectionId }, select: { id: true, appActionsVersion: true, connection: { select: { source: true, providerToolkit: true } } } });
  if (!grant || !holdsAppActions(grant)) return null;
  await ensureAppActionTools(grant.id);
  const server = await prisma.botMcpServer.findUnique({
    where: { id: grant.id },
    select: { ...SETTINGS_SELECT, toolsCut: true, tools: { select: { name: true, title: true, heading: true, setting: true } } },
  });
  if (!server) return null;
  const toolkit = grant.connection!.providerToolkit!.toLowerCase();
  const settings: Record<Heading, Setting> = {
    looksUp: server.lookUpSetting as Setting,
    makesNew: server.makeSetting as Setting,
    changesThings: server.changeSetting as Setting,
    deletesOrSends: server.deleteSendSetting as Setting,
  };
  const rows = new Map(server.tools.map((tool) => [slugKey(tool.name), tool]));
  // Past the rows: the App's own list, read only when the grant holds part of it
  const listed = server.toolsCut
    ? new Map((await prisma.appAction.findMany({ where: { toolkit }, select: { slug: true, title: true, heading: true } })).map((row) => [slugKey(row.slug), row]))
    : new Map<string, { slug: string; title: string; heading: string }>();
  let noted = false;
  return {
    toolkit,
    knows(slug: string): boolean {
      const key = slugKey(slug);
      return rows.has(key) || listed.has(key);
    },
    judge(slug: string): ActionVerdict {
      const key = slugKey(slug);
      const row = rows.get(key);
      if (row?.heading) {
        const heading = row.heading as Heading;
        return { slug, title: row.title ?? slug, heading, setting: effectiveSetting(row.setting as Setting | null, heading, settings) };
      }
      const known = listed.get(key);
      if (known) {
        const heading = known.heading as Heading;
        return { slug, title: known.title, heading, setting: settings[heading] };
      }
      if (!noted) {
        noted = true;
        void noteUnknownAction(toolkit);
      }
      const heading = nameRule(slug) ?? 'deletesOrSends';
      return { slug, title: slug, heading, setting: settings[heading] };
    },
  };
}
