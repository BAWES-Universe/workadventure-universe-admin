/**
 * A look Universe AI's vision takes at an image (game: the describe call for a model that can't see, on Universe AI or on a person's own key),
 * against a real database: it is that person's Universe AI use and Universe's cost in the books, and it is never a reply anywhere a reply is
 * counted. A person on their own key is never limited by it. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest -i __tests__/api/ai-usage-image-read-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';
import { checkReplyAllowance } from '@/lib/reply-limits';
import { compareReplyWindow } from '@/lib/meter-shadow';
import { memberUsage } from '@/lib/meter-usage';
import { voiceRepliesLeft } from '@/lib/voice-allowance';
import { goalsRoom } from '@/lib/brick-items';
import { costsReport } from '@/lib/meter-costs';
import { botUsageReport } from '@/lib/bot-usage-report';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
const serverProvider = `vision-${tag}`;
const ownKey = `key-own-${tag}`;
let made = 0;

async function person(name: string): Promise<{ id: string; uuid: string; brickId: string }> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, uuid: user.uuid, brickId: brick.id };
}

/** What the bot server sends: a reply, or a look at an image (marked a greeting too, for an Orbit from before image looks). */
const report = (who: { uuid: string; brickId: string }, extra: object = {}) =>
  trackUsage(
    new NextRequest('http://localhost:3333/api/bots/ai-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: who.brickId, providerId: serverProvider, userId: who.uuid, isGuest: false, tokensUsed: 300, channel: 'dm', ...extra }),
    }),
  );
const imageLook = { imageRead: true, greeting: true, costMicros: 400, costBasis: 'priced', inputTokens: 250, outputTokens: 50 };
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));

/** Many rows at once, as reports would leave them (the route is tested above; this only fills a window fast). */
const rows = (who: { id: string; uuid: string; brickId: string }, count: number, extra: object = {}) =>
  prisma.botsAiUsage.createMany({
    data: Array.from({ length: count }, () => ({ botId: who.brickId, providerId: serverProvider, talkedUserId: who.uuid, talkedPersonId: who.id, talkedGuest: false, timestamp: new Date(Date.now() - 30 * 60_000), ...extra })),
  });

