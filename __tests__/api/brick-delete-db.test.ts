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

/** Lets one test stand between a Brick being found and the list being read. */
const mockListHook: { current: ((read: () => Promise<unknown>) => Promise<unknown>) | null } = { current: null };
jest.mock('@/lib/brick-default', () => {
  const actual = jest.requireActual('@/lib/brick-default');
  return { ...actual, listBricks: (...args: unknown[]) => (mockListHook.current ? mockListHook.current(() => actual.listBricks(...args)) : actual.listBricks(...args)) };
});

import { prisma } from '@/lib/db';
import { ensureDefaultBrick, listBricks, listDeletedBricks } from '@/lib/brick-default';
import { deleteBrick, recentlyRemovedBricks, removeGoneBricks, undoBrickDelete } from '@/lib/brick-delete';
import { BRICK_LOOKS, makeBrick, makeBrickFromChat, bricksForChat } from '@/lib/brick-make';
import { answerOffer, claimOffer, offersSoFar, releaseOffer, RELEASE_WITHIN_MS } from '@/lib/brick-offers';
import { endAllApprovals, ENDED_BY_DELETE } from '@/lib/bot-actions';
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

  it('makes one Brick when the same ask arrives several times at the same moment', async () => {
    const hadi = await person('hadi');
    const { brick } = await ensureDefaultBrick(hadi.id);
    const answers = await Promise.all(['Music Brick', 'music brick', 'MUSIC BRICK', 'Music Brick'].map((name) => makeBrickFromChat(brick!.id, { userId: hadi.uuid, name })));
    expect(answers.filter((answer) => answer.ok && answer.made)).toHaveLength(1);
    expect(new Set(answers.map((answer) => (answer.ok ? answer.brick.id : null))).size).toBe(1);
    expect((await bricksForChat(brick!.id, hadi.uuid))!.map((card) => card.name.toLowerCase())).toEqual(['brick', 'music brick']);
  });

  it('makes one Brick when two asks both found the one of that name, and it was deleted before they listed', async () => {
    const uma = await person('uma');
    const { brick } = await ensureDefaultBrick(uma.id);
    const there = await makeBrickFromChat(brick!.id, { userId: uma.uuid, name: 'Bolt' });
    if (!there.ok) throw new Error('expected an answer');
    let asked = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    mockListHook.current = async (read) => {
      asked += 1;
      // Both asks have found it and are about to list: it is deleted now
      if (asked === 2) {
        await deleteBrick(there.brick.id, uma.id, NOW);
        open();
      }
      await gate;
      return read();
    };
    let answers: Awaited<ReturnType<typeof makeBrickFromChat>>[];
    try {
      answers = await Promise.all([makeBrickFromChat(brick!.id, { userId: uma.uuid, name: 'Bolt' }), makeBrickFromChat(brick!.id, { userId: uma.uuid, name: 'Bolt' })]);
    } finally {
      mockListHook.current = null;
    }
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect((await bricksForChat(brick!.id, uma.uuid))!.map((card) => card.name)).toEqual(['Brick', 'Bolt']);
  });

  it('when the Brick found is missing from the list three times, it makes none outside the name lock: the ask ends with a 409 to ask again, and no second Brick of the name exists', async () => {
    const ines = await person('ines');
    const { brick } = await ensureDefaultBrick(ines.id);
    const there = await makeBrickFromChat(brick!.id, { userId: ines.uuid, name: 'Bolt' });
    if (!there.ok) throw new Error('expected an answer');
    // Every list read leaves out the Brick that was found (as if it were deleted again each time)
    mockListHook.current = async (read) => ((await read()) as Array<{ id: string }>).filter((card) => card.id !== there.brick.id);
    let answer: Awaited<ReturnType<typeof makeBrickFromChat>>;
    try {
      answer = await makeBrickFromChat(brick!.id, { userId: ines.uuid, name: 'Bolt' });
    } finally {
      mockListHook.current = null;
    }
    expect(answer).toMatchObject({ ok: false, status: 409 });
    expect((await bricksForChat(brick!.id, ines.uuid))!.map((card) => card.name)).toEqual(['Brick', 'Bolt']);
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

  it('closes a card that was tapped yes while the cards were being closed, so nothing approved can still start', async () => {
    const tess = await person('tess');
    const brick = await makeBrick(tess.id, { name: 'Tapped Brick' });
    const waiting = await request(brick.id, 'waiting');
    const read = prisma.botActionRequest.findMany.bind(prisma.botActionRequest);
    const spy = jest.spyOn(prisma.botActionRequest, 'findMany').mockImplementationOnce(((...args: Parameters<typeof read>) =>
      read(...args).then(async (rows) => {
        // The person says yes right after the card was read as waiting: it is approved now, at a newer revision
        await prisma.botActionRequest.update({ where: { id: waiting.id }, data: { status: 'approved', approvedAt: NOW, startBy: later(1), revision: { increment: 1 } } });
        return rows;
      })) as never);
    try {
      expect(await endAllApprovals(prisma, brick.id, NOW)).toMatchObject({ requests: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.botActionRequest.findUnique({ where: { id: waiting.id } })).toMatchObject({ status: 'closed', closedReason: 'revoked' });
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

  it('tells the bot server of a Brick removed by its owner opening their page, and keeps telling it for a few days, so no id is lost to a request nobody read', async () => {
    const lena = await person('lena');
    const brick = await makeBrick(lena.id, { name: 'Page Brick' });
    await deleteBrick(brick.id, lena.id, NOW);
    // The owner's own page clears it, and the answer to that request goes to the page, not to the bot server
    expect(await removeGoneBricks(later(8), lena.id)).toEqual([brick.id]);
    expect(await recentlyRemovedBricks(later(8))).toContain(brick.id);
    // The sweep that comes later finds nothing more to remove, and still names it
    expect(await removeGoneBricks(later(9))).not.toContain(brick.id);
    expect(await recentlyRemovedBricks(later(9))).toContain(brick.id);
    // A few days on it is let go of
    expect(await recentlyRemovedBricks(later(20))).not.toContain(brick.id);
    expect(await prisma.brickRemoval.count({ where: { botId: brick.id } })).toBe(0);
  });

  it('a second call that picked the same Brick, and found it already removed by the first, leaves the removal the first wrote down, while one that finds the Brick undone takes its own record back', async () => {
    const twice = await person('twice');
    const brick = await makeBrick(twice.id, { name: 'Twice Brick' });
    await deleteBrick(brick.id, twice.id, NOW);
    // The second call picked the Brick before the first removed it: its list still names it
    const stale = jest.spyOn(prisma.bot, 'findMany').mockResolvedValueOnce([{ id: brick.id }] as never);
    try {
      // The first call (the owner's page) removes it for good and writes it down
      expect(await removeGoneBricks(later(8), twice.id)).toEqual([brick.id]);
    } finally {
      stale.mockRestore();
    }
    expect(await row(brick.id)).toBeNull();
    const again = jest.spyOn(prisma.bot, 'findMany').mockResolvedValueOnce([{ id: brick.id }] as never);
    try {
      // The second call finds nothing to remove (count 0, the Brick is gone): the record stays
      expect(await removeGoneBricks(later(8))).toEqual([]);
    } finally {
      again.mockRestore();
    }
    expect(await recentlyRemovedBricks(later(8))).toContain(brick.id);

    // A Brick that was undone before the second call reached it is still there: no record is left for it
    const undone = await makeBrick(twice.id, { name: 'Undone Brick' });
    await deleteBrick(undone.id, twice.id, NOW);
    expect(await undoBrickDelete(undone.id, twice.id, later(1))).not.toBeNull();
    const picked = jest.spyOn(prisma.bot, 'findMany').mockResolvedValueOnce([{ id: undone.id }] as never);
    try {
      expect(await removeGoneBricks(later(8))).toEqual([]);
    } finally {
      picked.mockRestore();
    }
    expect(await row(undone.id)).not.toBeNull();
    expect(await recentlyRemovedBricks(later(8))).not.toContain(undone.id);
    expect(await prisma.brickRemoval.count({ where: { botId: undone.id } })).toBe(0);
  });

  it('writes the removal with the delete itself: two removers at once leave one record and one removal, and a delete that fails leaves no record', async () => {
    const wren = await person('wren');
    const both = await makeBrick(wren.id, { name: 'Both Brick' });
    await deleteBrick(both.id, wren.id, NOW);
    // The owner's page and the sweep pick the same Brick at the same moment
    const results = await Promise.all([removeGoneBricks(later(8), wren.id), removeGoneBricks(later(8))]);
    expect(results.flat().filter((id) => id === both.id)).toHaveLength(1);
    expect(await row(both.id)).toBeNull();
    expect(await prisma.brickRemoval.count({ where: { botId: both.id } })).toBe(1);
    expect(await recentlyRemovedBricks(later(8))).toContain(both.id);

    // A delete that fails (the database away at that moment) leaves no record for a Brick that is still there
    const failing = await makeBrick(wren.id, { name: 'Failing Brick' });
    await deleteBrick(failing.id, wren.id, NOW);
    // The removal is written inside the purge's own transaction: when that write fails the delete is undone with it (the sweep looks at the Brick again later)
    const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((work: unknown, options?: unknown) =>
      typeof work === 'function'
        ? real((tx: object) => (work as (tx: object) => unknown)(new Proxy(tx, { get: (target, key) => (key === 'brickRemoval' ? { upsert: () => { throw new Error('database away'); } } : (target as Record<string | symbol, unknown>)[key]) })), options)
        : real(work, options)) as never);
    try {
      expect(await removeGoneBricks(later(8), wren.id)).not.toContain(failing.id);
    } finally {
      spy.mockRestore();
    }
    expect(await row(failing.id)).not.toBeNull();
    expect(await prisma.brickRemoval.count({ where: { botId: failing.id } })).toBe(0);
    expect(await recentlyRemovedBricks(later(8))).not.toContain(failing.id);
  });

  it('names every removal that is kept, however many there are', async () => {
    const wide = await person('wide');
    const ids = Array.from({ length: 5_003 }, () => `wide-${randomUUID()}`);
    await prisma.brickRemoval.createMany({ data: ids.map((botId, index) => ({ botId, removedAt: new Date(later(1).getTime() + index) })) });
    try {
      const named = new Set(await recentlyRemovedBricks(later(2)));
      expect(ids.every((id) => named.has(id))).toBe(true);
    } finally {
      await prisma.brickRemoval.deleteMany({ where: { botId: { in: ids } } });
    }
    expect(wide.id).toBeTruthy();
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

  it('takes back a fresh unanswered claim whose card never reached the person, and nothing else', async () => {
    const hal = await person('hal');
    const mia = await person('mia');
    const { brick } = await ensureDefaultBrick(hal.id);
    const theirs = await ensureDefaultBrick(mia.id);
    expect(await claimOffer(brick!.id, { userId: hal.uuid, topic: 'recipes' })).toMatchObject({ show: true });
    // someone else's Brick cannot take it back, and a topic has to name something
    expect(await releaseOffer(theirs.brick!.id, { userId: hal.uuid, topic: 'recipes' })).toMatchObject({ ok: false, status: 404 });
    expect(await releaseOffer(brick!.id, { userId: hal.uuid, topic: ' ?! ' })).toMatchObject({ ok: false, status: 400 });
    expect(await offersSoFar(brick!.id, hal.uuid)).toMatchObject({ topics: [{ topic: 'recipes', answer: null }] });
    // the claim is taken back, so the topic may be suggested again, once
    expect(await releaseOffer(brick!.id, { userId: hal.uuid, topic: 'Recipes!' })).toEqual({ ok: true, released: true });
    expect(await releaseOffer(brick!.id, { userId: hal.uuid, topic: 'recipes' })).toEqual({ ok: true, released: false });
    expect(await claimOffer(brick!.id, { userId: hal.uuid, topic: 'recipes' })).toMatchObject({ show: true });
    // an answered one stays closed
    await answerOffer(brick!.id, { userId: hal.uuid, topic: 'recipes', answer: 'not_now' });
    expect(await releaseOffer(brick!.id, { userId: hal.uuid, topic: 'recipes' })).toEqual({ ok: true, released: false });
    // and so does one claimed long ago
    await claimOffer(brick!.id, { userId: hal.uuid, topic: 'workouts' });
    const later = new Date(Date.now() + RELEASE_WITHIN_MS + 60_000);
    expect(await releaseOffer(brick!.id, { userId: hal.uuid, topic: 'workouts' }, later)).toEqual({ ok: true, released: false });
    expect(await offersSoFar(brick!.id, hal.uuid)).toMatchObject({ topics: expect.arrayContaining([{ topic: 'workouts', answer: null }]) });
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
