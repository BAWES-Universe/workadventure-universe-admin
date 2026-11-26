import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { Heading, Setting } from '@/lib/mcp-tool-policy';
import { ensureAppActions, noteUnknownAction } from '@/lib/app-actions/catalog';
import { effectiveSetting, nameRule, stricterHeading } from '@/lib/app-actions/sort';
import { GITHUB_ACTIONS_KEY, ownActionList, startsOn } from '@/lib/github/actions';

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
 * A grant holds the first 500 actions in the App's order (MAX_ACTION_ROWS); any other action is judged from the App's list and
 * its heading's setting, never refused for being missing.
 */

export const MAX_ACTION_ROWS = 500;
/** How long a grant's first read waits for an App's list that was never read. */
const FIRST_READ_WAIT_MS = 3_000;

/** An action row's fingerprint: its identity is the App and the slug (the list's version is Orbit's, never a reason to ask again). */
export const actionFingerprint = (toolkit: string, slug: string): string => createHash('sha256').update(`app-action:${toolkit.toLowerCase()}:${slug}`).digest('hex');

/** How a slug is matched: case, spaces and dashes never make one action two. */
export const slugKey = (slug: string): string => slug.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * Whether a grant's connection can hold an App's actions: a ready-made App's (its list from the provider), or Universe's own GitHub (its
 * list from Universe, lib/github/actions.ts).
 */
export const isAppActionsConnection = (connection: { source: string; providerToolkit: string | null } | null | undefined): boolean =>
  !!connection && ((connection.source === 'ready_made' && !!connection.providerToolkit) || connection.source === 'github');

/** The key a connection's list of actions is kept under (`app_actions.toolkit`): the provider's App name, or Universe's own GitHub's key. */
export const actionsKeyOf = (connection: { source: string; providerToolkit: string | null }): string =>
  connection.source === 'github' ? GITHUB_ACTIONS_KEY : (connection.providerToolkit ?? '').toLowerCase();

/** Whether a grant's rows are an App's actions now: a ready-made App's grant that was brought over. */
export const holdsAppActions = (server: { appActionsVersion: number | null; connection: { source: string; providerToolkit: string | null } | null }): boolean =>
  server.appActionsVersion !== null && isAppActionsConnection(server.connection);

/** A row changed between the read and the write of the same call: the whole call is read again. */
class StaleRows extends Error {}

const TOOL_SELECT = { id: true, name: true, title: true, description: true, fingerprint: true, heading: true, suggestedHeading: true, suggestionSource: true, confirmedAt: true, movedById: true, confirmedById: true, setting: true, settingByPerson: true } as const;
type ToolRow = Prisma.BotMcpToolGetPayload<{ select: typeof TOOL_SELECT }>;

const SETTING_ORDER: readonly Setting[] = ['rightAway', 'asksFirst', 'off'];
/** The stricter of two choices for one action (Off over Asks first over Right away); none is no choice. */
export function stricterSetting(a: Setting | null, b: Setting | null): Setting | null {
  if (a === null) return b;
  if (b === null) return a;
  return SETTING_ORDER.indexOf(b) > SETTING_ORDER.indexOf(a) ? b : a;
}

/**
 * The choice an action of Universe's own list holds when the person made none for it (lib/github/actions.ts: Run a workflow asks first):
 * its starting choice where that is stricter than its heading's setting, else none (it follows its heading). So it never makes the action
 * looser than its heading (a heading set Off keeps it Off), and never looser than its starting choice either, unless the person picks a
 * looser choice for that one action themselves.
 */
export function startingChoice(toolkit: string, slug: string, headingSetting: Setting): Setting | null {
  const start = startsOn(toolkit, slug);
  return start && start !== headingSetting && stricterSetting(start, headingSetting) === start ? start : null;
}

/**
 * Whether an action with a starting choice (Universe's own list) holds anything but what it should: the person made no choice for it
 * (its row is empty or holds the starting choice) and its heading moved since. Read outside a write, on every read of a grant brought over,
 * so a heading a person changes is followed at once.
 */
