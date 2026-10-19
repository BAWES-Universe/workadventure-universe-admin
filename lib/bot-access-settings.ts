import { z } from 'zod';
import { prisma } from '@/lib/db';
import { has, parsePermissions } from '@/lib/permissions';
import { ADMIN_KEY } from '@/lib/roles';
import {
  RULE_ACTIONS,
  RULE_PERMISSION,
  RULE_VALUES,
  ruleValue,
  withValues,
  type RuleAction,
  type RuleValue,
} from '@/lib/bot-rules';
import { isSuperAdmin } from '@/lib/super-admin';
import { findUserByIdentifier } from '@/lib/user-identifier';

/**
 * What an owner can set on one bot (#427): who may use it (rules for roles and people, and Private bot), the line
 * refused people hear, and how many replies each person gets a day. The check in lib/bot-access.ts applies them.
 */
export const REFUSAL_REPLY_MAX = 500;
export const DAILY_CAP_MIN = 1;
export const DAILY_CAP_MAX = 10000;
/** More rules than a bot page can show; stops a runaway script from filling the table. */
export const MAX_RULES_PER_BOT = 200;

export const settingsSchema = z
  .object({
    privateBot: z.boolean().optional(),
    /** Empty or only spaces clears it, and the bot says a plain default line. */
    refusalReply: z.string().max(REFUSAL_REPLY_MAX).nullable().optional(),
    /** Replies each person may get in a day. null = no limit, which is how every bot starts. */
    dailyReplyCap: z.number().int().min(DAILY_CAP_MIN).max(DAILY_CAP_MAX).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

const valueSchema = z.enum(RULE_VALUES as [RuleValue, ...RuleValue[]]);

export const ruleSchema = z
  .object({
    roleId: z.string().min(1).max(100).optional(),
    userId: z.string().min(1).max(100).optional(),
    /** A person's WorkAdventure identifier (their uuid or email), as the game knows them. */
    identifier: z.string().trim().min(1).max(320).optional(),
    chat: valueSchema.optional(),
    dm: valueSchema.optional(),
    summon: valueSchema.optional(),
    manage: valueSchema.optional(),
  })
  .strict()
  .refine((body) => [body.roleId, body.userId, body.identifier].filter(Boolean).length === 1, {
    message: 'Name exactly one of roleId, userId or identifier',
  });

/** A failure the person can be told about, with the status to answer. */
export class BotSettingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Values = Record<RuleAction, RuleValue>;

export interface RuleJson extends Values {
  id: string;
  roleId: string | null;
  userId: string | null;
  /** For a role row. */
  role: { key: string; name: string; color: string } | null;
  /** For a person row: their name only, people's emails are private. */
  person: { name: string | null } | null;
}

const valuesOf = (rule: { allow: bigint; deny: bigint }): Values => ({
  chat: ruleValue(rule, 'chat'),
  dm: ruleValue(rule, 'dm'),
  summon: ruleValue(rule, 'summon'),
  manage: ruleValue(rule, 'manage'),
});

const RULE_SELECT = {
  id: true,
  roleId: true,
  userId: true,
  allow: true,
  deny: true,
  role: { select: { key: true, name: true, color: true } },
  user: { select: { name: true } },
} as const;

function toRuleJson(row: {
  id: string;
  roleId: string | null;
  userId: string | null;
  allow: bigint;
  deny: bigint;
  role: { key: string; name: string; color: string } | null;
  user: { name: string | null } | null;
}): RuleJson {
  return {
    id: row.id,
    roleId: row.roleId,
    userId: row.userId,
    role: row.role ? { key: row.role.key, name: row.role.name, color: row.role.color } : null,
    person: row.user ? { name: row.user.name } : null,
    ...valuesOf(row),
  };
}

/** The line refused people hear: trimmed, and null when empty. */
export function cleanRefusalReply(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

export interface BotPlace {
  id: string;
  createdById: string | null;
  universeId: string;
  universeOwnerId: string;
}

export async function loadBotPlace(botId: string): Promise<(BotPlace & { roomId: string }) | null> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      id: true,
      createdById: true,
      roomId: true,
      room: { select: { world: { select: { universeId: true, universe: { select: { ownerId: true } } } } } },
    },
  });
  if (!bot) return null;
  return {
    id: bot.id,
    createdById: bot.createdById,
    roomId: bot.roomId,
    universeId: bot.room.world.universeId,
    universeOwnerId: bot.room.world.universe.ownerId,
  };
}

