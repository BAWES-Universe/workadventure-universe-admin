/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reading a bot (#797): what steers it and what it runs on go only to the bot server and the people who manage the bot.
 * Everyone else who can see the room, signed in or not, gets its public card, and the editor still gets the spot and route.
 */
import { NextRequest } from 'next/server';
import { GET as GET_ONE } from '@/app/api/bots/[id]/route';
import { GET as GET_LIST } from '@/app/api/bots/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageThisBot } from '@/lib/bot-permissions';
import { mayReadRoomBots } from '@/lib/bot-room-access';
import { PRIVATE_BOT_FIELDS, toPublicBotCard } from '@/lib/bot-public-card';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), findMany: jest.fn() },
    room: { findUnique: jest.fn(), findFirst: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/auth', () => ({
  requireAuth: jest.fn(),
}));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn(), canManageThisBot: jest.fn() }));
jest.mock('@/lib/bot-room-access', () => ({ mayReadRoomBots: jest.fn() }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));

const db = prisma as unknown as {
  bot: { findUnique: jest.Mock; findMany: jest.Mock };
  room: { findUnique: jest.Mock };
};
const session = getSessionUser as jest.Mock;
const manages = canManageThisBot as jest.Mock;
const mayRead = mayReadRoomBots as jest.Mock;

const ROOM_ID = '3f1c7a5e-9a52-4a52-8d3b-0c0f6d2f9a11';
const ADMIN_TOKEN = 'admin-secret';
const SPOT = { assignedSpace: { x: 4, y: 7, width: 3, height: 2 }, loop: [{ x: 1, y: 1 }, { x: 2, y: 2 }] };

const PRIVATE_VALUES = {
  chatInstructions: 'Secret chat steering',
  movementInstructions: 'Secret movement steering',
  aiProviderRef: 'key-123',
  aiModel: 'secret-model',
  toolTimeoutSeconds: 30,
  maxReplyTokens: 500,
  maxSteps: 4,
};

function room(isPublic: boolean) {
  return {
    id: ROOM_ID,
    worldId: 'w1',
    slug: 'lobby',
    name: 'Lobby',
    description: null,
    mapUrl: null,
    wamUrl: null,
    isPublic,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    world: { id: 'w1', isPublic, universe: { id: 'u1', isPublic, ownerId: 'u-owner' } },
  };
}

function dbBot(isPublic = true, extra: Record<string, unknown> = {}) {
  return {
    id: 'bot-1',
    roomId: ROOM_ID,
    name: 'Nora',
    description: 'Greets visitors',
    characterTextureId: 'woka-1',
    companionTextureId: 'dog',
    enabled: true,
    behaviorType: 'patrol',
    behaviorConfig: { ...SPOT, vision: { choice: 'another', keyId: 'key-vision', model: 'vision-model' }, showToolCalls: true },
    createdById: 'u-maker',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    createdBy: { id: 'u-maker', name: 'Maker' },
    updatedBy: null,
    room: room(isPublic),
    ...PRIVATE_VALUES,
    ...extra,
  };
}

const idParams = { params: Promise.resolve({ id: 'bot-1' }) };