async function startingChoicesOff(serverId: string, toolkit: string): Promise<boolean> {
  const own = ownActionList(toolkit)?.filter((action) => action.startsOn);
  if (!own?.length) return false;
  const server = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: { ...SETTINGS_SELECT, tools: { where: { name: { in: own.map((action) => action.slug) }, settingByPerson: false }, select: { name: true, heading: true, setting: true } } } });
  if (!server) return false;
  const settings = settingsOfGrant(server);
  return server.tools.some((tool) => !!tool.heading && (tool.setting ?? null) !== startingChoice(toolkit, tool.name, settings[tool.heading as Heading]));
}

const settingsOfGrant = (server: { lookUpSetting: string; makeSetting: string; changeSetting: string; deleteSendSetting: string }): Record<Heading, Setting> => ({
  looksUp: server.lookUpSetting as Setting,
  makesNew: server.makeSetting as Setting,
  changesThings: server.changeSetting as Setting,
  deletesOrSends: server.deleteSendSetting as Setting,
});

/**
 * Holds one grant (its row in `bot_mcp_servers`) until the transaction ends. Bringing a grant over to App actions, the bot server's
 * list of tools and a person's change to a tool all take it first, so each sees the grant wholly before or wholly after another.
 */
export async function lockGrant(tx: Prisma.TransactionClient, serverId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS one FROM "bot_mcp_servers" WHERE "id" = ${serverId} FOR UPDATE`;
}

interface ListedAction {
  slug: string;
  title: string;
  description: string | null;
  heading: Heading;
}

/**
 * Brings a ready-made App's grant over to the App's actions, and keeps its rows matching the App's list. Cheap when the list did not
 * change since the last call (one small read). True when something changed. Does nothing (false) for a grant that is not a ready-made
 * App's, or while the App's list was never read (the grant keeps the rows it had).
 *
 * One action is one row: names that differ only in case, dashes or spaces (`slugKey`) are the same action, in the App's list and on
 * the grant. The row takes the name the App's list uses now, and when two rows were one action the strictest choice a person made
 * for it stays (Off is never lost to a new spelling).
 *
 * `force` runs the sync even when the grant already follows the App's list: for a grant found holding two rows for one action.
 *
 * The grant is held for the whole write (`lockGrant`), and the App's list too (read under a share lock, so a read of the provider
 * can't save between the rows, their count and the version stamped on the grant).
 */
export async function ensureAppActionTools(serverId: string, attempt = 0, force = false): Promise<boolean> {
  const head = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: { appActionsVersion: true, connection: { select: { source: true, providerToolkit: true } } } });
  if (!head?.connection || !isAppActionsConnection(head.connection)) return false;
  const toolkit = actionsKeyOf(head.connection);
  const catalog = await ensureAppActions(toolkit, attempt === 0 && head.appActionsVersion === null ? FIRST_READ_WAIT_MS : 0);
  // Never read (or Orbit could not check): the grant stays as it is, and the next read tries again
  if (!catalog?.refreshedAt) return false;
  // Up to date with the list: only an action whose starting choice no longer matches its heading (the person moved the heading) is synced
  if (!force && head.appActionsVersion === catalog.version && !(await startingChoicesOff(serverId, toolkit))) return false;
  if (head.appActionsVersion === catalog.version) force = true;

  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockGrant(tx, serverId);
        const listLock = await tx.$queryRaw<{ version: number; refreshed: boolean }[]>`
          SELECT "version", "refreshed_at" IS NOT NULL AS refreshed FROM "app_action_catalogs" WHERE "toolkit" = ${toolkit} FOR SHARE`;
        const version = listLock[0]?.version;
        if (version === undefined || !listLock[0].refreshed) return false;
        const server = await tx.botMcpServer.findUnique({
          where: { id: serverId },
          select: { appActionsVersion: true, lookUpSetting: true, makeSetting: true, changeSetting: true, deleteSendSetting: true, tools: { select: TOOL_SELECT } },
        });
        // Gone, or brought up to this list by another call while this one waited for the grant
        if (!server || (!force && server.appActionsVersion === version)) return false;

        // The App's list, one entry per action: the first spelling in the App's order names it, and it goes under the strictest heading any spelling has
        const order = await tx.appAction.findMany({ where: { toolkit }, select: { slug: true, heading: true }, orderBy: [{ position: 'asc' }, { slug: 'asc' }] });
        const firstSlug = new Map<string, string>();
        const headingOf = new Map<string, Heading>();
        for (const row of order) {
          const key = slugKey(row.slug);
          if (!firstSlug.has(key)) firstSlug.set(key, row.slug);
          const before = headingOf.get(key);
          headingOf.set(key, before ? stricterHeading(before, row.heading as Heading) : (row.heading as Heading));
        }
        const keys = [...firstSlug.keys()];
        const groups = new Map<string, ToolRow[]>();
        for (const tool of server.tools) {
          const key = slugKey(tool.name);
          groups.set(key, [...(groups.get(key) ?? []), tool]);
        }
        // The first 500, and past them any action a person chose for (its choice stays a row)
        const held = keys.slice(0, MAX_ACTION_ROWS);
        const chosenPast = keys.slice(MAX_ACTION_ROWS).filter((key) => groups.get(key)?.some((tool) => tool.setting !== null));
        const wantedKeys = [...held, ...chosenPast];
        const details = await tx.appAction.findMany({ where: { toolkit, slug: { in: wantedKeys.map((key) => firstSlug.get(key)!) } }, select: { slug: true, title: true, description: true } });
        const detailOf = new Map(details.map((row) => [row.slug, row]));
        const wanted: (ListedAction & { key: string; fingerprint: string })[] = wantedKeys.map((key) => {
          const slug = firstSlug.get(key)!;
          const detail = detailOf.get(slug);
          return { key, slug, title: detail?.title ?? slug, description: detail?.description ?? null, heading: headingOf.get(key)!, fingerprint: actionFingerprint(toolkit, slug) };
        });

        // Brought over for the first time: the rows were the tools a bot server read, judged by the headings a person or the bot server
        // put them under. Where that judged one stricter than its new heading does, the stricter choice stays as the action's own choice,
        // so nothing a person set gets looser by moving (a tool they had under a heading set Off stays Off)
        const firstTime = server.appActionsVersion === null;
        const settings: Record<Heading, Setting> = {
          looksUp: server.lookUpSetting as Setting,
          makesNew: server.makeSetting as Setting,
          changesThings: server.changeSetting as Setting,
          deletesOrSends: server.deleteSendSetting as Setting,
        };
        const carried = (rows: readonly ToolRow[], heading: Heading, own: Setting | null): Setting | null => {
          if (!firstTime) return own;
          const current = effectiveSetting(own, heading, settings);
          const before = rows.reduce<Setting | null>((acc, tool) => {
            const old = (tool.heading ?? tool.suggestedHeading) as Heading | null;
            return old ? stricterSetting(acc, settings[old]) : acc;
          }, null);
          return before !== null && stricterSetting(current, before) !== current ? before : own;
        };

        const now = new Date();
        const fresh: Prisma.BotMcpToolCreateManyInput[] = [];
        const drop: string[] = [];
        let rowsUpToDate = true;
        const wantedSet = new Set(wantedKeys);
        for (const entry of wanted) {
          const rows = groups.get(entry.key) ?? [];
          // The row that stays: the one already named as the App names it now, else the one with the strictest choice
          const keeper = rows.find((tool) => tool.name === entry.slug) ?? rows.reduce<ToolRow | undefined>((best, tool) => (!best || stricterSetting(best.setting as Setting | null, tool.setting as Setting | null) !== best.setting ? tool : best), undefined);
          // The person's strictest choice for it. An action Universe starts on its own choice (own lists: Run a workflow asks first) holds
          // that choice while the person made none (or left it as it started), only where it is stricter than its heading. Then never looser
          // than what it was judged by before it was brought over
          // (An action Universe starts on its own choice counts only what a person chose: Universe's start is worked out again here.)
          const start = startsOn(toolkit, entry.slug);
          const persons = start ? rows.filter((tool) => tool.settingByPerson) : rows;
          const chosen = persons.reduce<Setting | null>((acc, tool) => stricterSetting(acc, tool.setting as Setting | null), null);
          const byPerson = chosen !== null && rows.some((tool) => tool.settingByPerson && tool.setting !== null);
          const own = start && chosen === null ? startingChoice(toolkit, entry.slug, settings[entry.heading]) : chosen;
          const setting = carried(rows, entry.heading, own);
          // A stricter choice carried from before the grant was brought over is the person's too (it is what their older headings said)
          const settingByPerson = setting !== null && ((byPerson && setting === chosen) || (firstTime && setting !== own));
          for (const tool of rows) if (tool !== keeper) drop.push(tool.id);
          const data = {
            name: entry.slug,
            fingerprint: entry.fingerprint,
            title: entry.title,
            description: entry.description,
            suggestedHeading: entry.heading,
            suggestionSource: 'builtIn',
            heading: entry.heading,
            movedById: null,
            confirmedById: null,
          };
          if (!keeper) {
            fresh.push({ serverId, ...data, setting, settingByPerson, confirmedAt: now });
            rowsUpToDate = false;
            continue;
          }
          const same =
            rows.length === 1 &&
            keeper.name === data.name &&
            keeper.fingerprint === data.fingerprint &&
            keeper.title === data.title &&
            keeper.description === data.description &&
            keeper.heading === data.heading &&
            keeper.suggestedHeading === data.suggestedHeading &&
            keeper.suggestionSource === data.suggestionSource &&
            !!keeper.confirmedAt &&
            keeper.confirmedById === null &&
            keeper.movedById === null &&
            (keeper.setting ?? null) === setting &&
            keeper.settingByPerson === settingByPerson;
          if (same) continue;
          rowsUpToDate = false;
          // Only what Universe says the action is, its name as the App spells it now, and the person's strictest choice for it
          const written = await tx.botMcpTool.updateMany({
            where: { id: keeper.id, fingerprint: keeper.fingerprint, heading: keeper.heading, confirmedAt: keeper.confirmedAt },
            data: { ...data, setting, settingByPerson, confirmedAt: keeper.confirmedAt ?? now },
          });
          if (written.count !== 1) throw new StaleRows();
        }
        // An action the App's list no longer holds goes, unless a person chose for it: that choice stays (the action may come back), one row for it
        for (const [key, rows] of groups) {
          if (wantedSet.has(key)) continue;
          const chosen = rows.filter((tool) => tool.setting !== null);
          if (chosen.length === 0) {
            drop.push(...rows.map((tool) => tool.id));
            continue;
          }
          const setting = chosen.reduce<Setting | null>((acc, tool) => stricterSetting(acc, tool.setting as Setting | null), null);
          const keeper = chosen.find((tool) => tool.setting === setting)!;
          const others = rows.filter((tool) => tool !== keeper);
          drop.push(...others.map((tool) => tool.id));
        }
        if (drop.length > 0) {
          rowsUpToDate = false;
          await tx.botMcpTool.deleteMany({ where: { id: { in: drop } } });
        }
        // One statement for every new row (a first read makes up to 500)
        if (fresh.length > 0) await tx.botMcpTool.createMany({ data: fresh });
        const cut = keys.length > MAX_ACTION_ROWS;
        const marked = await tx.botMcpServer.updateMany({
          where: { id: serverId, appActionsVersion: server.appActionsVersion },
          data: { legacyText: false, toolsCut: cut, toolsSeen: cut ? keys.length : null, appActionsVersion: version, ...(rowsUpToDate ? {} : { policyRevision: { increment: 1 } }) },
        });
        if (marked.count !== 1) throw new StaleRows();
        return !rowsUpToDate || server.appActionsVersion === null;
      },
      // Up to 500 rows written in one go, on a busy database: more time than the default five seconds
      { maxWait: 15_000, timeout: 60_000 },
    );
  } catch (error) {
    if (attempt < 3 && (error instanceof StaleRows || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))) return ensureAppActionTools(serverId, attempt + 1, force);
    throw error;
  }
}

/** Whether a grant holds two rows for one action (names that differ only in case, dashes or spaces). */
export const hasDuplicateActions = (tools: readonly { name: string }[]): boolean => new Set(tools.map((tool) => slugKey(tool.name))).size !== tools.length;

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
  const load = () =>
    prisma.botMcpServer.findUnique({
      where: { id: grant.id },
      select: { ...SETTINGS_SELECT, toolsCut: true, tools: { select: { name: true, title: true, heading: true, setting: true, settingByPerson: true } } },
    });
  let server = await load();
  if (!server) return null;
  // Two rows for one action (never made by the sync; only data from before it): they are made one now, even with nothing new in the App's list
  if (hasDuplicateActions(server.tools)) {
    await ensureAppActionTools(grant.id, 0, true);
    server = await load();
    if (!server) return null;
  }
  const toolkit = actionsKeyOf(grant.connection!);
  const settings: Record<Heading, Setting> = {
    looksUp: server.lookUpSetting as Setting,
    makesNew: server.makeSetting as Setting,
    changesThings: server.changeSetting as Setting,
    deletesOrSends: server.deleteSendSetting as Setting,
  };
  // One action per name however it is spelled (case, dashes, spaces): when two rows or two entries of the list are the same action
  // (a sync that has not run yet), the strictest of them judges it, so a person's Off is never lost to another spelling
  const rows = new Map<string, { title: string; heading: Heading; setting: Setting }>();
  for (const tool of server.tools) {
    if (!tool.heading) continue;
    const heading = tool.heading as Heading;
    // A row with no choice of its own: an action Universe starts on its own choice (Run a workflow asks first) is judged by it here too,
    // so a heading moved since the rows were last brought up to date never makes it looser for a moment
    // Universe's starting choice is worked out from the heading read with it (never the one saved before the heading last moved); a
    // person's choice is theirs as saved
    const own = startsOn(toolkit, tool.name) && !tool.settingByPerson ? startingChoice(toolkit, tool.name, settings[heading]) : (tool.setting as Setting | null);
    const verdict = { title: tool.title ?? tool.name, heading, setting: effectiveSetting(own, heading, settings) };
    const key = slugKey(tool.name);
    const before = rows.get(key);
    rows.set(key, before ? { title: before.title, heading: stricterHeading(before.heading, heading), setting: stricterSetting(before.setting, verdict.setting)! } : verdict);
  }
  // Past the rows: the App's own list, read only when the grant holds part of it
  const listed = new Map<string, { title: string; heading: Heading }>();
  if (server.toolsCut) {
    for (const row of await prisma.appAction.findMany({ where: { toolkit }, select: { slug: true, title: true, heading: true }, orderBy: [{ position: 'asc' }, { slug: 'asc' }] })) {
      const key = slugKey(row.slug);
      const before = listed.get(key);
      listed.set(key, before ? { title: before.title, heading: stricterHeading(before.heading, row.heading as Heading) } : { title: row.title, heading: row.heading as Heading });
    }
  }
  let noted = false;
  return {
    toolkit,
    knows(slug: string): boolean {
      const key = slugKey(slug);
      return rows.has(key) || listed.has(key) || !!ownActionList(toolkit)?.some((action) => slugKey(action.slug) === key);
    },
    judge(slug: string): ActionVerdict {
      const key = slugKey(slug);
      const row = rows.get(key);
      if (row) return { slug, ...row };
      const known = listed.get(key);
      if (known) return { slug, title: known.title, heading: known.heading, setting: startingChoice(toolkit, slug, settings[known.heading]) ?? settings[known.heading] };
      // Universe's own list knows it even when the saved list does not have it yet (a release's new action, before its list is saved)
      const ownAction = ownActionList(toolkit)?.find((action) => slugKey(action.slug) === key);
      if (ownAction) return { slug, title: ownAction.title, heading: ownAction.heading, setting: startingChoice(toolkit, ownAction.slug, settings[ownAction.heading]) ?? settings[ownAction.heading] };
      if (!noted) {
        noted = true;
        void noteUnknownAction(toolkit);
      }
      const heading = nameRule(slug) ?? 'deletesOrSends';
      return { slug, title: slug, heading, setting: settings[heading] };
    },
  };
}
