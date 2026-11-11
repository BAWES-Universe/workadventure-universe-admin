/**
 * The Brick everyone gets (game #1995) against a real database: what only the database can show. One account gets one
 * Brick however many requests come at once, a Brick deleted on purpose is never made again, and the Brick draws on the
 * same Universe AI replies as every other bot the person talks to. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL
 * to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-default-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { DEFAULT_BRICK_LOOK, DEFAULT_BRICK_NAME, ensureDefaultBrick, isDefaultBrick, listBricks } from '@/lib/brick-default';
import { createBrick } from '@/lib/brick-create';
import { checkReplyAllowance } from '@/lib/reply-limits';
import { getUniverseAiReplyLimits } from '@/lib/bot-limits';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
let universeId = '';
let providerId = '';

async function person(name: string): Promise<{ id: string; uuid: string }> {
  const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
  people.push(user.id);
  return { id: user.id, uuid: user.uuid };
}

const bricksOf = (ownerId: string) => prisma.bot.findMany({ where: { ownerId }, select: { id: true } });

run('the Brick everyone gets, in a real database', () => {
  afterAll(async () => {
    if (universeId) await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.replyWindow.deleteMany({ where: { key: { in: people.map((id) => `ua:person:${id}`) } } });
    if (providerId) await prisma.botsAiProvider.deleteMany({ where: { providerId } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('makes one Brick the first time, owned by the person, on Universe AI, and the same Brick every time after', async () => {
    const sara = await person('sara');
    const first = await ensureDefaultBrick(sara.id);
    expect(first).toMatchObject({ made: true, deleted: false, brick: { name: DEFAULT_BRICK_NAME, characterTextureId: DEFAULT_BRICK_LOOK, enabled: true, isDefault: true } });
    const stored = await prisma.bot.findUniqueOrThrow({ where: { id: first.brick!.id } });
    expect(stored).toMatchObject({ roomId: null, ownerId: sara.id, createdById: sara.id, aiProviderRef: UNIVERSE_AI_REF, chatInstructions: null });

    const again = await ensureDefaultBrick(sara.id);
    expect(again).toMatchObject({ made: false, deleted: false });
    expect(again.brick!.id).toBe(first.brick!.id);
    expect(await bricksOf(sara.id)).toHaveLength(1);
    expect(await isDefaultBrick(first.brick!.id)).toBe(true);
  });

  it('makes one Brick when many requests come at the same moment: two devices, or a double tap', async () => {
    const omar = await person('omar');
    const answers = await Promise.all(Array.from({ length: 12 }, () => ensureDefaultBrick(omar.id)));
    expect(new Set(answers.map((answer) => answer.brick?.id)).size).toBe(1);
    expect(answers.filter((answer) => answer.made)).toHaveLength(1);
    expect(answers.every((answer) => !answer.deleted)).toBe(true);
    expect(await bricksOf(omar.id)).toHaveLength(1);
    expect(await prisma.defaultBrick.count({ where: { userId: omar.id } })).toBe(1);
  });

  it('never makes it again once its owner deleted it, from any device, however often', async () => {
    const lina = await person('lina');
    const { brick } = await ensureDefaultBrick(lina.id);
    await prisma.bot.delete({ where: { id: brick!.id } });

    const answers = await Promise.all(Array.from({ length: 6 }, () => ensureDefaultBrick(lina.id)));
    for (const answer of answers) expect(answer).toEqual({ brick: null, made: false, deleted: true });
    expect(await bricksOf(lina.id)).toHaveLength(0);
    expect(await prisma.defaultBrick.findUnique({ where: { userId: lina.id } })).toMatchObject({ botId: null });
  });

  it('lists a person’s own Bricks, the one everyone gets first, and nobody else’s', async () => {
    const noor = await person('noor');
    const other = await person('other');
    const recipes = await createBrick({ ownerId: noor.id, name: 'Recipe Brick' });
    const { brick } = await ensureDefaultBrick(noor.id);
    await ensureDefaultBrick(other.id);

    const mine = await listBricks(noor.id);
    expect(mine.map((card) => [card.id, card.isDefault])).toEqual([[brick!.id, true], [recipes.id, false]]);
    expect(await isDefaultBrick(recipes.id)).toBe(false);
  });

  it('goes with its owner’s account, and takes the account’s row with it', async () => {
    const leaving = await prisma.user.create({ data: { uuid: `leaving-${tag}`, name: 'leaving' } });
    const { brick } = await ensureDefaultBrick(leaving.id);
    await prisma.user.delete({ where: { id: leaving.id } });
    expect(await prisma.bot.findUnique({ where: { id: brick!.id } })).toBeNull();
    expect(await prisma.defaultBrick.findUnique({ where: { userId: leaving.id } })).toBeNull();
  });

  it('gives nobody a second allowance: replies from a room bot and from the Brick fill the same Universe AI window', async () => {
    const maha = await person('maha');
    const owner = await person('owner');
    const { brick } = await ensureDefaultBrick(maha.id);
    const universe = await prisma.universe.create({ data: { slug: `allow-${tag}`, name: 'allow', ownerId: owner.id } });
    universeId = universe.id;
    const world = await prisma.world.create({ data: { universeId, slug: 'hq', name: 'HQ' } });
    const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
    const roomBot = await prisma.bot.create({ data: { roomId: room.id, name: 'Nora', createdById: owner.id, aiProviderRef: UNIVERSE_AI_REF, behaviorConfig: {} } });
    providerId = `p-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId, name: `Server ${tag}`, type: 'openai', enabled: true } });

    const limit = (await getUniverseAiReplyLimits()).signedIn;
    const asked = { userId: maha.uuid, isGuest: false, source: 'universe-ai' };
    // The window opens with the first reply asked for; every reply before the last one is allowed, on either bot
    expect(await checkReplyAllowance(brick!.id, asked)).toEqual({ allowed: true });
    const reply = (botId: string) => ({ botId, providerId, talkedUserId: maha.uuid, talkedPersonId: maha.id, talkedGuest: false, keyOwnerId: null });
    // All but one of the replies came from the room bot, the last one from the Brick
    await prisma.botsAiUsage.createMany({ data: Array.from({ length: limit - 1 }, () => reply(roomBot.id)) });
    expect(await checkReplyAllowance(brick!.id, asked)).toEqual({ allowed: true });
    await prisma.botsAiUsage.create({ data: reply(brick!.id) });

    // Now the one window is full, for the Brick and for the room bot alike
    expect(await checkReplyAllowance(brick!.id, asked)).toMatchObject({ allowed: false, limit: 'universe-ai', who: 'maker' });
    expect(await checkReplyAllowance(roomBot.id, asked)).toMatchObject({ allowed: false, limit: 'universe-ai' });
    await prisma.botsAiUsage.deleteMany({ where: { talkedPersonId: maha.id } });
    await prisma.botReplyLimitHit.deleteMany({ where: { botId: { in: [brick!.id, roomBot.id] } } });
  });
});
