/**
 * More Bricks, deleting one and Undo (game #1996) against a real database: what only the database can show. A deleted
 * Brick is off at once and stays off, Undo gives it back as it was and brings nothing back that ended, what it made
 * stays, and a suggestion is shown once per person and topic however many ask at the same moment. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-delete-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn(async () => undefined) }));

import { prisma } from '@/lib/db';
import { ensureDefaultBrick, listBricks, listDeletedBricks } from '@/lib/brick-default';
import { deleteBrick, removeGoneBricks, undoBrickDelete } from '@/lib/brick-delete';
import { BRICK_LOOKS, makeBrick, makeBrickFromChat, bricksForChat } from '@/lib/brick-make';
import { answerOffer, claimOffer, offersSoFar } from '@/lib/brick-offers';
import { ENDED_BY_DELETE } from '@/lib/bot-actions';
import { checkBotAccess } from '@/lib/bot-access';
import { credentialsForBot } from '@/lib/bot-ai-credentials';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
const artifacts: string[] = [];

async function person(name: string): Promise<{ id: string; uuid: string; email: string }> {
  const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
  people.push(user.id);
  return { id: user.id, uuid: user.uuid, email: user.email! };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-12T09:00:00Z');
const later = (days: number) => new Date(NOW.getTime() + days * DAY);
const row = (id: string) => prisma.bot.findUnique({ where: { id }, select: { enabled: true, deletedAt: true, goneAt: true, enabledBeforeDelete: true } });

function grant(botId: string, over: Record<string, unknown> = {}) {
  return prisma.botActionGrant.create({
    data: {
      botId,
      requesterKey: `user:${tag}`,
      conversationKey: `dm:${tag}`,
      toolName: 'create_issue',
      heading: 'makesNew',
      toolFingerprint: 'f1',
      policyRevision: 1,
      scope: { fixed: {}, varies: [] },
      idleMinutes: 30,
      idleExpiresAt: later(1),
      absoluteExpiresAt: later(1),
      ...over,
    },
  });
}

function request(botId: string, status: string) {
  return prisma.botActionRequest.create({
    data: {
      botId,
      proposalKey: `p-${randomUUID()}`,
      requesterKey: `user:${tag}`,
      conversationKey: `dm:${tag}`,
      toolName: 'create_issue',
      heading: 'makesNew',
      toolFingerprint: 'f1',
      policyRevision: 1,
      arguments: 'enc',
      argumentsDigest: 'd'.repeat(64),
      status,
      reviewExpiresAt: later(1),
      ...(status === 'waiting' ? {} : { approvedAt: NOW, startBy: later(1) }),
    },
  });
}

run('more Bricks, deleting one and Undo, in a real database', () => {
  afterAll(async () => {
    await prisma.artifact.deleteMany({ where: { id: { in: artifacts } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('makes more Bricks for one person, each theirs with no room, and gives each the next colour none of theirs wears', async () => {
    const sara = await person('sara');
    const first = await ensureDefaultBrick(sara.id);
    const recipes = await makeBrick(sara.id, { name: 'Recipe Brick', description: 'Keeps your mum’s recipes', hello: 'Send me the first recipe.' });
    const garden = await makeBrick(sara.id, { name: 'Garden Brick' });
    const picked = await makeBrick(sara.id, { name: 'Teal Brick', characterTextureId: 'brick-teal' });
    expect(first.brick!.characterTextureId).toBe(BRICK_LOOKS[0]);
    expect(recipes).toMatchObject({ characterTextureId: BRICK_LOOKS[1], isDefault: false, enabled: true, hello: 'Send me the first recipe.', description: 'Keeps your mum’s recipes' });
    expect(garden).toMatchObject({ characterTextureId: BRICK_LOOKS[2], hello: null, description: null });
    expect(picked.characterTextureId).toBe('brick-teal');
    expect((await listBricks(sara.id)).map((card) => card.name)).toEqual(['Brick', 'Recipe Brick', 'Garden Brick', 'Teal Brick']);
    expect(await prisma.bot.count({ where: { ownerId: sara.id, roomId: null, createdById: sara.id, aiProviderRef: 'universe-ai' } })).toBe(4);
  });

  it('makes one from the person’s own chat with their Brick, opens the one of that name instead of making it twice, and makes none for anyone else', async () => {
    const omar = await person('omar');
    const lina = await person('lina');
    const { brick } = await ensureDefaultBrick(omar.id);
    const made = await makeBrickFromChat(brick!.id, { userId: omar.email, name: 'Recipe Brick', description: 'Keeps your mum’s recipes' });
    expect(made).toMatchObject({ ok: true, made: true, brick: { name: 'Recipe Brick' } });
    const again = await makeBrickFromChat(brick!.id, { userId: omar.uuid, name: 'recipe brick' });
    expect(again).toMatchObject({ ok: true, made: false });
    if (!made.ok || !again.ok) throw new Error('expected both to answer');
    expect(again.brick.id).toBe(made.brick.id);
    expect(again.bricks).toHaveLength(2);
    const second = await makeBrickFromChat(brick!.id, { userId: omar.uuid, name: 'Recipe Brick', evenIfThere: true });
    expect(second).toMatchObject({ ok: true, made: true });
    expect((await bricksForChat(brick!.id, omar.uuid))!.map((card) => card.name)).toEqual(['Brick', 'Recipe Brick', 'Recipe Brick']);

    // Someone else in a chat with Omar's Brick gets nothing, and neither does a name nobody has
    expect(await makeBrickFromChat(brick!.id, { userId: lina.uuid, name: 'Mine' })).toEqual({ ok: false, status: 404, error: 'Brick not found' });
    expect(await makeBrickFromChat(brick!.id, { userId: 'nobody', name: 'Mine' })).toMatchObject({ ok: false, status: 404 });
    expect(await bricksForChat(brick!.id, lina.uuid)).toBeNull();
    expect(await prisma.bot.count({ where: { ownerId: lina.id } })).toBe(0);
  });

  it('stops a deleted Brick at once: off, nobody’s to use, no key for it, every approval ended, and listed under Deleted with its day', async () => {
    const maya = await person('maya');
    const brick = await makeBrick(maya.id, { name: 'Studio Brick' });
    const live = await grant(brick.id);
    const withdrawn = await grant(brick.id, { revokedAt: later(-1), revokedReason: 'owner' });
    const waiting = await request(brick.id, 'waiting');
    const running = await request(brick.id, 'running');

    const deleted = await deleteBrick(brick.id, maya.id, NOW);
    expect(deleted).toMatchObject({ id: brick.id, name: 'Studio Brick', enabled: false, deletedAt: NOW.toISOString(), goneAt: later(7).toISOString() });
    expect(await row(brick.id)).toEqual({ enabled: false, deletedAt: NOW, goneAt: later(7), enabledBeforeDelete: true });

    expect(await listBricks(maya.id)).toEqual([]);
    expect((await listDeletedBricks(maya.id, NOW)).map((card) => card.id)).toEqual([brick.id]);
    expect(await checkBotAccess({ botId: brick.id, action: 'dm', person: { signedIn: true, identifier: maya.email } })).toMatchObject({ allowed: false });
    expect(await credentialsForBot(brick.id)).toEqual({ status: 404, error: 'Bot not found' });

    expect(await prisma.botActionGrant.findUnique({ where: { id: live.id } })).toMatchObject({ revokedAt: NOW, revokedReason: ENDED_BY_DELETE });
    expect(await prisma.botActionGrant.findUnique({ where: { id: withdrawn.id } })).toMatchObject({ revokedAt: later(-1), revokedReason: 'owner' });
    expect(await prisma.botActionRequest.findUnique({ where: { id: waiting.id } })).toMatchObject({ status: 'closed', closedReason: 'revoked' });
    // One that is already running keeps its own record: its outcome is not known, so it is never sent a second time
    expect(await prisma.botActionRequest.findUnique({ where: { id: running.id } })).toMatchObject({ status: 'running' });

    // A second tap changes nothing: the same Brick, the same day
    expect(await deleteBrick(brick.id, maya.id, later(1))).toMatchObject({ deletedAt: NOW.toISOString(), goneAt: later(7).toISOString() });
  });

  it('keeps a deleted Brick off whatever is saved: the database refuses to switch it on', async () => {
    const noor = await person('noor');
    const brick = await makeBrick(noor.id, { name: 'Off Brick' });
    await deleteBrick(brick.id, noor.id, NOW);
    await expect(prisma.bot.update({ where: { id: brick.id }, data: { enabled: true } })).rejects.toThrow();
    expect((await row(brick.id))!.enabled).toBe(false);
  });

  it('gives it back with Undo as it was: its switch, its chat and what it remembers, and nothing that ended', async () => {
    const zain = await person('zain');
    const on = await makeBrick(zain.id, { name: 'On Brick' });
    const off = await makeBrick(zain.id, { name: 'Off Brick' });
    await prisma.bot.update({ where: { id: off.id }, data: { enabled: false } });
    await prisma.botsMemory.create({ data: { botId: on.id, userUuid: zain.uuid, userId: zain.id, memories: ['likes tea'] } });
    await prisma.botsConversation.create({ data: { botId: on.id, userUuid: zain.uuid, userId: zain.id, messages: [], startedAt: NOW, endedAt: NOW, messageCount: 0 } });
    const live = await grant(on.id);
    const withdrawn = await grant(on.id, { revokedAt: later(-1), revokedReason: 'owner' });

    await deleteBrick(on.id, zain.id, NOW);
    await deleteBrick(off.id, zain.id, NOW);
    expect(await undoBrickDelete(on.id, zain.id, later(3))).toMatchObject({ id: on.id, enabled: true });
    expect(await undoBrickDelete(off.id, zain.id, later(3))).toMatchObject({ id: off.id, enabled: false });
    expect(await row(on.id)).toEqual({ enabled: true, deletedAt: null, goneAt: null, enabledBeforeDelete: null });
    expect(await listDeletedBricks(zain.id, later(3))).toEqual([]);
    expect(await checkBotAccess({ botId: on.id, action: 'dm', person: { signedIn: true, identifier: zain.email } })).toMatchObject({ allowed: true });
    expect(await prisma.botsMemory.count({ where: { botId: on.id } })).toBe(1);
    expect(await prisma.botsConversation.count({ where: { botId: on.id } })).toBe(1);

    // Under the permissions that hold now: what ended at the delete stays ended, and so does what was withdrawn before it
    expect((await prisma.botActionGrant.findUnique({ where: { id: live.id } }))!.revokedAt).toEqual(NOW);
    expect((await prisma.botActionGrant.findUnique({ where: { id: withdrawn.id } }))!.revokedAt).toEqual(later(-1));

    // A second Undo answers the same Brick, back already
    expect(await undoBrickDelete(on.id, zain.id, later(3))).toMatchObject({ id: on.id, enabled: true });
  });

  it('is nobody else’s to delete or to bring back, and a room bot is never deleted here', async () => {
    const hala = await person('hala');
    const sami = await person('sami');
    const brick = await makeBrick(hala.id, { name: 'Hala’s Brick' });
    expect(await deleteBrick(brick.id, sami.id, NOW)).toBeNull();
    expect((await row(brick.id))!.deletedAt).toBeNull();
    await deleteBrick(brick.id, hala.id, NOW);
    expect(await undoBrickDelete(brick.id, sami.id, later(1))).toBeNull();
    expect((await row(brick.id))!.deletedAt).toEqual(NOW);
    expect(await deleteBrick(randomUUID(), hala.id, NOW)).toBeNull();
  });

  it('cannot be brought back once its days are over, is in no list then, and is removed for good with its chat and memory while what it made stays', async () => {
    const reem = await person('reem');
    const other = await person('other');
    const brick = await makeBrick(reem.id, { name: 'Gone Brick' });
    const kept = await makeBrick(reem.id, { name: 'Kept Brick' });
    const waiting = await makeBrick(other.id, { name: 'Waiting Brick' });
    await prisma.botsMemory.create({ data: { botId: brick.id, userUuid: reem.uuid, userId: reem.id, memories: ['x'] } });
    await prisma.botsConversation.create({ data: { botId: brick.id, userUuid: reem.uuid, userId: reem.id, messages: [], startedAt: NOW, endedAt: NOW, messageCount: 0 } });
    const artifact = await prisma.artifact.create({ data: { ownerId: reem.id, makerBotId: brick.id, makerName: 'Gone Brick', title: 'Menu', kind: 'markdown' } });
    artifacts.push(artifact.id);

    await deleteBrick(brick.id, reem.id, NOW);
    await deleteBrick(waiting.id, other.id, later(5));

    // The day itself is already too late
    expect(await undoBrickDelete(brick.id, reem.id, later(7))).toBeNull();
    expect(await listDeletedBricks(reem.id, later(7))).toEqual([]);
    expect((await row(brick.id))!.deletedAt).toEqual(NOW);

    // Before its day nothing is removed
    expect(await removeGoneBricks(later(6), reem.id)).toEqual([]);
    // For one person: theirs only. The other person's still waits, and a Brick that was never deleted is never touched.
    expect(await removeGoneBricks(later(8), reem.id)).toEqual([brick.id]);
    expect(await row(brick.id)).toBeNull();
    expect(await row(kept.id)).not.toBeNull();
    expect((await row(waiting.id))!.deletedAt).toEqual(later(5));
    expect(await prisma.botsMemory.count({ where: { botId: brick.id } })).toBe(0);
    expect(await prisma.botsConversation.count({ where: { botId: brick.id } })).toBe(0);
    expect(await prisma.artifact.findUnique({ where: { id: artifact.id } })).toMatchObject({ ownerId: reem.id, makerBotId: brick.id, title: 'Menu' });

    // For everyone, when the bot server asks
    expect(await removeGoneBricks(later(13))).toContain(waiting.id);
    expect(await row(waiting.id)).toBeNull();
  });

  it('never makes the Brick everyone gets again: not while it waits deleted, not after Undo twice, and not after it is gone for good', async () => {
    const dana = await person('dana');
    const { brick } = await ensureDefaultBrick(dana.id);
    await deleteBrick(brick!.id, dana.id, NOW);
    expect(await ensureDefaultBrick(dana.id)).toEqual({ brick: null, made: false, deleted: true });
    expect((await listDeletedBricks(dana.id, NOW))[0]).toMatchObject({ id: brick!.id, isDefault: true });
    await undoBrickDelete(brick!.id, dana.id, later(1));
    expect(await ensureDefaultBrick(dana.id)).toMatchObject({ made: false, deleted: false, brick: { id: brick!.id, isDefault: true } });
    await deleteBrick(brick!.id, dana.id, later(2));
    await removeGoneBricks(later(10), dana.id);
    expect(await ensureDefaultBrick(dana.id)).toEqual({ brick: null, made: false, deleted: true });
    expect(await prisma.bot.count({ where: { ownerId: dana.id } })).toBe(0);
  });

  it('shows a suggestion once per person and topic, however many ask at once, and "Not now" holds from every Brick of theirs', async () => {
    const faye = await person('faye');
    const gus = await person('gus');
    const { brick } = await ensureDefaultBrick(faye.id);
    const second = await makeBrick(faye.id, { name: 'Second' });
    const theirs = await ensureDefaultBrick(gus.id);

    expect(await offersSoFar(brick!.id, faye.uuid)).toEqual({ ok: true, after: 3, topics: [] });
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => claimOffer(i % 2 ? brick!.id : second.id, { userId: faye.uuid, topic: i % 2 ? 'Recipes!' : ' recipes ' })));
    expect(answers.filter((answer) => answer.ok && answer.show)).toHaveLength(1);
    expect(answers.every((answer) => answer.ok && answer.topic === 'recipes')).toBe(true);

    expect(await answerOffer(brick!.id, { userId: faye.email, topic: 'Recipes', answer: 'not_now' })).toEqual({ ok: true, kept: true });
    // The first answer stands
    expect(await answerOffer(second.id, { userId: faye.uuid, topic: 'recipes', answer: 'made' })).toEqual({ ok: true, kept: false });
    expect(await offersSoFar(second.id, faye.uuid)).toEqual({ ok: true, after: 3, topics: [{ topic: 'recipes', answer: 'not_now' }] });
    expect(await claimOffer(second.id, { userId: faye.uuid, topic: 'recipes' })).toEqual({ ok: true, show: false, topic: 'recipes' });

    // Another topic is its own, and another person's same topic is theirs
    expect(await claimOffer(brick!.id, { userId: faye.uuid, topic: 'Workouts' })).toMatchObject({ show: true });
    expect(await claimOffer(theirs.brick!.id, { userId: gus.uuid, topic: 'recipes' })).toMatchObject({ show: true });

    // Only through a Brick of their own, and a topic has to name something
    expect(await claimOffer(theirs.brick!.id, { userId: faye.uuid, topic: 'travel' })).toEqual({ ok: false, status: 404, error: 'Brick not found' });
    expect(await offersSoFar(brick!.id, gus.uuid)).toMatchObject({ ok: false, status: 404 });
    expect(await claimOffer(brick!.id, { userId: faye.uuid, topic: ' ?! ' })).toMatchObject({ ok: false, status: 400 });
    expect(await prisma.brickOffer.count({ where: { userId: faye.id } })).toBe(2);
  });

  it('asks nothing through a Brick that waits deleted: it makes no Brick and suggests none', async () => {
    const ivy = await person('ivy');
    const { brick } = await ensureDefaultBrick(ivy.id);
    await deleteBrick(brick!.id, ivy.id, NOW);
    expect(await makeBrickFromChat(brick!.id, { userId: ivy.uuid, name: 'Mine' })).toMatchObject({ ok: false, status: 404 });
    expect(await claimOffer(brick!.id, { userId: ivy.uuid, topic: 'recipes' })).toMatchObject({ ok: false, status: 404 });
    expect(await prisma.bot.count({ where: { ownerId: ivy.id, deletedAt: null } })).toBe(0);
  });
});
