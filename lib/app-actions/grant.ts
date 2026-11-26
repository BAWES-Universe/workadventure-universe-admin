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
 * heading's. A grant made before this is brought over the first time it is read: its heading settings stay, the meta tool rows go
 * (a move of one of them never meant anything), and nothing a person chose for an action is lost when the list is read again.
 *
 * A grant holds the first 500 actions in the App's order (MAX_TOOLS_PER_SERVER); any other action is judged from the App's list and
 * its heading's setting, never refused for being missing.
 */

export const MAX_ACTION_ROWS = 500;
/** How long a grant's first read waits for an App's list that was never read. */
const FIRST_READ_WAIT_MS = 3_000;

/** An action row's fingerprint: its identity is the App and the slug (the list's version is Orbit's, never a reason to ask again). */
export const actionFingerprint = (toolkit: string, slug: string): string => createHash('sha256').update(`app-action:${toolkit.toLowerCase()}:${slug}`).digest('hex');

/** Whether a grant's rows are an App's actions: a Brick's (or a bot's) grant of a ready-made App's connection. */
export const isAppActionsConnection = (connection: { source: string; providerToolkit: string | null } | null | undefined): connection is { source: 'ready_made'; providerToolkit: string } =>
  !!connection && connection.source === 'ready_made' && !!connection.providerToolkit;

/** A row changed between the read and the write of the same call: the whole call is read again. */
class StaleRows extends Error {}

const SERVER_SELECT = {
  id: true,
  legacyText: true,
  toolsCut: true,
  toolsSeen: true,
  connection: { select: { source: true, providerToolkit: true } },
  tools: { select: { id: true, name: true, title: true, description: true, fingerprint: true, heading: true, suggestedHeading: true, suggestionSource: true, confirmedAt: true, movedById: true, confirmedById: true } },
} as const;

/**
 * Makes a grant's rows match its App's list. Cheap when nothing changed; true when something did. Does nothing (false) for a grant that
 * is not a ready-made App's. Two calls at once are safe: a row is written only while it holds what was read, and the loser reads again.
 */
export async function ensureAppActionTools(serverId: string, attempt = 0): Promise<boolean> {
  const server = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: SERVER_SELECT });
  if (!server || !isAppActionsConnection(server.connection)) return false;
  const toolkit = server.connection.providerToolkit.toLowerCase();
  if (attempt === 0) await ensureAppActions(toolkit, FIRST_READ_WAIT_MS);
  const [actions, total] = await Promise.all([
    prisma.appAction.findMany({ where: { toolkit }, select: { slug: true, title: true, description: true, heading: true }, orderBy: [{ position: 'asc' }, { slug: 'asc' }], take: MAX_ACTION_ROWS }),
    prisma.appAction.count({ where: { toolkit } }),
  ]);
  const wanted = actions.map((action) => ({
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
  const cut = total > MAX_ACTION_ROWS;
  const seen = cut ? total : null;
  const rowsUpToDate = wanted.length === server.tools.length && wanted.every(matches);
  const serverUpToDate = !server.legacyText && server.toolsCut === cut && server.toolsSeen === seen;
  if (rowsUpToDate && serverUpToDate) return false;

  try {
    await prisma.$transaction(async (tx) => {
      const now = new Date();
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
          await tx.botMcpTool.create({ data: { serverId, name: entry.name, ...data, confirmedAt: now } });
        } else {
          // The person's own choice (`setting`) is never touched here: only what Universe says the action is
          const written = await tx.botMcpTool.updateMany({
            where: { id: before.id, fingerprint: before.fingerprint, heading: before.heading, confirmedAt: before.confirmedAt },
            data: { ...data, confirmedAt: before.confirmedAt ?? now },
          });
          if (written.count !== 1) throw new StaleRows();
        }
      }
      const names = new Set(wanted.map((entry) => entry.name));
      const gone = server.tools.filter((tool) => !names.has(tool.name));
      if (gone.length > 0) await tx.botMcpTool.deleteMany({ where: { id: { in: gone.map((tool) => tool.id) } } });
      await tx.botMcpServer.update({
        where: { id: serverId },
        data: { legacyText: false, toolsCut: cut, toolsSeen: seen, ...(rowsUpToDate ? {} : { policyRevision: { increment: 1 } }) },
      });
    });
  } catch (error) {
    if (attempt < 3 && (error instanceof StaleRows || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))) return ensureAppActionTools(serverId, attempt + 1);
    throw error;
  }
  return true;
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
}

const SETTINGS_SELECT = { lookUpSetting: true, makeSetting: true, changeSetting: true, deleteSendSetting: true } as const;

/**
 * How a grant judges each action of its App: the action's own choice, else its heading's setting. An action past the first 500 is
 * judged from the App's list; one the list does not have at all by its name, else as Deletes or sends out (and the list is read again
 * soon). Null when the Brick has no such grant, or the grant is not a ready-made App's.
 */
export async function actionJudgeFor(botId: string, connectionId: string): Promise<ActionJudge | null> {
  const grant = await prisma.botMcpServer.findFirst({ where: { botId, connectionId }, select: { id: true, connection: { select: { source: true, providerToolkit: true } } } });
  if (!grant || !isAppActionsConnection(grant.connection)) return null;
  await ensureAppActionTools(grant.id);
  const server = await prisma.botMcpServer.findUnique({
    where: { id: grant.id },
    select: { ...SETTINGS_SELECT, tools: { select: { name: true, title: true, heading: true, setting: true } } },
  });
  if (!server) return null;
  const toolkit = grant.connection.providerToolkit.toLowerCase();
  const settings: Record<Heading, Setting> = {
    looksUp: server.lookUpSetting as Setting,
    makesNew: server.makeSetting as Setting,
    changesThings: server.changeSetting as Setting,
    deletesOrSends: server.deleteSendSetting as Setting,
  };
  const rows = new Map(server.tools.map((tool) => [tool.name.toUpperCase(), tool]));
  // Past the rows: the App's own list, read only when a slug is not a row
  const listed = rows.size >= MAX_ACTION_ROWS ? new Map((await prisma.appAction.findMany({ where: { toolkit }, select: { slug: true, title: true, heading: true } })).map((row) => [row.slug.toUpperCase(), row])) : new Map<string, { slug: string; title: string; heading: string }>();
  let noted = false;
  return {
    toolkit,
    judge(slug: string): ActionVerdict {
      const key = slug.trim().toUpperCase();
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
