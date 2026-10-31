/**
 * Saving a bot's rules and settings (#427): what is accepted, what is refused with a line the owner can read, and that
 * two people saving the same row never overwrite each other. The database is a small in-memory stand-in.
 */
type Row = { id: string; botId: string; roleId: string | null; userId: string | null; allow: bigint; deny: bigint };

type Person = {
  id: string;
  uuid: string;
  email: string | null;
  name: string | null;
  isGuest?: boolean;
  /** Universes they joined, and universes they have a world in through the older world membership. */
  universeIds?: string[];
  worldUniverseIds?: string[];
  /** false = switched "findable by name" off (the preference row is stored only then). */
  findable?: boolean;
};

const state = {
  rows: [] as Row[],
  roles: [] as { id: string; key: string; name: string; color: string; builtIn: boolean; permissions: bigint; position: number; universeId: string }[],
  users: [] as Person[],
  bot: { privateBot: false, refusalReply: null as string | null, dailyReplyCap: null as number | null },
  /** Make the next N conditional updates find a row that changed meanwhile. */
  staleUpdates: 0,
  /** Make the next create fail because the same row was just added. */
  conflictOnCreate: false,
  next: 1,
};

/** Runs the part of a Prisma user filter this file uses against the stand-in users; anything else fails loudly. */
function matches(user: Person, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    switch (key) {
      case 'AND':
        return (value as Record<string, unknown>[]).every((part) => matches(user, part));
      case 'OR':
        return (value as Record<string, unknown>[]).some((part) => matches(user, part));
      case 'NOT':
        return !matches(user, value as Record<string, unknown>);
      case 'id':
      case 'uuid':
      case 'email':
        return user[key] === value;
      case 'isGuest':
        return (user.isGuest ?? false) === value;
      case 'botAccessRules':
        return state.rows.some((row) => row.userId === user.id && row.botId === (value as { some: { botId: string } }).some.botId);
      case 'universeMemberships':
        return (user.universeIds ?? []).includes((value as { some: { universeId: string } }).some.universeId);
      case 'worldMemberships':
        return (user.worldUniverseIds ?? []).includes((value as { some: { world: { universeId: string } } }).some.world.universeId);
      case 'preferences':
        // the only preference asked about is findableByName switched off
      {
        const { some } = value as { some: { key: string; value: { equals: boolean } } };
        return some.key === 'people.findableByName' && some.value.equals === false && user.findable === false;
      }
      default:
        throw new Error(`The test stand-in does not know the filter ${key}`);
    }
  });
}

const withJoins = (row: Row) => ({
  ...row,
  role: row.roleId ? (state.roles.find((role) => role.id === row.roleId) ?? null) : null,
  user: row.userId ? (state.users.find((user) => user.id === row.userId) ?? null) : null,
});

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      findUnique: jest.fn(async () => ({
        ...state.bot,
        room: { world: { universeId: 'u1' } },
        accessRules: state.rows.map(withJoins),
      })),
      update: jest.fn(async ({ data }: { data: object }) => Object.assign(state.bot, data)),
    },
    role: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => state.roles.find((role) => role.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: { where: { universeId: string; key: { not: string } } }) =>
        state.roles.filter((role) => role.universeId === where.universeId && role.key !== where.key.not),
      ),
    },
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => state.users.find((user) => user.id === where.id) ?? null),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => state.users.find((user) => matches(user, where)) ?? null),
    },
    botAccessRule: {
      findFirst: jest.fn(async ({ where }: { where: { botId: string; roleId?: string; userId?: string } }) =>
        state.rows.find((row) => row.botId === where.botId && (where.roleId ? row.roleId === where.roleId : row.userId === where.userId)) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => withJoins(state.rows.find((row) => row.id === where.id)!)),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; allow: bigint; deny: bigint }; data: { allow: bigint; deny: bigint } }) => {
        const row = state.rows.find((item) => item.id === where.id);
        if (state.staleUpdates > 0 && row) {
          state.staleUpdates -= 1;
          row.allow = row.allow | BigInt(8192); // someone else changed it first
          return { count: 0 };
        }
        if (!row || row.allow !== where.allow || row.deny !== where.deny) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      count: jest.fn(async ({ where }: { where: { botId: string } }) => state.rows.filter((row) => row.botId === where.botId).length),
      create: jest.fn(async ({ data }: { data: Omit<Row, 'id' | 'roleId' | 'userId'> & { roleId?: string; userId?: string } }) => {
        if (state.conflictOnCreate) {
          state.conflictOnCreate = false;
          state.rows.push({ roleId: null, userId: null, ...data, id: `rule-${state.next++}`, allow: BigInt(0), deny: BigInt(0) });
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { roleId: null, userId: null, ...data, id: `rule-${state.next++}` } as Row;
        state.rows.push(row);
        return withJoins(row);
      }),
      deleteMany: jest.fn(async ({ where }: { where: { botId: string; roleId?: string; userId?: string } }) => {
        const before = state.rows.length;
        state.rows = state.rows.filter((row) => !(row.botId === where.botId && (where.roleId ? row.roleId === where.roleId : row.userId === where.userId)));
        return { count: before - state.rows.length };
      }),
    },
  },
}));

