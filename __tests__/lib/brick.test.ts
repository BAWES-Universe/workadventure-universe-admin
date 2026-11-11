/**
 * A Brick (game #1992): a bot with an owner and no room. Only its owner manages it and talks to it, only its owner's key
 * may run it, what it wrote is always hidden, and nothing about it is read from a room or a universe. A room bot is never
 * read as owned, whoever made it.
 *
 * The database is a small stand-in that fails the test if a Brick's rules ever reach for a room, a lend or a role.
 */
const state = {
  bot: null as null | { id: string; name: string; createdById: string | null; roomId: string | null; ownerId: string | null; hideConversations?: boolean | null },
  users: [] as { id: string; uuid: string; email: string | null; name: string | null; isGuest: boolean; matrixChatId?: string }[],
  created: [] as Record<string, unknown>[],
};

jest.mock('@/lib/db', () => {
  const noRoomReads = (what: string) =>
    jest.fn(async () => {
      throw new Error(`A Brick's rules must not read ${what}`);
    });
  return {
    prisma: {
      bot: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (state.bot && state.bot.id === where.id ? { ...state.bot, room: null, privateBot: false, refusalReply: null, accessRules: [] } : null)),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.created.push(data);
          return { id: 'new-brick', roomId: null, ...data };
        }),
      },
      user: {
        findFirst: jest.fn(async ({ where }: { where: { OR: { uuid?: string; email?: string }[] } }) =>
          state.users.find((user) => where.OR.some((cond) => cond.uuid === user.uuid || (!!cond.email && cond.email === user.email))) ?? null,
        ),
        findMany: jest.fn(async ({ where }: { where: { matrixChatId: string } }) => state.users.filter((user) => user.matrixChatId === where.matrixChatId)),
      },
      room: { findUnique: noRoomReads('a room') },
      aiKeyLend: { findUnique: noRoomReads('a lend') },
      ban: { findFirst: noRoomReads('a ban') },
      worldMember: { findFirst: noRoomReads('a world membership') },
      universeMember: { findUnique: noRoomReads('a universe membership') },
      role: { findUnique: noRoomReads('a role'), findMany: noRoomReads('roles') },
      botAccessRule: { findMany: noRoomReads('bot rules') },
    },
  };
});

import { prisma } from '@/lib/db';
import { BRICK_HAS_NO_ROOM, ROOM_BOTS_ONLY, brickHasNoRoomText, isBrick, ownsBrick } from '@/lib/brick';
import { createBrick } from '@/lib/brick-create';
import { canManageBotMcpServers, canManageThisBot } from '@/lib/bot-permissions';
import { BOT_ACTIONS, checkBotAccess } from '@/lib/bot-access';
import { checkKeyForBot } from '@/lib/ai-key-pay';
import { loadBotPrivacy } from '@/lib/bot-privacy';
import { loadBotPlace, readBotSettings } from '@/lib/bot-access-settings';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';

const SARA = { id: 'u-sara', uuid: 'uuid-sara', email: 'sara@example.com', name: 'Sara', isGuest: false, matrixChatId: '@sara:chat' };
const OMAR = { id: 'u-omar', uuid: 'uuid-omar', email: 'omar@example.com', name: 'Omar', isGuest: false, matrixChatId: '@omar:chat' };
const ROOT = { id: 'u-root', uuid: 'uuid-root', email: 'root@example.com', name: 'Root', isGuest: false };
const GUEST = { id: 'u-guest', uuid: 'uuid-guest', email: null, name: null, isGuest: true, matrixChatId: '@guest:chat' };

const BRICK = { id: 'brick-1', name: 'Brick', createdById: SARA.id, roomId: null, ownerId: SARA.id };
const ROOM_BOT = { id: 'bot-1', name: 'Nora', createdById: SARA.id, roomId: 'room-1', ownerId: null };

const superAdminsBefore = process.env.SUPER_ADMINS;

beforeEach(() => {
  state.bot = { ...BRICK };
  state.users = [SARA, OMAR, ROOT, GUEST];
  state.created = [];
  process.env.SUPER_ADMINS = ROOT.email;
  jest.clearAllMocks();
});

afterAll(() => {
  if (superAdminsBefore === undefined) delete process.env.SUPER_ADMINS;
  else process.env.SUPER_ADMINS = superAdminsBefore;
});

