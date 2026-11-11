/**
 * The Brick for guests (game #1997) against a real database: what only the database can show. Its allowance and its pool
 * never pass however many replies come at once, they are apart from a guest's replies from a host's bots, a failed reply
 * is given back, a guest's chat goes to one account once and makes no second Brick, and what nobody picked up expires.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/guest-brick-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { adoptGuestChat, claimGuestBrickReply, finishGuestBrickReply, guestBrickFor, takeCarriedGuestChats } from '@/lib/guest-brick';
import { ensureDefaultBrick } from '@/lib/brick-default';
import { checkReplyAllowance } from '@/lib/reply-limits';
import { saveServerLimits } from '@/lib/bot-limits';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
const universes: string[] = [];
const guests: string[] = [];
let ownerId = '';
let providerId = '';
let hostBotId = '';
let settingBefore: { value: unknown } | null = null;

const guest = () => {
  const id = randomUUID();
  guests.push(id);
  return id;
};
const turn = () => `turn-${randomUUID()}`;

async function person(name: string): Promise<{ id: string; uuid: string }> {
  const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
  people.push(user.id);
  return { id: user.id, uuid: user.uuid };
}

async function universe(slug: string): Promise<{ id: string; roomUrl: string }> {
  const made = await prisma.universe.create({ data: { slug: `${slug}-${tag}`, name: `Universe ${slug}`, description: 'A place to meet', ownerId } });
  universes.push(made.id);
  const world = await prisma.world.create({ data: { universeId: made.id, slug: 'hq', name: 'HQ' } });
  await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby', description: 'The coffee corner is on the second row' } });
  return { id: made.id, roomUrl: `https://play.example.test/@/${made.slug}/hq/lobby` };
}

const claim = (guestId: string, roomUrl: string, turnId = turn()) => claimGuestBrickReply({ guestId, turnId, roomUrl });
const bricksOf = (id: string) => prisma.bot.count({ where: { ownerId: id } });
const talk = (guestId: string, roomUrl: string) => claim(guestId, roomUrl);

run('the Brick for guests, in a real database', () => {
  beforeAll(async () => {
    ownerId = (await person('owner')).id;
    settingBefore = await prisma.appSetting.findUnique({ where: { key: 'bot-limits' }, select: { value: true } });
    // Small numbers, so each case can fill them: 3 for a guest, 5 for a universe
    await saveServerLimits({ bricks: { guestReplies: 3, universePool: 5 } }, ownerId);
  });

  afterAll(async () => {
    if (settingBefore) await prisma.appSetting.update({ where: { key: 'bot-limits' }, data: { value: settingBefore.value as never } });
    else await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    await prisma.guestBrickReply.deleteMany({ where: { guestKey: { in: guests } } });
    await prisma.guestBrickHandover.deleteMany({ where: { guestKey: { in: guests } } });
    await prisma.replyWindow.deleteMany({ where: { OR: [{ key: { startsWith: 'gb:' }, ...{} }, { key: { in: guests.map((id) => `ua:guest:${id}`) } }] } });
    if (universes.length) await prisma.universe.deleteMany({ where: { id: { in: universes } } });
    if (providerId) await prisma.botsAiProvider.deleteMany({ where: { providerId } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('gives a guest their own allowance and then says so, with the time it carries on, and counts nothing it refused', async () => {
    const a = await universe('own');
    const sara = guest();
    for (let n = 0; n < 3; n += 1) expect(await claim(sara, a.roomUrl)).toMatchObject({ allowed: true, counted: true });
    const refused = await claim(sara, a.roomUrl);
    expect(refused).toMatchObject({ allowed: false, limit: 'guest' });
    expect(new Date((refused as { resetsAt: string }).resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.guestBrickReply.count({ where: { guestKey: sara } })).toBe(3);
  });

  it('never passes the allowance when many replies are asked for at the same moment, from two tabs or two devices', async () => {
    const a = await universe('burst');
    const omar = guest();
    const answers = await Promise.all(Array.from({ length: 12 }, () => claim(omar, a.roomUrl)));
    expect(answers.filter((answer) => answer.allowed)).toHaveLength(3);
    expect(answers.filter((answer) => !answer.allowed && answer.limit === 'guest')).toHaveLength(9);
    expect(await prisma.guestBrickReply.count({ where: { guestKey: omar, failed: false } })).toBe(3);
  });

  it('shares one pool among the guests of a universe, never passes it under load, and leaves another universe alone', async () => {
    const a = await universe('pool-a');
    const b = await universe('pool-b');
    const fresh = Array.from({ length: 8 }, () => guest());
    const answers = await Promise.all(fresh.map((id) => claim(id, a.roomUrl)));
    expect(answers.filter((answer) => answer.allowed)).toHaveLength(5);
    expect(answers.filter((answer) => !answer.allowed && answer.limit === 'universe')).toHaveLength(3);
    expect(await prisma.guestBrickReply.count({ where: { universeKey: a.id, failed: false } })).toBe(5);
    // Another universe has its own pool
    expect(await claim(guest(), b.roomUrl)).toMatchObject({ allowed: true });
  });

  it('counts a guest’s own allowance across universes, with one count', async () => {
    const a = await universe('move-a');
    const b = await universe('move-b');
    const lina = guest();
    await claim(lina, a.roomUrl);
    await claim(lina, b.roomUrl);
    await claim(lina, a.roomUrl);
    expect(await claim(lina, b.roomUrl)).toMatchObject({ allowed: false, limit: 'guest' });
  });

  it('counts a turn once however often it is asked, and gives back a reply that failed', async () => {
    const a = await universe('turns');
    const noor = guest();
    const first = turn();
    expect(await claim(noor, a.roomUrl, first)).toMatchObject({ allowed: true, counted: true });
    expect(await claim(noor, a.roomUrl, first)).toMatchObject({ allowed: true, counted: false });
    expect(await prisma.guestBrickReply.count({ where: { guestKey: noor } })).toBe(1);

    const second = turn();
    await claim(noor, a.roomUrl, second);
    await claim(noor, a.roomUrl);
    expect(await claim(noor, a.roomUrl)).toMatchObject({ allowed: false, limit: 'guest' });
    // The second reply never arrived: it is given back, and what was used is kept as totals
    expect(await finishGuestBrickReply(second, { failed: true })).toEqual({ turnId: second, failed: true });
    expect(await claim(noor, a.roomUrl)).toMatchObject({ allowed: true });
    expect(await finishGuestBrickReply(first, { tokensUsed: 120, costMicros: 480 })).toEqual({ turnId: first, failed: false });
    expect(await prisma.guestBrickReply.findUnique({ where: { turnId: first } })).toMatchObject({ tokensUsed: 120, costMicros: 480, failed: false });
  });

  it('refuses a turn id that is another guest’s', async () => {
    const a = await universe('mine');
    const taken = turn();
    await claim(guest(), a.roomUrl, taken);
    await expect(claim(guest(), a.roomUrl, taken)).rejects.toMatchObject({ status: 409 });
  });

  it('is apart from a host’s bots: a guest who used all of the Brick still gets their replies from a host bot, and the other way round', async () => {
    const a = await universe('apart');
    providerId = `p-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId, name: `Server ${tag}`, type: 'openai', enabled: true } });
    const world = await prisma.world.findFirstOrThrow({ where: { universeId: a.id } });
    const room = await prisma.room.findFirstOrThrow({ where: { worldId: world.id } });
    const hostBot = await prisma.bot.create({ data: { roomId: room.id, name: 'Nora', createdById: ownerId, aiProviderRef: UNIVERSE_AI_REF, behaviorConfig: {} } });
    hostBotId = hostBot.id;

    const maha = guest();
    const asked = { userId: maha, isGuest: true, source: 'universe-ai' };
    // The guest uses up all of the Brick for guests, and the pool of this universe goes with it for others
    for (let n = 0; n < 3; n += 1) await claim(maha, a.roomUrl);
    expect(await claim(maha, a.roomUrl)).toMatchObject({ allowed: false, limit: 'guest' });
    // A host's bot is exactly as it was: their ten replies on Universe AI, and the bot's pool, untouched
    expect(await checkReplyAllowance(hostBotId, asked)).toEqual({ allowed: true });
    expect(await prisma.botsAiUsage.count({ where: { botId: hostBotId } })).toBe(0);

    // And a guest whose host-bot replies are all used can still talk to the Brick for guests
    const huda = guest();
    // Their window with the host's bot opens at the first reply asked for
    expect(await checkReplyAllowance(hostBotId, { userId: huda, isGuest: true, source: 'universe-ai' })).toEqual({ allowed: true });
    await prisma.botsAiUsage.createMany({ data: Array.from({ length: 10 }, () => ({ botId: hostBotId, providerId, talkedUserId: huda, talkedGuest: true, keyOwnerId: null })) });
    expect(await checkReplyAllowance(hostBotId, { userId: huda, isGuest: true, source: 'universe-ai' })).toMatchObject({ allowed: false, limit: 'guest' });
    expect(await claim(huda, a.roomUrl)).toMatchObject({ allowed: true });
    // The Brick's replies never became replies of the host's bot
    expect(await prisma.botsAiUsage.count({ where: { botId: hostBotId, talkedUserId: huda } })).toBe(10);
    expect(await prisma.botsAiUsage.count({ where: { botId: hostBotId, talkedUserId: maha } })).toBe(0);
    await prisma.botsAiUsage.deleteMany({ where: { botId: hostBotId } });
    await prisma.botReplyLimitHit.deleteMany({ where: { botId: hostBotId } });
  });

  it('is the same in every universe and has no bot of its own: it makes nothing for a guest and reads only what the guest already sees', async () => {
    const a = await universe('place');
    const bots = await prisma.bot.count();
    const before = await prisma.user.count();
    providerId ||= `p-${tag}`;
    if (!(await prisma.botsAiProvider.findUnique({ where: { providerId } }))) await prisma.botsAiProvider.create({ data: { providerId, name: `Server ${tag}`, type: 'openai', enabled: true } });
    // Universe AI is the default server provider: the one that was created here is not marked Default, but it is enabled
    const served = await guestBrickFor(a.roomUrl);
    expect(served.brick.name).toBe('Brick');
    expect(served.brick.chatInstructions).toContain('Universe: Universe place (A place to meet)');
    expect(served.brick.chatInstructions).toContain('Room: Lobby (The coffee corner is on the second row)');
    expect(served.credentials.source).toBe('universe-ai');
    expect(served.credentials.providerId).toBeTruthy();
    // A room outside any universe still has it, and nothing about it
    const outside = await guestBrickFor('https://play.example.test/somewhere/else');
    expect(outside.place.universeKey).toBe('outside');
    expect(outside.brick.chatInstructions).not.toContain('This place:');
    expect(await prisma.bot.count()).toBe(bots);
    expect(await prisma.user.count()).toBe(before);
  });

  describe('when the guest signs in', () => {
    it('hands the chat to the account once, makes the one Brick the account would have had, and makes no second', async () => {
      const a = await universe('signin');
      const sara = await person('sara-in');
      const guestId = guest();
      await claim(guestId, a.roomUrl);

      expect(await adoptGuestChat(guestId, sara.id)).toEqual({ adopted: true });
      expect(await bricksOf(sara.id)).toBe(1);
      // The account's own call finds that same Brick
      const own = await ensureDefaultBrick(sara.id);
      expect(own).toMatchObject({ made: false, deleted: false });
      expect(await bricksOf(sara.id)).toBe(1);
      // The same sign-in sent twice, or from a second tab, hands over nothing more
      expect(await adoptGuestChat(guestId, sara.id)).toEqual({ adopted: false });
      expect(await prisma.guestBrickHandover.count({ where: { guestKey: guestId } })).toBe(1);
    });

    it('goes to one account only, even when two accounts sign in at the same moment with the same guest id', async () => {
      const a = await universe('two');
      const first = await person('first');
      const second = await person('second');
      const guestId = guest();
      await claim(guestId, a.roomUrl);
      const answers = await Promise.all([adoptGuestChat(guestId, first.id), adoptGuestChat(guestId, second.id)]);
      expect(answers.filter((answer) => answer.adopted)).toHaveLength(1);
      const row = await prisma.guestBrickHandover.findUniqueOrThrow({ where: { guestKey: guestId } });
      expect([first.id, second.id]).toContain(row.userId);
      // A third account, later, takes nothing
      const third = await person('third');
      expect(await adoptGuestChat(guestId, third.id)).toEqual({ adopted: false });
      expect(await bricksOf(third.id)).toBe(0);
    });

    it('hands the guest ids to the first device that asks and to no other', async () => {
      const a = await universe('carry');
      const noor = await person('noor-in');
      const guestId = guest();
      await claim(guestId, a.roomUrl);
      await adoptGuestChat(guestId, noor.id);
      const asks = await Promise.all(Array.from({ length: 6 }, () => takeCarriedGuestChats(noor.id)));
      expect(asks.filter((ids) => ids.length > 0)).toEqual([[guestId]]);
      expect(await takeCarriedGuestChats(noor.id)).toEqual([]);
    });

    it('does nothing when the guest never talked to the Brick, or only had a reply that failed', async () => {
      const a = await universe('quiet');
      const lina = await person('lina-in');
      expect(await adoptGuestChat(guest(), lina.id)).toEqual({ adopted: false });
      const failedOnly = guest();
      const failed = turn();
      await claim(failedOnly, a.roomUrl, failed);
      await finishGuestBrickReply(failed, { failed: true });
      expect(await adoptGuestChat(failedOnly, lina.id)).toEqual({ adopted: false });
      expect(await bricksOf(lina.id)).toBe(0);
      expect(await prisma.guestBrickHandover.count({ where: { userId: lina.id } })).toBe(0);
    });

    it('makes no Brick and hands over nothing to a person who deleted theirs on purpose', async () => {
      const a = await universe('deleted');
      const maha = await person('maha-in');
      const { brick } = await ensureDefaultBrick(maha.id);
      await prisma.bot.delete({ where: { id: brick!.id } });
      const guestId = guest();
      await claim(guestId, a.roomUrl);
      expect(await adoptGuestChat(guestId, maha.id)).toEqual({ adopted: false });
      expect(await bricksOf(maha.id)).toBe(0);
      expect(await prisma.guestBrickHandover.count({ where: { guestKey: guestId } })).toBe(0);
    });

    it('lets a chat expire: one older than a guest’s files stay is not handed over, and one nobody picked up is not given out', async () => {
      const a = await universe('expire');
      const sara = await person('sara-old');
      const old = guest();
      const stale = turn();
      await claim(old, a.roomUrl, stale);
      await prisma.guestBrickReply.update({ where: { turnId: stale }, data: { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
      expect(await adoptGuestChat(old, sara.id)).toEqual({ adopted: false });

      const waiting = guest();
      await claim(waiting, a.roomUrl);
      expect(await adoptGuestChat(waiting, sara.id)).toEqual({ adopted: true });
      await prisma.guestBrickHandover.update({ where: { guestKey: waiting }, data: { claimedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
      expect(await takeCarriedGuestChats(sara.id)).toEqual([]);
    });

    it('never hands over an id that is a signed-in account’s own', async () => {
      const a = await universe('account');
      const real = await person('real');
      const other = await person('other-in');
      await prisma.guestBrickReply.create({ data: { turnId: turn(), guestKey: real.uuid, universeKey: a.id } });
      expect(await adoptGuestChat(real.uuid, other.id)).toEqual({ adopted: false });
      await prisma.guestBrickReply.deleteMany({ where: { guestKey: real.uuid } });
    });

    it('goes with the account: leaving removes what was handed to it', async () => {
      const a = await universe('leaving');
      const leaving = await person('leaving');
      const guestId = guest();
      await claim(guestId, a.roomUrl);
      await adoptGuestChat(guestId, leaving.id);
      await prisma.user.delete({ where: { id: leaving.id } });
      expect(await prisma.guestBrickHandover.count({ where: { guestKey: guestId } })).toBe(0);
    });
  });

  it('keeps no words: a counted reply is a guest id, a universe, a time and what it took, and nothing else', async () => {
    const a = await universe('totals');
    const id = guest();
    const t = turn();
    await talk(id, a.roomUrl);
    await claim(id, a.roomUrl, t);
    const row = await prisma.guestBrickReply.findUniqueOrThrow({ where: { turnId: t } });
    expect(Object.keys(row).sort()).toEqual(['costMicros', 'createdAt', 'failed', 'guestKey', 'id', 'tokensUsed', 'turnId', 'universeKey']);
  });
});