import {
  BotSettingsError,
  MAX_RULES_PER_BOT,
  cleanRefusalReply,
  deleteBotRule,
  readBotSettings,
  ruleSchema,
  saveBotRule,
  saveBotSettings,
  settingsSchema,
} from '@/lib/bot-access-settings';
import { ALL_PERMISSIONS, flag } from '@/lib/permissions';
import { EVERYONE_DEFAULT_PERMISSIONS } from '@/lib/roles';

const place = { id: 'bot-1', createdById: 'u-maker', universeId: 'u1', universeOwnerId: 'u-owner' };
const BIT = { chat: BigInt(16384), dm: BigInt(32768), summon: BigInt(65536), manage: BigInt(8192), change: BigInt(131072), deleteOrSend: BigInt(262144) };

const R = (id: string, key: string, permissions = BigInt(0), universeId = 'u1') => ({ id, key, name: key, color: '#99AAB5', builtIn: false, permissions, position: 10, universeId });

beforeEach(() => {
  process.env.SUPER_ADMINS = 'root@example.com';
  state.rows = [];
  state.roles = [R('r-admin', 'admin', ALL_PERMISSIONS), R('r-everyone', 'everyone', EVERYONE_DEFAULT_PERMISSIONS), R('r-acc', 'accountant'), R('r-other', 'accountant', BigInt(0), 'u2')];
  state.users = [
    { id: 'u-mishari', uuid: 'uuid-mishari', email: 'mishari@example.com', name: 'Mishari', universeIds: ['u1'] },
    { id: 'u-maker', uuid: 'uuid-maker', email: 'maker@example.com', name: 'Maker' },
    { id: 'u-owner', uuid: 'uuid-owner', email: 'owner@example.com', name: 'Owner' },
    { id: 'u-root', uuid: 'uuid-root', email: 'root@example.com', name: 'Root' },
    { id: 'u-stranger', uuid: 'uuid-stranger', email: 'stranger@example.com', name: 'Stranger' },
    { id: 'u-hidden', uuid: 'uuid-hidden', email: 'hidden@example.com', name: 'Hidden', findable: false },
    { id: 'u-guest', uuid: 'uuid-guest', email: null, name: 'Guest', isGuest: true },
    { id: 'u-elsewhere', uuid: 'uuid-elsewhere', email: 'elsewhere@example.com', name: 'Elsewhere', universeIds: ['u2'], findable: false },
    { id: 'u-shy-member', uuid: 'uuid-shy', email: 'shy@example.com', name: 'Shy', universeIds: ['u1'], findable: false },
    { id: 'u-old-member', uuid: 'uuid-old', email: 'old@example.com', name: 'Old', worldUniverseIds: ['u1'], findable: false },
  ];
  state.bot = { privateBot: false, refusalReply: null, dailyReplyCap: null };
  state.staleUpdates = 0;
  state.conflictOnCreate = false;
  state.next = 1;
});
afterAll(() => {
  delete process.env.SUPER_ADMINS;
});