describe('what a Brick is', () => {
  it('is a bot with no room', () => {
    expect(isBrick(BRICK)).toBe(true);
    expect(isBrick(ROOM_BOT)).toBe(false);
  });

  it('belongs to its owner and to nobody else', () => {
    expect(ownsBrick(BRICK, SARA.id)).toBe(true);
    expect(ownsBrick(BRICK, OMAR.id)).toBe(false);
    expect(ownsBrick(BRICK, null)).toBe(false);
    expect(ownsBrick(BRICK, undefined)).toBe(false);
  });

  it('never reads a room bot as owned: "made by" is not ownership', () => {
    expect(ownsBrick(ROOM_BOT, SARA.id)).toBe(false);
    // Even a row that could not exist (the database refuses a room and an owner together) is not owned while it has a room
    expect(ownsBrick({ roomId: 'room-1', ownerId: SARA.id }, SARA.id)).toBe(false);
  });

  it('tells its owner and the bot server why a room part is not there, and is not there at all for anyone else', () => {
    expect(brickHasNoRoomText(BRICK, { userId: SARA.id })).toBe(BRICK_HAS_NO_ROOM);
    expect(brickHasNoRoomText(BRICK, { isAdminToken: true })).toBe(BRICK_HAS_NO_ROOM);
    expect(brickHasNoRoomText(BRICK, { userId: OMAR.id })).toBe('Bot not found');
    expect(brickHasNoRoomText(BRICK, { userId: null })).toBe('Bot not found');
  });

  it('is left out of the lists that are about rooms', () => {
    expect(ROOM_BOTS_ONLY).toEqual({ roomId: { not: null } });
  });
});

describe('making a Brick', () => {
  it('stores a bot with an owner and no room; its owner is the person who made it', async () => {
    const brick = await createBrick({ ownerId: SARA.id, name: 'Brick' });
    expect(brick.roomId).toBeNull();
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ ownerId: SARA.id, createdById: SARA.id, updatedById: SARA.id, name: 'Brick' });
    expect(state.created[0]).not.toHaveProperty('roomId');
    expect(state.created[0]).not.toHaveProperty('room');
  });

  it('starts on Universe AI, as a bot usually starts', async () => {
    await createBrick({ ownerId: SARA.id, name: 'Brick', description: 'Helps Sara', characterTextureId: 'woka-1', chatInstructions: 'Be brief.' });
    expect(state.created[0]).toMatchObject({
      aiProviderRef: UNIVERSE_AI_REF,
      behaviorType: 'idle',
      behaviorConfig: { showToolCalls: true },
      description: 'Helps Sara',
      characterTextureId: 'woka-1',
      chatInstructions: 'Be brief.',
    });
  });
});

describe('who manages a Brick', () => {
  it('its owner does', async () => {
    expect(await canManageThisBot(SARA.id, SARA.email, BRICK, { creatorPasses: false })).toBe(true);
    expect(await canManageBotMcpServers(SARA.id, SARA.email, BRICK)).toBe(true);
  });

  it('nobody else does: not another person, and not a super admin', async () => {
    expect(await canManageThisBot(OMAR.id, OMAR.email, BRICK, { creatorPasses: true })).toBe(false);
    expect(await canManageThisBot(ROOT.id, ROOT.email, BRICK, { creatorPasses: true })).toBe(false);
    expect(await canManageBotMcpServers(ROOT.id, ROOT.email, BRICK)).toBe(false);
  });

  it('not the person who made it either, once it is someone else’s', async () => {
    const given = { ...BRICK, createdById: OMAR.id };
    expect(await canManageThisBot(OMAR.id, OMAR.email, given, { creatorPasses: true })).toBe(false);
    expect(await canManageThisBot(SARA.id, SARA.email, given, { creatorPasses: false })).toBe(true);
  });

  it('is decided without reading a room, a role or a rule', async () => {
    await canManageThisBot(SARA.id, SARA.email, BRICK, { creatorPasses: true });
    await canManageThisBot(OMAR.id, OMAR.email, BRICK, { creatorPasses: true });
    expect(prisma.room.findUnique).not.toHaveBeenCalled();
    expect(prisma.botAccessRule.findMany).not.toHaveBeenCalled();
  });
});