/** Everything an owner sees: the settings, the rows, and the roles a row may name with what each gives by default. */
export async function readBotSettings(botId: string) {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      privateBot: true,
      refusalReply: true,
      dailyReplyCap: true,
      room: { select: { world: { select: { universeId: true } } } },
      accessRules: { select: RULE_SELECT, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!bot) return null;

  const roles = await prisma.role.findMany({
    where: { universeId: bot.room.world.universeId, key: { not: ADMIN_KEY } },
    select: { id: true, key: true, name: true, color: true, builtIn: true, permissions: true, position: true },
    orderBy: [{ position: 'desc' }, { name: 'asc' }],
  });

  return {
    privateBot: bot.privateBot,
    refusalReply: bot.refusalReply,
    dailyReplyCap: bot.dailyReplyCap,
    rules: bot.accessRules.map(toRuleJson),
    /** Roles a row can name. Admin is left out: it always passes, so a rule for it would do nothing. */
    roles: roles.map((role) => {
      const permissions = parsePermissions(role.permissions) ?? BigInt(0);
      const given = (action: RuleAction) => has(permissions, RULE_PERMISSION[action]);
      return {
        id: role.id,
        key: role.key,
        name: role.name,
        color: role.color,
        builtIn: role.builtIn,
        /** What the role gives on its own, which is what Default means for it. */
        defaults: { chat: given('chat'), dm: given('dm'), summon: given('summon'), manage: given('manage') },
      };
    }),
  };
}

export async function saveBotSettings(botId: string, body: z.infer<typeof settingsSchema>) {
  const data: { privateBot?: boolean; refusalReply?: string | null; dailyReplyCap?: number | null } = {};
  if (body.privateBot !== undefined) data.privateBot = body.privateBot;
  if ('refusalReply' in body) data.refusalReply = cleanRefusalReply(body.refusalReply);
  if (body.dailyReplyCap !== undefined) data.dailyReplyCap = body.dailyReplyCap;
  await prisma.bot.update({ where: { id: botId }, data });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** Which role or person a row is for, checked: it exists, is in this bot's universe, and could actually be limited. */
async function resolveSubject(
  place: BotPlace,
  body: z.infer<typeof ruleSchema>,
): Promise<{ roleId: string } | { userId: string }> {
  if (body.roleId) {
    const role = await prisma.role.findUnique({ where: { id: body.roleId }, select: { id: true, key: true, universeId: true } });
    if (!role || role.universeId !== place.universeId) throw new BotSettingsError(404, 'That role is not in this universe');
    if (role.key === ADMIN_KEY) throw new BotSettingsError(400, "Admin always passes, so a rule for it would do nothing");
    return { roleId: role.id };
  }

  const user = body.userId
    ? await prisma.user.findUnique({ where: { id: body.userId } })
    : await findUserByIdentifier(body.identifier as string);
  if (!user) throw new BotSettingsError(404, 'That person was not found');
  if (user.id === place.universeOwnerId || isSuperAdmin(user.email)) {
    throw new BotSettingsError(400, "The bot's owner always passes, so a rule for them would do nothing");
  }
  // The creator always chats with, messages and calls over their own bot, but manages it only while they hold Manage
  // bots, so Manage this bot is the one thing a rule can still change for them
  if (user.id === place.createdById && ['chat', 'dm', 'summon'].some((action) => body[action as RuleAction] && body[action as RuleAction] !== 'default')) {
    throw new BotSettingsError(400, 'The bot\'s creator always chats with it, messages it and calls it over. Only "Manage this bot" can be set for them');
  }
  return { userId: user.id };
}

/**
 * Set a role's or a person's No / Default / Yes on a bot. Only the actions named change. A row saved at the same time
 * by someone else is never overwritten with old values: the write only lands on the numbers it read, and otherwise
 * reads again.
 */
export async function saveBotRule(place: BotPlace, body: z.infer<typeof ruleSchema>): Promise<RuleJson> {
  const subject = await resolveSubject(place, body);
  const where = { botId: place.id, ...subject };
  const values: Partial<Record<RuleAction, RuleValue>> = {};
  for (const action of RULE_ACTIONS) if (body[action]) values[action] = body[action];

  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await prisma.botAccessRule.findFirst({ where, select: { id: true, allow: true, deny: true } });
    if (existing) {
      const next = withValues(existing, values);
      const { count } = await prisma.botAccessRule.updateMany({
        where: { id: existing.id, allow: existing.allow, deny: existing.deny },
        data: next,
      });
      if (count === 0) continue; // changed meanwhile: read it again
      return toRuleJson(await prisma.botAccessRule.findUniqueOrThrow({ where: { id: existing.id }, select: RULE_SELECT }));
    }

    if ((await prisma.botAccessRule.count({ where: { botId: place.id } })) >= MAX_RULES_PER_BOT) {
      throw new BotSettingsError(400, `A bot can have at most ${MAX_RULES_PER_BOT} rules`);
    }
    try {
      const created = await prisma.botAccessRule.create({
        data: { ...where, ...withValues({ allow: BigInt(0), deny: BigInt(0) }, values) },
        select: RULE_SELECT,
      });
      return toRuleJson(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // someone added the same row first: update theirs
    }
  }
  throw new BotSettingsError(409, 'This rule is being changed by someone else. Try again.');
}

export async function deleteBotRule(botId: string, subject: { roleId?: string | null; userId?: string | null }): Promise<boolean> {
  if (!subject.roleId === !subject.userId) throw new BotSettingsError(400, 'Name exactly one of roleId or userId');
  const { count } = await prisma.botAccessRule.deleteMany({
    where: { botId, ...(subject.roleId ? { roleId: subject.roleId } : { userId: subject.userId as string }) },
  });
  return count > 0;
}
