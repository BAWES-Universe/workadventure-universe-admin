import { z } from 'zod';
import type { Prisma } from '@prisma/client';
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
/** More tools than any server offers; stops a runaway script from filling the table. */
export const MAX_TOOLS_PER_SERVER = 500;

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
  })
  .strict()
  .refine((body) => new Set(body.tools.map((tool) => tool.name)).size === body.tools.length, { message: 'Each tool name once' });

export const moveSchema = z.object({ heading: headingSchema }).strict();

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
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export type ToolsState = 'notCheckedYet' | 'notConfirmedYet' | 'confirmed';

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
}

export interface ServerToolsJson {
  serverId: string;
  /** Not checked yet: an old server that works as it did. Not confirmed yet: tools wait. Confirmed: every tool is. */
  state: ToolsState;
  policyRevision: number;
  settings: Record<Heading, Setting>;
  tools: ToolJson[];
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
});

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
  if (!server || server.botId !== botId) throw new BotSettingsError(404, 'MCP server not found');
  return server;
}

async function describe(db: Prisma.TransactionClient | typeof prisma, serverId: string): Promise<ServerToolsJson> {
  const [server, rows] = await Promise.all([
    db.botMcpServer.findUniqueOrThrow({ where: { id: serverId }, select: SERVER_SELECT }),
    db.botMcpTool.findMany({ where: { serverId }, select: TOOL_SELECT, orderBy: [{ name: 'asc' }] }),
  ]);
  const tools = rows.map(toToolJson);
  return {
    serverId,
    state: toolsState(server.legacyText, tools),
    policyRevision: server.policyRevision,
    settings: settingsOf(server),
    tools,
  };
}

const bump = { policyRevision: { increment: 1 } } as const;

/** One server's tools, their settings and state. */
export async function readServerTools(botId: string, serverId: string): Promise<ServerToolsJson> {
  await loadServer(prisma, botId, serverId);
  return describe(prisma, serverId);
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
 * server no longer offers is removed. Its suggestion is only a suggestion and never lets it run.
 */
export async function syncCatalog(botId: string, serverId: string, body: z.infer<typeof catalogSchema>): Promise<CatalogResult> {
  return prisma.$transaction(async (tx) => {
    await loadServer(tx, botId, serverId);
    const existing = await tx.botMcpTool.findMany({
      where: { serverId },
      select: { id: true, name: true, fingerprint: true, confirmedAt: true, heading: true },
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
        // follows the server while nobody has confirmed the tool.
        await tx.botMcpTool.update({ where: { id: before.id }, data: before.confirmedAt ? shown : { ...shown, ...suggestion } });
      }
    }

    const offered = new Set(body.tools.map((tool) => tool.name));
    const removed = existing.filter((tool) => !offered.has(tool.name));
    if (removed.length > 0) await tx.botMcpTool.deleteMany({ where: { id: { in: removed.map((tool) => tool.id) } } });

    if (added.length > 0 || changed.length > 0 || removed.length > 0 || reworded) {
      await tx.botMcpServer.update({ where: { id: serverId }, data: bump });
    }
    return { ...(await describe(tx, serverId)), added, changed, removed: removed.map((tool) => tool.name) };
  });
}

/** A tool the server changed while a person was looking at it: what they saw is not what is there now. */
const TOOL_CHANGED = 'This tool changed, review it again';

/**
 * Move one tool under another heading. If it was confirmed it stays confirmed, now by the person who moved it; if not,
 * it still waits to be confirmed.
 */
export async function moveTool(botId: string, serverId: string, toolId: string, heading: Heading, personId: string): Promise<ServerToolsJson> {
  return prisma.$transaction(async (tx) => {
    await loadServer(tx, botId, serverId);
    const tool = await tx.botMcpTool.findUnique({ where: { id: toolId }, select: { id: true, serverId: true, fingerprint: true, heading: true, confirmedAt: true } });
    if (!tool || tool.serverId !== serverId) throw new BotSettingsError(404, 'Tool not found');
    if (tool.heading !== heading) {
      // Only the tool as it was read: a sync that changed it in between has cleared its heading and confirmation, and
      // this must not put the old ones back
      const moved = await tx.botMcpTool.updateMany({
        where: { id: toolId, fingerprint: tool.fingerprint },
        data: { heading, movedById: personId, ...(tool.confirmedAt ? { confirmedById: personId, confirmedAt: new Date() } : {}) },
      });
      if (moved.count === 0) throw new BotSettingsError(409, TOOL_CHANGED);
      await tx.botMcpServer.update({ where: { id: serverId }, data: bump });
    }
    return describe(tx, serverId);
  });
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
    const server = await loadServer(tx, botId, serverId);
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
        where: { id: tool.id, fingerprint: tool.fingerprint },
        data: { heading: tool.heading ?? tool.suggestedHeading, confirmedById: personId, confirmedAt: now },
      });
      if (confirmed.count === 0) throw new BotSettingsError(409, TOOL_CHANGED);
    }
    const allConfirmed = all.every((tool) => tool.confirmedAt || todo.includes(tool));
    const checked = server.legacyText && allConfirmed;
    if (todo.length > 0 || checked) {
      await tx.botMcpServer.update({ where: { id: serverId }, data: { ...bump, ...(checked ? { legacyText: false } : {}) } });
    }
    return describe(tx, serverId);
  });
}

/** Set what a bot does under each heading on one server. Only the headings named change. */
export async function saveServerSettings(botId: string, serverId: string, body: z.infer<typeof serverSettingsSchema>): Promise<ServerToolsJson> {
  return prisma.$transaction(async (tx) => {
    const server = await loadServer(tx, botId, serverId);
    const current = settingsOf(server);
    const data: Record<string, string> = {};
    for (const heading of HEADINGS) {
      const value = body[heading];
      if (value !== undefined && value !== current[heading]) data[SETTING_COLUMN[heading]] = value;
    }
    if (Object.keys(data).length > 0) await tx.botMcpServer.update({ where: { id: serverId }, data: { ...data, ...bump } });
    return describe(tx, serverId);
  });
}

export interface BotToolSettings {
  askBeforeMaking: number | null;
  askWhichWay: (typeof ASK_WHICH_WAY)[number];
  cardWaitMinutes: number;
}

const BOT_SETTINGS_SELECT = { askBeforeMaking: true, askWhichWay: true, cardWaitMinutes: true } as const;

/** A bot's own limits for asking: null when there is no such bot. */
export async function readBotToolSettings(botId: string): Promise<BotToolSettings | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: BOT_SETTINGS_SELECT });
  return bot ? { askBeforeMaking: bot.askBeforeMaking, askWhichWay: bot.askWhichWay as BotToolSettings['askWhichWay'], cardWaitMinutes: bot.cardWaitMinutes } : null;
}

export async function saveBotToolSettings(botId: string, body: z.infer<typeof botToolSettingsSchema>): Promise<BotToolSettings> {
  const data: Prisma.BotUpdateInput = {};
  if (body.askBeforeMaking !== undefined) data.askBeforeMaking = body.askBeforeMaking;
  if (body.askWhichWay !== undefined) data.askWhichWay = body.askWhichWay;
  if (body.cardWaitMinutes !== undefined) data.cardWaitMinutes = body.cardWaitMinutes;
  const bot = await prisma.bot.update({ where: { id: botId }, data, select: BOT_SETTINGS_SELECT });
  return { askBeforeMaking: bot.askBeforeMaking, askWhichWay: bot.askWhichWay as BotToolSettings['askWhichWay'], cardWaitMinutes: bot.cardWaitMinutes };
}