run('a look Universe AI takes at an image, in a real database', () => {
  beforeAll(async () => {
    await prisma.botsAiProvider.create({ data: { providerId: serverProvider, name: `Vision ${tag}`, type: 'openai', enabled: true, model: 'vision-model' } });
  });
  afterAll(async () => {
    const bots = await prisma.bot.findMany({ where: { ownerId: { in: people } }, select: { id: true } });
    await prisma.meterEvent.deleteMany({ where: { botId: { in: bots.map((bot) => bot.id) } } });
    await prisma.botsAiUsage.deleteMany({ where: { providerId: { in: [serverProvider, ownKey] } } });
    await prisma.botsAiProvider.deleteMany({ where: { providerId: { in: [serverProvider, ownKey] } } });
    await prisma.replyWindow.deleteMany({ where: { key: { in: people.map((id) => `ua:person:${id}`) } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('is written as the person’s Universe AI use, on Universe’s provider, and copied into the books with its cost, never as a greeting', async () => {
    const sara = await person('sara');
    expect((await report(sara, imageLook)).status).toBe(200);
    await settle();
    const [row] = await prisma.botsAiUsage.findMany({ where: { botId: sara.brickId } });
    expect(row).toMatchObject({ imageRead: true, greeting: false, error: false, keyOwnerId: null, talkedPersonId: sara.id, costMicros: 400 });
    const [event] = await prisma.meterEvent.findMany({ where: { sourceRef: `bots_ai_usage:${row.id}` } });
    expect(event).toMatchObject({ kind: 'model_call', personKey: `person:${sara.id}`, payerKind: 'universe', costMicros: BigInt(400) });
    expect(event.detail).toMatchObject({ imageRead: true, greeting: false });
  });

  it('is counted once: one report, one row and one event, apart from the reply it was for', async () => {
    const omar = await person('omar');
    await report(omar, { eventId: 'turn-1' });
    await report(omar, { ...imageLook, eventId: 'turn-1.image' });
    await settle();
    expect(await prisma.botsAiUsage.count({ where: { botId: omar.brickId } })).toBe(2);
    expect(await prisma.botsAiUsage.count({ where: { botId: omar.brickId, imageRead: true } })).toBe(1);
    expect(await prisma.meterEvent.count({ where: { botId: omar.brickId } })).toBe(2);
  });

  it('is left out of every count of the person’s replies: their window, the books’ comparison, the Usage bar and their spoken replies', async () => {
    const lina = await person('lina');
    await prisma.replyWindow.create({ data: { key: `ua:person:${lina.id}`, startedAt: new Date(Date.now() - 60 * 60_000) } });
    await report(lina);
    await report(lina);
    await report(lina, imageLook);
    await report(lina, imageLook);
    await report(lina, imageLook);
    await settle();
    const compared = await compareReplyWindow(lina.id);
    expect([compared.today, compared.books, compared.replies.state]).toEqual([2, 2, 'same']);

    // A full window of image looks alone leaves every reply there: 30 is the usual window
    const kai = await person('kai');
    await prisma.replyWindow.create({ data: { key: `ua:person:${kai.id}`, startedAt: new Date(Date.now() - 60 * 60_000) } });
    await rows(kai, 60, { imageRead: true });
    const ask = () => checkReplyAllowance(kai.brickId, { userId: kai.uuid, isGuest: false, source: 'universe-ai' }, new Date());
    expect((await ask()).allowed).toBe(true);
    expect((await memberUsage(kai.id)).chat).toMatchObject({ left: 1 });
    // Spoken replies left are those of a person with the same window and nothing used in it
    const zed = await person('zed');
    await prisma.replyWindow.create({ data: { key: `ua:person:${zed.id}`, startedAt: new Date(Date.now() - 60 * 60_000) } });
    const voice = await voiceRepliesLeft(kai.brickId, { userId: kai.uuid, isGuest: false });
    expect(voice?.left).toEqual((await voiceRepliesLeft(zed.brickId, { userId: zed.uuid, isGuest: false }))?.left);
    // Replies still count as ever: 30 of them and the window is used up
    await rows(kai, 30);
    expect((await ask()).allowed).toBe(false);
  });

  it('never takes the room goals and tasks have in the window', async () => {
    const dana = await person('dana');
    await prisma.replyWindow.create({ data: { key: `ua:person:${dana.id}`, startedAt: new Date(Date.now() - 60 * 60_000) } });
    await rows(dana, 60, { imageRead: true, channel: 'task' });
    expect(await goalsRoom(dana.id)).toEqual({ ok: true });
    await rows(dana, 30, { channel: 'task' });
    expect((await goalsRoom(dana.id)).ok).toBe(false);
  });

  it('never limits a person on their own key: their key’s replies are not counted anywhere, and a look at an image on Universe AI is no reply either', async () => {
    const noor = await person('noor');
    await prisma.botsAiProvider.create({ data: { providerId: ownKey, name: `Noor's key ${tag}`, type: 'openai', enabled: true, model: 'text-model', ownerId: noor.id } });
    await prisma.bot.update({ where: { id: noor.brickId }, data: { aiProviderRef: ownKey, dailyReplyCap: 5 } });
    await prisma.replyWindow.create({ data: { key: `ua:person:${noor.id}`, startedAt: new Date(Date.now() - 60 * 60_000) } });
    // 4 replies on the key, then 40 looks Universe AI took at images for it
    await rows(noor, 4, { providerId: ownKey, keyOwnerId: noor.id });
    for (let i = 0; i < 3; i++) await report(noor, imageLook);
    await settle();
    await rows(noor, 37, { imageRead: true });
    expect(await prisma.botsAiUsage.count({ where: { botId: noor.brickId, imageRead: true, keyOwnerId: null } })).toBe(40);
    const own = await checkReplyAllowance(noor.brickId, { userId: noor.uuid, isGuest: false, source: 'own-key' }, new Date());
    expect(own.allowed).toBe(true);
    // The same person on Universe AI elsewhere still has their whole window
    const elsewhere = await person('elsewhere');
    expect((await checkReplyAllowance(elsewhere.brickId, { userId: noor.uuid, isGuest: false, source: 'universe-ai' }, new Date())).allowed).toBe(true);
    expect((await compareReplyWindow(noor.id)).today).toBe(0);
  });

  it('is Universe’s cost on the Costs page and no reply there, and the bot’s page of replies leaves it out', async () => {
    const mira = await person('mira');
    await report(mira, { costMicros: 1000, costBasis: 'priced', inputTokens: 900, outputTokens: 100 });
    await report(mira, imageLook);
    await settle();
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const costs = await costsReport(new Date(day.getTime() - 86_400_000), day, now);
    const line = costs.bricks.rows.find((entry) => entry.id === mira.brickId);
    expect(line).toMatchObject({ replies: 1, costMicros: 1400 });
    const page = await botUsageReport({ id: mira.brickId, createdById: mira.id }, { range: '7d', timeZone: 'UTC' });
    expect(page.totals.replies).toBe(1);
  });
});
