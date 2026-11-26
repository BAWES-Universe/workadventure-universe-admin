import { ensureKeyAppTools } from '@/lib/app-direct/policy';
import { ensureAppActionTools, hasDuplicateActions, holdsAppActions, lockGrant } from '@/lib/app-actions/grant';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { BotSettingsError } from '@/lib/bot-access-settings';

/**
 * What a bot may do with each tool of an MCP server (#738). Tools sit under four headings by what they do; each
 * heading has one setting per server (Right away, Asks first or Off); a tool is only a suggestion until someone with
 * Manage bots confirms it, and a tool that changes goes back to not confirmed yet. The bot server fills the tool list;
 * the game's bot page reads it, moves tools and confirms them. A policy revision goes up with every change, so a card or
 * a remembered approval made under an older policy can be told apart.
 *
 * A server that existed before tools were checked is "Not checked yet" (`legacyText`): it keeps working in text as it
 * does until its tools are confirmed.
 */
export const HEADINGS = ['looksUp', 'makesNew', 'changesThings', 'deletesOrSends'] as const;
export type Heading = (typeof HEADINGS)[number];

export const SETTINGS = ['rightAway', 'asksFirst', 'off'] as const;
export type Setting = (typeof SETTINGS)[number];

/** Defaults for a new server: looking up and making new things run, changing and deleting or sending ask first. */
export const DEFAULT_SETTINGS: Record<Heading, Setting> = {
  looksUp: 'rightAway',
  makesNew: 'rightAway',
  changesThings: 'asksFirst',
  deletesOrSends: 'asksFirst',
};

const SETTING_COLUMN = {
  looksUp: 'lookUpSetting',
  makesNew: 'makeSetting',
  changesThings: 'changeSetting',
  deletesOrSends: 'deleteSendSetting',
} as const;

export const SUGGESTION_SOURCES = ['server', 'description', 'builtIn'] as const;

/** Asks before making more than this many things in one request. null is no limit. */
export const ASK_BEFORE_MAKING = [3, 5, 10, null] as const;
export const ASK_WHICH_WAY = ['rarely', 'beforeBiggerJobs', 'never'] as const;
export const CARD_WAIT_MINUTES = [5, 10, 30] as const;

export const TITLE_MAX = 255;
export const DESCRIPTION_MAX = 2000;
/**
 * More tools than any server offers; stops a runaway script from filling the table. The bot server keeps the same number
 * (MAX_TOOLS_PER_SERVER in bots/mcp/ToolCatalog.ts of the game repo), so its list and this one stay identical. A server
 * that has more is saved as cut, never silently shortened (see `truncated` below).
 */
export const MAX_TOOLS_PER_SERVER = 500;
/** The most tools a server can be said to have; only shown to people. */
export const MAX_TOTAL_SEEN = 1_000_000;

const headingSchema = z.enum(HEADINGS);
const settingSchema = z.enum(SETTINGS);

/** The bot server's full tool list for one server, as it read it. */
export const catalogSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(255),
            title: z.string().max(1000).nullish(),
            description: z.string().max(100_000).nullish(),
            fingerprint: z.string().min(1).max(128),
            suggestedHeading: headingSchema.nullish(),
            suggestionSource: z.enum(SUGGESTION_SOURCES).nullish(),
          })
          .strict()
          .refine((tool) => !tool.suggestedHeading === !tool.suggestionSource, {
            message: 'A suggested heading and where it came from go together',
          }),
      )
      .max(MAX_TOOLS_PER_SERVER),
    /**
     * True when the server has more tools than the bot server keeps, so `tools` is its first 500 and not all of them.
     * Optional: a bot server that does not know about it sends neither field, and the server is then saved as not cut.
     */
    truncated: z.boolean().optional(),
    /** How many tools the server has, when the bot server read them all. Left out when it did not (more pages were left). */
    totalSeen: z.number().int().min(0).max(MAX_TOTAL_SEEN).optional(),
  })
  .strict()
  .refine((body) => new Set(body.tools.map((tool) => tool.name)).size === body.tools.length, { message: 'Each tool name once' })
  .refine((body) => body.totalSeen === undefined || body.truncated === true, { message: 'A count of tools goes with a cut list' });

