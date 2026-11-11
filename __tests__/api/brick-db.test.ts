/**
 * A Brick (game #1992) against a real database: what only the database can show. A Brick is stored with an owner and no
 * room, the database refuses a bot with neither or both, the filters that are written for room bots really leave a Brick
 * out (or really keep it in, where it belongs), and deleting a room deletes its room bots and no Brick. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { ROOM_BOTS_ONLY } from '@/lib/brick';
import { canManageThisBot } from '@/lib/bot-permissions';
import { checkBotAccess } from '@/lib/bot-access';
import { checkKeyForBot } from '@/lib/ai-key-pay';
import { deleteWithHiddenBotData, hiddenBotIds, loadBotPrivacy } from '@/lib/bot-privacy';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';
import { GET as listConfigurations } from '@/app/api/bots/configuration/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const ADMIN_TOKEN = `token-${tag}`;
let sara = '';
let omar = '';
let universeId = '';
let closedUniverseId = '';
let roomId = '';
let closedRoomId = '';
let roomBotId = '';
let closedRoomBotId = '';
let brickId = '';

const tokenBefore = process.env.ADMIN_API_TOKEN;

run('a Brick in a real database', () => {
  beforeAll(async () => {
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
    const person = (name: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    const place = async (slug: string) => {
      const universe = await prisma.universe.create({ data: { slug: `${slug}-${tag}`, name: slug, ownerId: omar } });
      const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
      const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
      return { universeId: universe.id, roomId: room.id };
    };
    ({ universeId, roomId } = await place('open'));
    ({ universeId: closedUniverseId, roomId: closedRoomId } = await place('closed'));
    const roomBot = (inRoom: string, name: string) =>
      prisma.bot.create({ data: { roomId: inRoom, name, createdById: sara, aiProviderRef: `key-${tag}`, aiModel: 'old-model', behaviorConfig: {} } });
    roomBotId = (await roomBot(roomId, 'Nora')).id;
    closedRoomBotId = (await roomBot(closedRoomId, 'Atlas')).id;
    const brick = await createBrick({ ownerId: sara, name: 'Brick' });
    brickId = brick.id;
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: { in: [universeId, closedUniverseId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar] } } });
    if (tokenBefore === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = tokenBefore;
    await prisma.$disconnect();
  });

  it('stores a Brick with an owner and no room, owned by the person who made it, on Universe AI', async () => {
    const brick = await prisma.bot.findUniqueOrThrow({ where: { id: brickId } });
    expect(brick).toMatchObject({ roomId: null, ownerId: sara, createdById: sara, aiProviderRef: UNIVERSE_AI_REF, enabled: true });
  });

  it('leaves a room bot with its room and no owner, whoever made it', async () => {
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: roomBotId } });
    expect(bot).toMatchObject({ roomId, ownerId: null, createdById: sara });
  });

  it('refuses a bot with neither a room nor an owner, and a bot with both', async () => {
    await expect(prisma.bot.create({ data: { name: 'Nowhere', behaviorConfig: {} } })).rejects.toThrow();
    await expect(prisma.bot.create({ data: { name: 'Both', roomId, ownerId: sara, behaviorConfig: {} } })).rejects.toThrow();
    await expect(prisma.bot.update({ where: { id: brickId }, data: { roomId } })).rejects.toThrow();
    await expect(prisma.bot.update({ where: { id: roomBotId }, data: { ownerId: sara } })).rejects.toThrow();
    await expect(prisma.bot.update({ where: { id: roomBotId }, data: { roomId: null } })).rejects.toThrow();
  });

  it('is managed and used by its owner only', async () => {
    const brick = await prisma.bot.findUniqueOrThrow({ where: { id: brickId }, select: { id: true, createdById: true, roomId: true, ownerId: true } });
    expect(await canManageThisBot(sara, null, brick, { creatorPasses: false })).toBe(true);
    expect(await canManageThisBot(omar, null, brick, { creatorPasses: true })).toBe(false);
    expect(await checkBotAccess({ botId: brickId, action: 'dm', person: { signedIn: true, identifier: `sara-${tag}@example.test` } })).toMatchObject({ allowed: true });
    expect(await checkBotAccess({ botId: brickId, action: 'dm', person: { signedIn: true, identifier: `omar-${tag}@example.test` } })).toMatchObject({ allowed: false, code: 'not_allowed' });
    expect(await checkKeyForBot({ keyId: `key-${tag}`, keyOwnerId: sara, bot: brick })).toEqual({ ok: true, lendModels: null });
    expect(await checkKeyForBot({ keyId: `key-${tag}`, keyOwnerId: omar, bot: brick })).toEqual({ ok: false, reason: 'no-access' });
  });

  it('always hides what it wrote, and is counted among the bots that hide', async () => {
    expect(await loadBotPrivacy(brickId)).toMatchObject({ hidden: true });
    expect(await loadBotPrivacy(roomBotId)).toMatchObject({ hidden: false });
    const hidden = await hiddenBotIds();
    expect(hidden).toContain(brickId);
    expect(hidden).not.toContain(roomBotId);
  });

  it('is left out by the room bots filter, which keeps every room bot', async () => {
    const mine = await prisma.bot.findMany({ where: { createdById: sara, ...ROOM_BOTS_ONLY }, select: { id: true } });
    expect(mine.map((bot) => bot.id).sort()).toEqual([roomBotId, closedRoomBotId].sort());
  });

  it('is not in the list a bot server reads, which still holds the room bots', async () => {
    const response = await listConfigurations(
      new NextRequest(`http://localhost/api/bots/configuration?userId=${sara}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }),
    );
    expect(response.status).toBe(200);
    const listed = ((await response.json()) as { botId: string; roomUrl: string }[]).map((bot) => bot.botId);
    expect(listed.sort()).toEqual([roomBotId, closedRoomBotId].sort());
  });

  it('follows its owner’s key to a new model when a lend closes that model to one universe (the filter in lib/ai-key-edit.ts)', async () => {
    await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: `key-${tag}`, aiModel: 'old-model' } });
    const moving = await prisma.bot.findMany({
      where: { aiProviderRef: `key-${tag}`, aiModel: 'old-model', OR: [{ roomId: null }, { NOT: { room: { world: { universeId: { in: [closedUniverseId] } } } } }] },
      select: { id: true },
    });
    expect(moving.map((bot) => bot.id).sort()).toEqual([brickId, roomBotId].sort());
  });

  it('deletes a room’s bots with the room, as today, and no Brick', async () => {
    await deleteWithHiddenBotData({ roomId: closedRoomId }, () => prisma.room.delete({ where: { id: closedRoomId } }));
    expect(await prisma.bot.findUnique({ where: { id: closedRoomBotId } })).toBeNull();
    expect(await prisma.bot.findUnique({ where: { id: roomBotId } })).not.toBeNull();
    expect(await prisma.bot.findUnique({ where: { id: brickId } })).not.toBeNull();
  });

  it('goes with its owner’s account', async () => {
    const leaving = await prisma.user.create({ data: { uuid: `leaving-${tag}`, name: 'leaving' } });
    const theirs = await createBrick({ ownerId: leaving.id, name: 'Brick' });
    await prisma.user.delete({ where: { id: leaving.id } });
    expect(await prisma.bot.findUnique({ where: { id: theirs.id } })).toBeNull();
  });
});