describe('who may use a Brick', () => {
  const ask = (action: (typeof BOT_ACTIONS)[number], person: { signedIn: boolean; identifier?: string | null; chatId?: string | null }) =>
    checkBotAccess({ botId: BRICK.id, action, person });

  it.each(BOT_ACTIONS)('lets its owner %s', async (action) => {
    expect(await ask(action, { signedIn: true, identifier: SARA.email })).toMatchObject({ allowed: true });
  });

  it.each(BOT_ACTIONS)('refuses another signed-in person who wants to %s', async (action) => {
    expect(await ask(action, { signedIn: true, identifier: OMAR.email })).toMatchObject({ allowed: false, code: 'not_allowed' });
  });

  it.each(BOT_ACTIONS)('refuses a super admin who wants to %s: a Brick’s chats, memory and apps are its owner’s', async (action) => {
    expect(await ask(action, { signedIn: true, identifier: ROOT.email })).toMatchObject({ allowed: false, code: 'not_allowed' });
  });

  it('asks a guest to sign in for a direct message, and refuses a guest everything else', async () => {
    expect(await ask('dm', { signedIn: false })).toMatchObject({ allowed: false, code: 'sign_in_required' });
    expect(await ask('chat', { signedIn: false })).toMatchObject({ allowed: false, code: 'not_allowed' });
    expect(await ask('summon', { signedIn: false })).toMatchObject({ allowed: false, code: 'not_allowed' });
  });

  it('knows its owner by chat ID too, and names them for the bot server', async () => {
    expect(await ask('dm', { signedIn: false, chatId: SARA.matrixChatId })).toMatchObject({ allowed: true, person: { uuid: SARA.uuid, name: SARA.name } });
    expect(await ask('dm', { signedIn: false, chatId: OMAR.matrixChatId })).toMatchObject({ allowed: false, code: 'not_allowed', person: { uuid: OMAR.uuid } });
    expect(await ask('dm', { signedIn: true, chatId: GUEST.matrixChatId })).toMatchObject({ allowed: false, code: 'sign_in_required' });
  });

  it('reads no world: no ban, no membership and no role decides it', async () => {
    await ask('dm', { signedIn: true, identifier: SARA.email });
    await ask('dm', { signedIn: true, identifier: OMAR.email });
    expect(prisma.ban.findFirst).not.toHaveBeenCalled();
    expect(prisma.worldMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it('answers null for a bot that does not exist, as before', async () => {
    expect(await checkBotAccess({ botId: 'nope', action: 'chat', person: { signedIn: true, identifier: SARA.email } })).toBeNull();
  });
});

describe('whose key may run a Brick', () => {
  const brickForKey = { id: BRICK.id, createdById: BRICK.createdById, roomId: null, ownerId: BRICK.ownerId };

  it('its owner’s own key, with all of its models and no lend to look for', async () => {
    expect(await checkKeyForBot({ keyId: 'key-1', keyOwnerId: SARA.id, bot: brickForKey })).toEqual({ ok: true, lendModels: null });
    expect(prisma.aiKeyLend.findUnique).not.toHaveBeenCalled();
    expect(prisma.room.findUnique).not.toHaveBeenCalled();
  });

  it('nobody else’s key, a super admin’s included', async () => {
    expect(await checkKeyForBot({ keyId: 'key-2', keyOwnerId: OMAR.id, bot: brickForKey })).toEqual({ ok: false, reason: 'no-access' });
    expect(await checkKeyForBot({ keyId: 'key-3', keyOwnerId: ROOT.id, bot: brickForKey })).toEqual({ ok: false, reason: 'no-access' });
  });

  it('not the key of the person who made it, once it is someone else’s', async () => {
    expect(await checkKeyForBot({ keyId: 'key-2', keyOwnerId: OMAR.id, bot: { ...brickForKey, createdById: OMAR.id } })).toEqual({ ok: false, reason: 'no-access' });
  });

  it('no key that lost its owner', async () => {
    expect(await checkKeyForBot({ keyId: 'key-1', keyOwnerId: null, bot: brickForKey })).toEqual({ ok: false, reason: 'no-owner' });
  });
});

describe('what a Brick wrote', () => {
  it('is always hidden, whatever the bot’s own setting says: there is no universe to follow', async () => {
    for (const hideConversations of [null, false, true]) {
      state.bot = { ...BRICK, hideConversations };
      expect(await loadBotPrivacy(BRICK.id)).toMatchObject({ hidden: true, universeHides: false });
    }
  });
});

describe('the parts of a bot’s page that are about its universe', () => {
  it('have nothing for a Brick: no place, and no rules to read', async () => {
    expect(await loadBotPlace(BRICK.id)).toBeNull();
    expect(await readBotSettings(BRICK.id)).toBeNull();
    expect(prisma.role.findMany).not.toHaveBeenCalled();
  });
});