function readOne(token?: string) {
  return GET_ONE(
    new NextRequest('http://localhost:3333/api/bots/bot-1', { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    idParams,
  );
}

function readList(token?: string) {
  return GET_LIST(
    new NextRequest(`http://localhost:3333/api/bots?roomId=${ROOM_ID}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
  );
}

function expectPublicCard(card: Record<string, any>) {
  for (const field of PRIVATE_BOT_FIELDS) expect(card).not.toHaveProperty(field);
  expect(JSON.stringify(card)).not.toMatch(/Secret|key-123|secret-model|key-vision/);
  // what the editor and the room need stays
  expect(card).toMatchObject({
    id: 'bot-1',
    name: 'Nora',
    description: 'Greets visitors',
    characterTextureId: 'woka-1',
    companionTextureId: 'dog',
    enabled: true,
    behaviorType: 'patrol',
    createdBy: { id: 'u-maker', name: 'Maker' },
    room: { id: ROOM_ID, name: 'Lobby' },
  });
  expect(card.behaviorConfig.assignedSpace).toEqual(SPOT.assignedSpace);
  expect(card.behaviorConfig.loop).toEqual(SPOT.loop);
  expect(card.behaviorConfig.showToolCalls).toBe(true);
}

function expectFullBot(bot: Record<string, any>) {
  expect(bot).toMatchObject(PRIVATE_VALUES);
  expect(bot.behaviorConfig.vision).toEqual({ choice: 'another', keyId: 'key-vision', model: 'vision-model' });
  expect(bot.behaviorConfig.assignedSpace).toEqual(SPOT.assignedSpace);
}

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  session.mockReset().mockResolvedValue(null);
  manages.mockReset().mockResolvedValue(false);
  mayRead.mockReset().mockResolvedValue(true);
  db.bot.findUnique.mockReset().mockResolvedValue(dbBot());
  db.bot.findMany.mockReset().mockResolvedValue([dbBot()]);
  db.room.findUnique.mockReset().mockResolvedValue(room(true));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe.each([
  ['GET /api/bots/:id', async (token?: string) => ({ response: await readOne(token), pick: (b: unknown) => b as Record<string, any> })],
  ['GET /api/bots?roomId=', async (token?: string) => ({ response: await readList(token), pick: (b: unknown) => (b as Record<string, any>[])[0] })],
])('%s', (_name, read) => {
  it('gives someone signed out in a public room the public card only', async () => {
    const { response, pick } = await read();
    expect(response.status).toBe(200);
    expectPublicCard(pick(await response.json()));
    expect(manages).not.toHaveBeenCalled();
  });

  it('gives a signed-in member without Manage bots the public card only', async () => {
    session.mockResolvedValue({ id: 'u-member', email: 'member@example.com' });
    const { response, pick } = await read();
    expect(response.status).toBe(200);
    expectPublicCard(pick(await response.json()));
    expect(manages).toHaveBeenCalledWith('u-member', 'member@example.com', expect.objectContaining({ id: 'bot-1', roomId: ROOM_ID }), { creatorPasses: false });
  });

  it('gives a member of a members-only room without Manage this bot the public card only', async () => {
    db.bot.findUnique.mockResolvedValue(dbBot(false));
    db.bot.findMany.mockResolvedValue([dbBot(false)]);
    db.room.findUnique.mockResolvedValue(room(false));
    session.mockResolvedValue({ id: 'u-member', email: 'member@example.com' });
    const { response, pick } = await read();
    expect(response.status).toBe(200);
    expectPublicCard(pick(await response.json()));
  });

  it('gives someone who manages the bot exactly what they got before', async () => {
    session.mockResolvedValue({ id: 'u-admin', email: 'admin@example.com' });
    manages.mockResolvedValue(true);
    const { response, pick } = await read();
    expect(response.status).toBe(200);
    expectFullBot(pick(await response.json()));
  });

  it('gives the bot server its admin token and the whole bot', async () => {
    const { response, pick } = await read(ADMIN_TOKEN);
    expect(response.status).toBe(200);
    expectFullBot(pick(await response.json()));
  });

  it('still keeps a signed-out person out of a members-only room', async () => {
    db.bot.findUnique.mockResolvedValue(dbBot(false));
    db.room.findUnique.mockResolvedValue(room(false));
    const { response } = await read();
    expect(response.status).toBe(401);
  });
});

describe('GET /api/bots?roomId= with several bots', () => {
  it('decides for each bot on its own: managed ones in full, the rest as public cards', async () => {
    db.bot.findMany.mockResolvedValue([
      dbBot(true, { id: 'bot-1' }),
      dbBot(true, { id: 'bot-2', chatInstructions: 'Second secret', aiProviderRef: 'key-456' }),
    ]);
    session.mockResolvedValue({ id: 'u-keeper', email: 'keeper@example.com' });
    manages.mockImplementation(async (_user: string, _email: string, bot: { id: string }) => bot.id === 'bot-2');
    const bots = (await (await readList()).json()) as Record<string, any>[];
    expect(bots).toHaveLength(2);
    expectPublicCard(bots[0]);
    expect(bots[1]).toMatchObject({ id: 'bot-2', chatInstructions: 'Second secret', aiProviderRef: 'key-456' });
  });
});

describe('toPublicBotCard', () => {
  it('drops the private parts and the Vision pick, and keeps everything else', () => {
    const card = toPublicBotCard({ id: 'b', name: 'Nora', ...PRIVATE_VALUES, behaviorConfig: { ...SPOT, vision: { choice: 'this' } } });
    expect(card).toEqual({ id: 'b', name: 'Nora', behaviorConfig: SPOT });
  });

  it('copes with a bot with no behavior config', () => {
    expect(toPublicBotCard({ id: 'b', chatInstructions: 'x', behaviorConfig: null })).toEqual({ id: 'b', behaviorConfig: null });
  });
});