describe('what a request may say', () => {
  it('settings: any of the three, nothing else, never empty', () => {
    expect(settingsSchema.safeParse({ privateBot: true }).success).toBe(true);
    expect(settingsSchema.safeParse({ refusalReply: null }).success).toBe(true);
    expect(settingsSchema.safeParse({ dailyReplyCap: 50 }).success).toBe(true);
    expect(settingsSchema.safeParse({ dailyReplyCap: null }).success).toBe(true);
    for (const bad of [{}, { name: 'x' }, { dailyReplyCap: 0 }, { dailyReplyCap: 10001 }, { dailyReplyCap: 2.5 }, { dailyReplyCap: '50' }, { privateBot: 'yes' }, { refusalReply: 'x'.repeat(501) }, null, 'text']) {
      expect(settingsSchema.safeParse(bad).success).toBe(false);
    }
    expect(settingsSchema.safeParse({ refusalReply: 'x'.repeat(500) }).success).toBe(true);
    expect(settingsSchema.safeParse({ dailyReplyCap: 1 }).success).toBe(true);
    expect(settingsSchema.safeParse({ dailyReplyCap: 10000 }).success).toBe(true);
  });

  it('rules: exactly one subject, known values only', () => {
    expect(ruleSchema.safeParse({ roleId: 'r-acc', chat: 'yes' }).success).toBe(true);
    expect(ruleSchema.safeParse({ userId: 'u-mishari', dm: 'no', manage: 'default' }).success).toBe(true);
    expect(ruleSchema.safeParse({ identifier: 'mishari@example.com' }).success).toBe(true);
    expect(ruleSchema.safeParse({ roleId: 'r-acc', change: 'no', deleteOrSend: 'yes' }).success).toBe(true);
    expect(ruleSchema.safeParse({ roleId: 'r-acc', change: 'maybe' }).success).toBe(false);
    for (const bad of [{ chat: 'yes' }, { roleId: 'a', userId: 'b' }, { roleId: 'a', chat: 'maybe' }, { roleId: 'a', talk: 'yes' }, { roleId: '' }, null]) {
      expect(ruleSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('the owner’s line is trimmed, tidied, and null when empty', () => {
    expect(cleanRefusalReply('  Ask   the\n front desk. ')).toBe('Ask the front desk.');
    expect(cleanRefusalReply('   ')).toBeNull();
    expect(cleanRefusalReply(null)).toBeNull();
    expect(cleanRefusalReply(undefined)).toBeNull();
  });
});

describe('saving settings', () => {
  it('changes only what is sent', async () => {
    await saveBotSettings('bot-1', { privateBot: true });
    expect(state.bot).toEqual({ privateBot: true, refusalReply: null, dailyReplyCap: null });
    await saveBotSettings('bot-1', { refusalReply: '  Not for you.  ', dailyReplyCap: 20 });
    expect(state.bot).toEqual({ privateBot: true, refusalReply: 'Not for you.', dailyReplyCap: 20 });
    await saveBotSettings('bot-1', { refusalReply: '   ' });
    expect(state.bot.refusalReply).toBeNull();
  });

  it('no limit is the start, and a limit can be taken off again', async () => {
    expect(state.bot.dailyReplyCap).toBeNull();
    await saveBotSettings('bot-1', { dailyReplyCap: 50 });
    expect(state.bot.dailyReplyCap).toBe(50);
    await saveBotSettings('bot-1', { dailyReplyCap: null });
    expect(state.bot.dailyReplyCap).toBeNull();
  });
});

describe('saving a rule', () => {
  it('adds a row for a role and reads it back', async () => {
    const saved = await saveBotRule(place, { roleId: 'r-acc', chat: 'yes', dm: 'yes', summon: 'yes' });
    expect(saved).toMatchObject({ roleId: 'r-acc', userId: null, chat: 'yes', dm: 'yes', summon: 'yes', manage: 'default', role: { key: 'accountant' }, person: null });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].allow).toBe(BIT.chat | BIT.dm | BIT.summon);
  });

  it('saves having a bot change things, or delete or send, next to the other four', async () => {
    const saved = await saveBotRule(place, { roleId: 'r-acc', change: 'no', deleteOrSend: 'yes' });
    expect(saved).toMatchObject({ change: 'no', deleteOrSend: 'yes', chat: 'default', manage: 'default' });
    expect(state.rows[0].deny).toBe(BIT.change);
    expect(state.rows[0].allow).toBe(BIT.deleteOrSend);
    const again = await saveBotRule(place, { roleId: 'r-acc', change: 'default', chat: 'yes' });
    expect(again).toMatchObject({ change: 'default', deleteOrSend: 'yes', chat: 'yes' });
  });

  it('adds a row for a person by id or by identifier, and never sends their email back', async () => {
    const byId = await saveBotRule(place, { userId: 'u-mishari', chat: 'yes' });
    expect(byId).toMatchObject({ userId: 'u-mishari', person: { name: 'Mishari' } });
    expect(JSON.stringify(byId)).not.toContain('@');
    state.rows = [];
    const byIdentifier = await saveBotRule(place, { identifier: 'mishari@example.com', dm: 'no' });
    expect(byIdentifier).toMatchObject({ userId: 'u-mishari', dm: 'no' });
  });

  it('changes only the actions named and keeps the rest', async () => {
    await saveBotRule(place, { roleId: 'r-acc', chat: 'yes', dm: 'yes', summon: 'no' });
    const saved = await saveBotRule(place, { roleId: 'r-acc', dm: 'default', manage: 'yes' });
    expect(saved).toMatchObject({ chat: 'yes', dm: 'default', summon: 'no', manage: 'yes' });
    expect(state.rows).toHaveLength(1);
  });

  it('keeps a row that is all Default, so the owner’s list does not lose it', async () => {
    await saveBotRule(place, { roleId: 'r-acc', chat: 'yes' });
    const saved = await saveBotRule(place, { roleId: 'r-acc', chat: 'default' });
    expect(saved).toMatchObject({ chat: 'default', dm: 'default', summon: 'default', manage: 'default' });
    expect(state.rows).toHaveLength(1);
  });

  it('never writes over a row someone else changed meanwhile: it reads again and keeps both changes', async () => {
    await saveBotRule(place, { roleId: 'r-acc', chat: 'yes' });
    state.staleUpdates = 1;
    const saved = await saveBotRule(place, { roleId: 'r-acc', summon: 'no' });
    expect(saved).toMatchObject({ chat: 'yes', summon: 'no', manage: 'yes' }); // manage: the other person's change
  });

  it('says so when it keeps losing the race, instead of pretending it saved', async () => {
    await saveBotRule(place, { roleId: 'r-acc', chat: 'yes' });
    state.staleUpdates = 99;
    await expect(saveBotRule(place, { roleId: 'r-acc', summon: 'no' })).rejects.toMatchObject({ status: 409 });
  });

  it('when someone adds the same row at the same moment, changes theirs instead of failing', async () => {
    state.conflictOnCreate = true;
    const saved = await saveBotRule(place, { roleId: 'r-acc', summon: 'yes' });
    expect(saved).toMatchObject({ summon: 'yes' });
    expect(state.rows).toHaveLength(1);
  });

  it('passes a database error that is not a duplicate on', async () => {
    const { prisma } = jest.requireMock('@/lib/db');
    prisma.botAccessRule.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(saveBotRule(place, { roleId: 'r-acc', chat: 'yes' })).rejects.toThrow('connection lost');
  });

  it('refuses Yes on Manage this bot for Everyone, but not a No or the other actions (CodeRabbit finding on #458)', async () => {
    await expect(saveBotRule(place, { roleId: 'r-everyone', manage: 'yes' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Everyone cannot be given "Manage this bot"'),
    });
    expect(state.rows).toHaveLength(0);
    await expect(saveBotRule(place, { roleId: 'r-everyone', manage: 'no' })).resolves.toMatchObject({ manage: 'no' });
    await expect(saveBotRule(place, { roleId: 'r-everyone', chat: 'no', manage: 'default' })).resolves.toMatchObject({ chat: 'no', manage: 'default' });
  });

  it('refuses a role from another universe, a role that does not exist, and Admin', async () => {
    await expect(saveBotRule(place, { roleId: 'r-other', chat: 'no' })).rejects.toMatchObject({ status: 404 });
    await expect(saveBotRule(place, { roleId: 'nope', chat: 'no' })).rejects.toMatchObject({ status: 404 });
    await expect(saveBotRule(place, { roleId: 'r-admin', chat: 'no' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Admin always passes') });
    expect(state.rows).toHaveLength(0);
  });

  it('refuses a person who does not exist, and the universe owner, saying why', async () => {
    await expect(saveBotRule(place, { userId: 'nope', chat: 'no' })).rejects.toMatchObject({ status: 404 });
    await expect(saveBotRule(place, { identifier: 'nobody@example.com', chat: 'no' })).rejects.toMatchObject({ status: 404 });
    await expect(saveBotRule(place, { userId: 'u-owner', chat: 'no' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('always passes') });
    await expect(saveBotRule(place, { userId: 'u-owner', manage: 'no' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('always passes') });
    expect(state.rows).toHaveLength(0);
  });

  it('treats a super admin like any other person, so a manager cannot tell who is one (Sentry finding on #458)', async () => {
    const asAdmin = await saveBotRule(place, { userId: 'u-root', chat: 'no' });
    expect(asAdmin).toMatchObject({ userId: 'u-root', chat: 'no', person: { name: 'Root' } });
    state.rows = [];
    const asOther = await saveBotRule(place, { userId: 'u-stranger', chat: 'no' });
    expect(Object.keys(asAdmin).sort()).toEqual(Object.keys(asOther).sort());
    // a hidden super admin who is not in the universe answers like any hidden account
    state.users.find((user) => user.id === 'u-root')!.findable = false;
    await expect(saveBotRule(place, { userId: 'u-root', chat: 'no' }).catch((error) => [error.status, error.message])).resolves.toEqual(
      await saveBotRule(place, { userId: 'u-hidden', chat: 'no' }).catch((error) => [error.status, error.message]),
    );
  });

  it('only names people of this universe or people who can be found by name (Sentry finding on #458)', async () => {
    // members of this universe, even when they are not findable by name (joined directly, or through an older world membership)
    for (const userId of ['u-mishari', 'u-shy-member', 'u-old-member']) {
      await expect(saveBotRule(place, { userId, chat: 'no' })).resolves.toMatchObject({ userId });
    }
    // anyone signed in who has not switched finding off, member or not
    await expect(saveBotRule(place, { identifier: 'stranger@example.com', chat: 'no' })).resolves.toMatchObject({ userId: 'u-stranger', person: { name: 'Stranger' } });
    await expect(saveBotRule(place, { identifier: 'uuid-stranger', chat: 'no' })).resolves.toMatchObject({ userId: 'u-stranger' });
    state.rows = [];
    await expect(saveBotRule(place, { identifier: 'maker@example.com', manage: 'yes' })).resolves.toMatchObject({ userId: 'u-maker' });
  });

  it('answers the same for an account that is hidden, a guest, one that is not there, and one in another universe', async () => {
    const answers: unknown[] = [];
    for (const body of [
      { userId: 'u-hidden' }, { identifier: 'hidden@example.com' }, { identifier: 'uuid-hidden' },
      { userId: 'u-guest' }, { identifier: 'uuid-guest' },
      { userId: 'u-elsewhere' }, { identifier: 'elsewhere@example.com' },
      { userId: 'nope' }, { identifier: 'nobody@example.com' },
    ]) {
      const error = await saveBotRule(place, { ...body, chat: 'no' }).catch((caught) => caught);
      answers.push({ status: error.status, message: error.message });
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 404, message: 'That person was not found' });
    expect(state.rows).toHaveLength(0);
  });

  it('someone already on the list stays editable after they leave or hide (Sentry finding on #462)', async () => {
    state.rows.push({ id: 'rule-old', botId: 'bot-1', roleId: null, userId: 'u-hidden', allow: BIT.chat, deny: BigInt(0) });
    await expect(saveBotRule(place, { userId: 'u-hidden', dm: 'no' })).resolves.toMatchObject({ userId: 'u-hidden', chat: 'yes', dm: 'no' });
    // another bot's list does not open the door
    state.rows[0].botId = 'bot-2';
    await expect(saveBotRule(place, { userId: 'u-hidden', dm: 'no' })).rejects.toMatchObject({ status: 404 });
  });

  it('a hidden super admin cannot be told apart from an account that is not there', async () => {
    state.users.find((user) => user.id === 'u-root')!.findable = false;
    await expect(saveBotRule(place, { identifier: 'root@example.com', chat: 'no' })).rejects.toMatchObject({ status: 404, message: 'That person was not found' });
  });

  it('the creator always uses their own bot, so only Manage this bot can be set for them (#433)', async () => {
    for (const body of [{ chat: 'no' }, { dm: 'no' }, { summon: 'yes' }, { change: 'no' }, { deleteOrSend: 'no' }, { chat: 'default', dm: 'no', manage: 'yes' }] as const) {
      await expect(saveBotRule(place, { userId: 'u-maker', ...body })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Only "Manage this bot"'),
      });
    }
    expect(state.rows).toHaveLength(0);
    await expect(saveBotRule(place, { userId: 'u-maker', manage: 'yes' })).resolves.toMatchObject({ manage: 'yes', chat: 'default' });
    expect(state.rows).toHaveLength(1);
    // a whole row sent back with the unchanged Default values is fine
    await expect(saveBotRule(place, { userId: 'u-maker', chat: 'default', dm: 'default', summon: 'default', manage: 'no' })).resolves.toMatchObject({ manage: 'no', chat: 'default' });
  });

  it('stops at the most rules a bot can have', async () => {
    for (let i = 0; i < MAX_RULES_PER_BOT; i++) state.rows.push({ id: `x${i}`, botId: 'bot-1', roleId: `role-${i}`, userId: null, allow: BigInt(0), deny: BigInt(0) });
    await expect(saveBotRule(place, { roleId: 'r-acc', chat: 'yes' })).rejects.toMatchObject({ status: 400 });
    // a row that exists can still be changed
    state.rows[0].roleId = 'r-acc';
    await expect(saveBotRule(place, { roleId: 'r-acc', chat: 'yes' })).resolves.toMatchObject({ chat: 'yes' });
  });
});

describe('taking a row off', () => {
  it('removes the row and says it did', async () => {
    await saveBotRule(place, { roleId: 'r-acc', chat: 'no' });
    expect(await deleteBotRule('bot-1', { roleId: 'r-acc' })).toBe(true);
    expect(state.rows).toHaveLength(0);
  });

  it('says there was nothing to remove, not success', async () => {
    expect(await deleteBotRule('bot-1', { userId: 'u-mishari' })).toBe(false);
  });

  it('wants exactly one of role or person', async () => {
    await expect(deleteBotRule('bot-1', {})).rejects.toBeInstanceOf(BotSettingsError);
    await expect(deleteBotRule('bot-1', { roleId: 'a', userId: 'b' })).rejects.toBeInstanceOf(BotSettingsError);
  });
});

describe('reading a bot’s settings', () => {
  it('gives a bot nobody has touched its defaults: open, no line, no reply limit, no rows', async () => {
    const settings = await readBotSettings('bot-1');
    expect(settings).toMatchObject({ privateBot: false, refusalReply: null, dailyReplyCap: null, rules: [] });
  });

  it('lists the roles a row can name, never Admin, with what each gives on its own', async () => {
    const settings = await readBotSettings('bot-1');
    expect(settings!.roles.map((role) => role.key)).toEqual(['everyone', 'accountant']);
    expect(settings!.roles.map((role) => role.id)).not.toContain('r-admin');
    expect(settings!.roles[0].defaults).toEqual({ chat: true, dm: true, summon: true, manage: false, change: false, deleteOrSend: false });
    expect(settings!.roles[1].defaults).toEqual({ chat: false, dm: false, summon: false, manage: false, change: false, deleteOrSend: false });
    state.roles.find((role) => role.id === 'r-acc')!.permissions = flag('MANAGE_BOTS');
    expect((await readBotSettings('bot-1'))!.roles[1].defaults.manage).toBe(true);
  });

  it('returns the rows with names but no emails', async () => {
    await saveBotRule(place, { userId: 'u-mishari', chat: 'yes' });
    await saveBotRule(place, { roleId: 'r-acc', summon: 'no' });
    const settings = await readBotSettings('bot-1');
    expect(settings!.rules).toHaveLength(2);
    expect(JSON.stringify(settings)).not.toContain('@');
  });
});