export const moveSchema = z.object({ heading: headingSchema }).strict();

/** An App action's own choice over its heading's; null follows the heading again. */
export const toolSettingSchema = z.object({ setting: settingSchema.nullable() }).strict();

/** PATCH .../tools/:toolId takes one of the two: a move under another heading (a bot's own server), or an App action's own choice. */
export const toolPatchSchema = z.union([moveSchema, toolSettingSchema]);

export const confirmSchema = z
  .object({
    toolIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_TOOLS_PER_SERVER).optional(),
    /** The policy revision the page showed: if the tools moved since, nothing is confirmed. */
    policyRevision: z.number().int().min(0).optional(),
  })
  .strict();

export const serverSettingsSchema = z
  .object({
    looksUp: settingSchema.optional(),
    makesNew: settingSchema.optional(),
    changesThings: settingSchema.optional(),
    deletesOrSends: settingSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export const botToolSettingsSchema = z
  .object({
    askBeforeMaking: z.union([z.literal(3), z.literal(5), z.literal(10), z.null()]).optional(),
    askWhichWay: z.enum(ASK_WHICH_WAY).optional(),
    cardWaitMinutes: z.union([z.literal(5), z.literal(10), z.literal(30)]).optional(),
    allowMoreIdleMinutes: z.union([z.literal(30), z.literal(60), z.literal(120)]).optional(),
    allowMoreMaxMinutes: z.union([z.literal(240), z.literal(480), z.literal(1440)]).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export type ToolsState = 'notCheckedYet' | 'notConfirmedYet' | 'confirmed';

/**
 * What a server's rows are. `tools`: a bot's own server, its tools as the bot server read them, each confirmed and moved by people.
 * `appActions`: a ready-made App's grant, its rows are the App's actions as Universe sorted them (lib/app-actions): nothing to confirm,
 * no moving between headings, and each may carry its own choice (`setting`) over its heading's.
 */
export type ServerKind = 'tools' | 'appActions';

export interface ToolJson {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  fingerprint: string;
  suggestedHeading: Heading | null;
  suggestionSource: (typeof SUGGESTION_SOURCES)[number] | null;
  /** What a person chose, or accepted from the suggestion. Null until then. */
  heading: Heading | null;
  state: 'confirmed' | 'notConfirmedYet';
  /** Their names only, people's emails are private. */
  confirmedBy: { name: string | null } | null;
  confirmedAt: string | null;
  movedBy: { name: string | null } | null;
  /** An App action's own choice over its heading's (Right away, Asks first or Off). Null follows the heading; always null on a bot's own server. */
  setting: Setting | null;
}

export interface ServerToolsJson {
  serverId: string;
  kind: ServerKind;
  /** Not checked yet: an old server that works as it did. Not confirmed yet: tools wait. Confirmed: every tool is. */
  state: ToolsState;
  policyRevision: number;
  settings: Record<Heading, Setting>;
  tools: ToolJson[];
  /** The server has more tools than are listed here (the bot server keeps the first 500). Plain text for people: "Showing the first 500 of N tools". */
  truncated: boolean;
  /** How many tools the server has, when the bot server knew; null when it only knew there were more. */
  totalSeen: number | null;
}

const TOOL_SELECT = {
  id: true,
  name: true,
  title: true,
  description: true,
  fingerprint: true,
  suggestedHeading: true,
  suggestionSource: true,
  heading: true,
  confirmedAt: true,
  confirmedBy: { select: { name: true } },
  movedBy: { select: { name: true } },
  setting: true,
} as const;

type ToolRow = Prisma.BotMcpToolGetPayload<{ select: typeof TOOL_SELECT }>;

const SERVER_SELECT = {
  id: true,
  botId: true,
  legacyText: true,
  lookUpSetting: true,
  makeSetting: true,
  changeSetting: true,
  deleteSendSetting: true,
  policyRevision: true,
  toolsCut: true,
  toolsSeen: true,
  appActionsVersion: true,
  connection: { select: { source: true, providerToolkit: true } },
} as const;

type ServerRow = Prisma.BotMcpServerGetPayload<{ select: typeof SERVER_SELECT }>;

const toToolJson = (row: ToolRow): ToolJson => ({
  id: row.id,
  name: row.name,
  title: row.title,
  description: row.description,
  fingerprint: row.fingerprint,
  suggestedHeading: row.suggestedHeading as Heading | null,
  suggestionSource: row.suggestionSource as ToolJson['suggestionSource'],
  heading: row.heading as Heading | null,
  state: row.confirmedAt ? 'confirmed' : 'notConfirmedYet',
  confirmedBy: row.confirmedAt ? { name: row.confirmedBy?.name ?? null } : null,
  confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
  movedBy: row.movedBy ? { name: row.movedBy.name } : null,
  setting: (row.setting as Setting | null) ?? null,
});

const kindOf = (server: Pick<ServerRow, 'connection' | 'appActionsVersion'>): ServerKind => (holdsAppActions(server) ? 'appActions' : 'tools');

export function settingsOf(server: Pick<ServerRow, 'lookUpSetting' | 'makeSetting' | 'changeSetting' | 'deleteSendSetting'>): Record<Heading, Setting> {
  return {
    looksUp: server.lookUpSetting as Setting,
    makesNew: server.makeSetting as Setting,
    changesThings: server.changeSetting as Setting,
    deletesOrSends: server.deleteSendSetting as Setting,
  };
}

/** What a server's tools say about it as a whole. */
export function toolsState(legacyText: boolean, tools: readonly { state: 'confirmed' | 'notConfirmedYet' }[]): ToolsState {
  if (legacyText) return 'notCheckedYet';
  return tools.length > 0 && tools.every((tool) => tool.state === 'confirmed') ? 'confirmed' : 'notConfirmedYet';
}

async function loadServer(db: Prisma.TransactionClient | typeof prisma, botId: string, serverId: string): Promise<ServerRow> {
  const server = await db.botMcpServer.findUnique({ where: { id: serverId }, select: SERVER_SELECT });
  if (!server || server.botId !== botId) throw new BotSettingsError(404, 'App not found');
  return server;
}

/**
 * The server and its tools as one answer: its kind says how to read its rows, so both must come from the same moment. Inside a write
 * the grant is held (`lockGrant`); a plain read takes one snapshot of the database for both (`describeNow`).
 */
async function describe(db: Prisma.TransactionClient, serverId: string): Promise<ServerToolsJson> {
  const server = await db.botMcpServer.findUniqueOrThrow({ where: { id: serverId }, select: SERVER_SELECT });
  const rows = await db.botMcpTool.findMany({ where: { serverId }, select: TOOL_SELECT, orderBy: [{ name: 'asc' }] });
  const tools = rows.map(toToolJson);
  return {
    serverId,
    kind: kindOf(server),
    state: toolsState(server.legacyText, tools),
    policyRevision: server.policyRevision,
    settings: settingsOf(server),
    tools,
    truncated: server.toolsCut,
    totalSeen: server.toolsCut ? server.toolsSeen : null,
  };
}

/** A server and its tools read outside a write: one snapshot, so a grant brought over in between is never half seen. */
const describeNow = (serverId: string): Promise<ServerToolsJson> =>
  prisma.$transaction((tx) => describe(tx, serverId), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

const bump = { policyRevision: { increment: 1 } } as const;
/**
 * A write that holds a grant may wait for it behind one that is bringing the grant over (which itself may wait for the App's list
 * while a read of the provider saves it): more time than the default five seconds, the same as that write allows.
 */
const GRANT_WRITE = { maxWait: 15_000, timeout: 60_000 } as const;

export interface ReadToolsOptions {
  /**
   * The reader knows App actions (the bot server's and the game's `?actions=1`): a ready-made App's grant is brought over to its
   * actions here. A reader that does not ask keeps seeing the grant as it was until a reader that asks brought it over.
   */
  appActions?: boolean;
}

/** One server's tools, their settings and state. */
export async function readServerTools(botId: string, serverId: string, options: ReadToolsOptions = {}): Promise<ServerToolsJson> {
  const server = await loadServer(prisma, botId, serverId);
  // A key app's operations are its tools (game #2044): they are made to match its definition before they are read, so the gate never sees a stale list
  await ensureKeyAppTools(serverId);
  // A ready-made App's actions are its rows: made to match the App's list before they are read (a grant brought over stays current for every reader)
  if (options.appActions || holdsAppActions(server)) await ensureAppActionTools(serverId);
  const described = await describeNow(serverId);
  // Two rows for one action (only data from before one row per action): made one before anyone sees them
  if (described.kind === 'appActions' && hasDuplicateActions(described.tools)) {
    await ensureAppActionTools(serverId, 0, true);
    return describeNow(serverId);
  }
  return described;
}

export interface CatalogResult extends ServerToolsJson {
  /** Tools that were not there before. */
  added: string[];
  /** Confirmed or chosen tools that changed and went back to not confirmed yet. */
  changed: string[];
  /** Tools the server no longer offers. */
  removed: string[];
}

/**
 * Replace a server's tool list with what the bot server just read. A new tool waits to be confirmed. A tool whose
 * fingerprint is different goes back to not confirmed yet, with its heading cleared, and only that tool does. A tool the
 * server no longer offers is removed. When the list is cut (the server has more tools than the bot server keeps, so a tool
 * missing from it may still be there) only a tool nobody confirmed or moved is removed, and the decided ones stay. Its suggestion is only a suggestion and never lets it run. It also saves whether the
 * list is cut; a bot server that does not say leaves it "not cut".
 */
export async function syncCatalog(botId: string, serverId: string, body: z.infer<typeof catalogSchema>): Promise<CatalogResult> {
  return prisma.$transaction(async (tx) => {
    // Held first: a grant brought over to App actions at the same moment is either wholly before this list or wholly after it
    await lockGrant(tx, serverId);
    const server = await loadServer(tx, botId, serverId);
    // A ready-made App's rows are its actions, made by Orbit from the App's list: what the bot server read on the App's link (the
    // provider's meta tools) never replaces them. Answered as saved, with nothing changed.
    if (kindOf(server) === 'appActions') return { ...(await describe(tx, serverId)), added: [], changed: [], removed: [] };
    const existing = await tx.botMcpTool.findMany({
      where: { serverId },
      select: { id: true, name: true, fingerprint: true, confirmedAt: true, heading: true, movedById: true, suggestedHeading: true, suggestionSource: true },
    });
    const byName = new Map(existing.map((tool) => [tool.name, tool]));
    const added: string[] = [];
    const changed: string[] = [];
    // Any tool whose fingerprint is different, confirmed or not: a list a person opened before it changed is out of date
    let reworded = false;

    for (const tool of body.tools) {
      const shown = {
        title: tool.title ? tool.title.slice(0, TITLE_MAX) : null,
        description: tool.description ? tool.description.slice(0, DESCRIPTION_MAX) : null,
      };
      const suggestion = { suggestedHeading: tool.suggestedHeading ?? null, suggestionSource: tool.suggestionSource ?? null };
      const before = byName.get(tool.name);
      if (!before) {
        await tx.botMcpTool.create({ data: { serverId, name: tool.name, fingerprint: tool.fingerprint, ...shown, ...suggestion } });
        added.push(tool.name);
      } else if (before.fingerprint !== tool.fingerprint) {
        await tx.botMcpTool.update({
          where: { id: before.id },
          data: { fingerprint: tool.fingerprint, ...shown, ...suggestion, heading: null, movedById: null, confirmedById: null, confirmedAt: null },
        });
        reworded = true;
        if (before.confirmedAt || before.heading) changed.push(tool.name);
      } else {
        // Same tool: its words may be shown a little differently, but nothing a person decided moves. A suggestion only
        // follows the server while nobody has confirmed the tool; when it is what Confirm would use (no heading chosen), a
        // page that showed the old one is out of date
        if (!before.confirmedAt && !before.heading && (before.suggestedHeading !== suggestion.suggestedHeading || before.suggestionSource !== suggestion.suggestionSource)) {
          reworded = true;
        }
        await tx.botMcpTool.update({ where: { id: before.id }, data: before.confirmedAt ? shown : { ...shown, ...suggestion } });
      }
    }

    // A cut list is only the first 500 of what the server has, so a tool missing from it may still be there: one that a
    // person confirmed or moved stays. A leftover nobody decided on goes, so it can't block confirming the real list.
    const cut = body.truncated === true;
    const offered = new Set(body.tools.map((tool) => tool.name));
    const decided = (tool: (typeof existing)[number]) => !!tool.confirmedAt || !!tool.heading || !!tool.movedById;
    const removed = existing.filter((tool) => !offered.has(tool.name) && !(cut && decided(tool)));
    if (removed.length > 0) await tx.botMcpTool.deleteMany({ where: { id: { in: removed.map((tool) => tool.id) } } });

    if (added.length > 0 || changed.length > 0 || removed.length > 0 || reworded) {
      await tx.botMcpServer.update({ where: { id: serverId }, data: bump });
    }
    // Whether the list is the whole server or its first 500 is not a policy: it moves no revision and confirms nothing
    const seen = cut ? (body.totalSeen ?? null) : null;
    if (server.toolsCut !== cut || server.toolsSeen !== seen) {
      await tx.botMcpServer.update({ where: { id: serverId }, data: { toolsCut: cut, toolsSeen: seen } });
    }
    return { ...(await describe(tx, serverId)), added, changed, removed: removed.map((tool) => tool.name) };
  }, GRANT_WRITE);
}

export const APP_ACTIONS_DONT_MOVE = 'An App’s actions stay under their heading. Give this one its own choice instead';

/**
 * An App action's own choice over its heading's (Right away, Asks first or Off), or null to follow the heading again. Only on a
 * ready-made App's grant (409 on a bot's own server). The policy revision goes up when it changes, so a card or a remembered approval
 * made under the older choice can be told apart.
 */
export async function setToolSetting(botId: string, serverId: string, toolId: string, setting: Setting | null): Promise<ServerToolsJson> {
  const before = await loadServer(prisma, botId, serverId);
  // Kept matching the App's list first. Only a grant already brought over (by a reader that asked for App actions): a choice never
  // brings one over itself, so a refused one (an id that is not there) leaves the grant exactly as it was
  if (holdsAppActions(before)) await ensureAppActionTools(serverId);
  return prisma.$transaction(async (tx) => {
    await lockGrant(tx, serverId);
    const server = await loadServer(tx, botId, serverId);
    if (kindOf(server) !== 'appActions') throw new BotSettingsError(409, 'Only an App’s actions take their own choice');
    const tool = await tx.botMcpTool.findUnique({ where: { id: toolId }, select: { serverId: true, setting: true, settingByPerson: true } });
    if (!tool || tool.serverId !== serverId) throw new BotSettingsError(404, 'Tool not found');
    // Marked as the person's, even when it is the choice Universe started the action on: from now on it is theirs and never moves
    const byPerson = setting !== null;
    if ((tool.setting ?? null) !== setting || tool.settingByPerson !== byPerson) {
      await tx.botMcpTool.update({ where: { id: toolId }, data: { setting, settingByPerson: byPerson } });
      await tx.botMcpServer.update({ where: { id: serverId }, data: bump });
    }
    return describe(tx, serverId);
  }, GRANT_WRITE);
}

/** A tool the server changed while a person was looking at it: what they saw is not what is there now. */
const TOOL_CHANGED = 'This tool changed, review it again';

/**
 * Move one tool under another heading. If it was confirmed it stays confirmed, now by the person who moved it; if not,
 * it still waits to be confirmed.
 */
export async function moveTool(botId: string, serverId: string, toolId: string, heading: Heading, personId: string): Promise<ServerToolsJson> {
  return prisma.$transaction(async (tx) => {
    await lockGrant(tx, serverId);
    const server = await loadServer(tx, botId, serverId);
    const tool = await tx.botMcpTool.findUnique({ where: { id: toolId }, select: { id: true, serverId: true, fingerprint: true, heading: true, confirmedAt: true } });
    if (!tool || tool.serverId !== serverId) throw new BotSettingsError(404, 'Tool not found');
    // An App's actions stay where Universe sorted them (Send email can never be filed under Looks things up): their own choice replaces a move
    if (kindOf(server) === 'appActions') throw new BotSettingsError(409, APP_ACTIONS_DONT_MOVE);
    if (tool.heading !== heading) {
      // Only the tool as it was read: a sync that changed it in between has cleared its heading and confirmation, and
      // this must not put the old ones back; nor must it overwrite a confirm or another move that landed in between
      const moved = await tx.botMcpTool.updateMany({
        where: { id: toolId, fingerprint: tool.fingerprint, heading: tool.heading, confirmedAt: tool.confirmedAt },
        data: { heading, movedById: personId, ...(tool.confirmedAt ? { confirmedById: personId, confirmedAt: new Date() } : {}) },
      });
      if (moved.count === 0) throw new BotSettingsError(409, TOOL_CHANGED);
      await tx.botMcpServer.update({ where: { id: serverId }, data: bump });
    }
    return describe(tx, serverId);
  }, GRANT_WRITE);
}

/**
 * Confirm tools: all of the server's, or the ones listed. Each takes the heading someone chose, or else the one that
 * was suggested. A tool with neither can't be confirmed, and then nothing is. When every tool is confirmed, a server
 * that was Not checked yet is checked. When the caller names the policy revision its page showed and the server's has
 * moved, nothing is confirmed (409).
 */
export async function confirmTools(
  botId: string,
  serverId: string,
  personId: string,
  toolIds?: string[],
  seenRevision?: number,
): Promise<ServerToolsJson> {
  return prisma.$transaction(async (tx) => {
    await lockGrant(tx, serverId);
    const server = await loadServer(tx, botId, serverId);
    // An App's actions are confirmed by Universe when they are made: there is nothing for a person to confirm (no review gate on Apps)
    if (kindOf(server) === 'appActions') return describe(tx, serverId);
    // The page names the list it showed: a sync or another person's change since then means it is not the list to confirm
    if (seenRevision !== undefined && seenRevision !== server.policyRevision) throw new BotSettingsError(409, TOOL_CHANGED);
    const all = await tx.botMcpTool.findMany({
      where: { serverId },
      select: { id: true, name: true, fingerprint: true, heading: true, suggestedHeading: true, confirmedAt: true },
    });
    if (all.length === 0) throw new BotSettingsError(409, 'This server has no tools to confirm yet. Test the server first');
    const wanted = toolIds ? new Set(toolIds) : null;
    if (wanted && all.filter((tool) => wanted.has(tool.id)).length !== wanted.size) throw new BotSettingsError(404, 'Tool not found');

    const todo = all.filter((tool) => !tool.confirmedAt && (!wanted || wanted.has(tool.id)));
    const unclear = todo.filter((tool) => !tool.heading && !tool.suggestedHeading);
    if (unclear.length > 0) {
      throw new BotSettingsError(400, `Choose what ${unclear.map((tool) => tool.name).join(', ')} does before confirming`);
    }
    const now = new Date();
    for (const tool of todo) {
      // Only the tool as it was read: a sync that changed it in between has cleared its heading and confirmation, and
      // this must not confirm the old heading on a tool nobody has seen. Nothing is confirmed when one has changed.
      const confirmed = await tx.botMcpTool.updateMany({
        where: { id: tool.id, fingerprint: tool.fingerprint, heading: tool.heading, suggestedHeading: tool.suggestedHeading, confirmedAt: null },
        data: { heading: tool.heading ?? tool.suggestedHeading, confirmedById: personId, confirmedAt: now },
      });
      if (confirmed.count === 0) throw new BotSettingsError(409, TOOL_CHANGED);
    }
    const allConfirmed = all.every((tool) => tool.confirmedAt || todo.includes(tool));
    const checked = server.legacyText && allConfirmed;
    if (todo.length > 0 || checked) {
      // The list this confirmed is the one the server still has: a sync that landed after the reads above (a tool added, a
      // suggestion changed) has moved the revision, and then nothing is confirmed
      const settled = await tx.botMcpServer.updateMany({
        where: { id: serverId, policyRevision: server.policyRevision },
        data: { ...bump, ...(checked ? { legacyText: false } : {}) },
      });
      if (settled.count === 0) throw new BotSettingsError(409, TOOL_CHANGED);
    }
    return describe(tx, serverId);
  }, GRANT_WRITE);
}

/** Set what a bot does under each heading on one server. Only the headings named change. */
export async function saveServerSettings(botId: string, serverId: string, body: z.infer<typeof serverSettingsSchema>): Promise<ServerToolsJson> {
  return prisma.$transaction(async (tx) => {
    await lockGrant(tx, serverId);
    const server = await loadServer(tx, botId, serverId);
    const current = settingsOf(server);
    const data: Record<string, string> = {};
    for (const heading of HEADINGS) {
      const value = body[heading];
      if (value !== undefined && value !== current[heading]) data[SETTING_COLUMN[heading]] = value;
    }
    if (Object.keys(data).length > 0) await tx.botMcpServer.update({ where: { id: serverId }, data: { ...data, ...bump } });
    return describe(tx, serverId);
  }, GRANT_WRITE);
}

export interface BotToolSettings {
  askBeforeMaking: number | null;
  askWhichWay: (typeof ASK_WHICH_WAY)[number];
  cardWaitMinutes: number;
  /** "Allow more": minutes without the asker's messages before it ends (30, 60 or 120; default 60). */
  allowMoreIdleMinutes: number;
  /** "Allow more": minutes it lasts at most, even while the asker keeps chatting (240, 480 or 1440; default 480). */
  allowMoreMaxMinutes: number;
}

const BOT_SETTINGS_SELECT = {
  askBeforeMaking: true,
  askWhichWay: true,
  cardWaitMinutes: true,
  allowMoreIdleMinutes: true,
  allowMoreMaxMinutes: true,
} as const;

function toBotToolSettings(bot: Prisma.BotGetPayload<{ select: typeof BOT_SETTINGS_SELECT }>): BotToolSettings {
  return {
    askBeforeMaking: bot.askBeforeMaking,
    askWhichWay: bot.askWhichWay as BotToolSettings['askWhichWay'],
    cardWaitMinutes: bot.cardWaitMinutes,
    allowMoreIdleMinutes: bot.allowMoreIdleMinutes,
    allowMoreMaxMinutes: bot.allowMoreMaxMinutes,
  };
}

/** A bot's own limits for asking: null when there is no such bot. */
export async function readBotToolSettings(botId: string): Promise<BotToolSettings | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: BOT_SETTINGS_SELECT });
  return bot ? toBotToolSettings(bot) : null;
}

export async function saveBotToolSettings(botId: string, body: z.infer<typeof botToolSettingsSchema>): Promise<BotToolSettings> {
  const data: Prisma.BotUpdateInput = {};
  if (body.askBeforeMaking !== undefined) data.askBeforeMaking = body.askBeforeMaking;
  if (body.askWhichWay !== undefined) data.askWhichWay = body.askWhichWay;
  if (body.cardWaitMinutes !== undefined) data.cardWaitMinutes = body.cardWaitMinutes;
  if (body.allowMoreIdleMinutes !== undefined) data.allowMoreIdleMinutes = body.allowMoreIdleMinutes;
  if (body.allowMoreMaxMinutes !== undefined) data.allowMoreMaxMinutes = body.allowMoreMaxMinutes;
  const bot = await prisma.bot.update({ where: { id: botId }, data, select: BOT_SETTINGS_SELECT });
  return toBotToolSettings(bot);
}
