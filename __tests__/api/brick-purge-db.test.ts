/**
 * The final purge of a deleted Brick against a real database (audit F08; GPT A31 and A32; Khalid, 17 Nov: delete EVERYTHING, keep nothing).
 * Delete, then Undo inside the window, then the purge once the days are over: everything the Brick owned goes in one transaction without
 * any backup first, what is left outside Orbit is written down and tried again, what a person owns stays, and a bot server that still holds
 * the Brick cannot write its memory or chats back. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-purge-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn(async () => undefined) }));

import * as Sentry from '@sentry/nextjs';

// The books' own writer, wrapped so a test can make a write fail and every other one run as it always does
const actualRecord = jest.requireActual('@/lib/meter').recordMeterEvent;
jest.mock('@/lib/meter', () => {
  const actual = jest.requireActual('@/lib/meter');
  return { ...actual, recordMeterEvent: jest.fn(actual.recordMeterEvent) };
});
import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick, removeGoneBricks, undoBrickDelete } from '@/lib/brick-delete';
import { isPurged, purgeBrick, DELETED_MAKER_NAME, PURGE_MARKER_DAYS } from '@/lib/brick-purge';
import { giveComputer, startJob, finishJob } from '@/lib/computer';
import * as meter from '@/lib/meter';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { POST as saveMemory } from '@/app/api/bots/memory/[id]/route';
import { POST as saveConversation } from '@/app/api/bots/[id]/conversations/route';
import { POST as saveMetrics } from '@/app/api/bots/metrics/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const SERVICE_TOKEN = 'purge-service-secret';
const tag = randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-12T09:00:00Z');
const later = (days: number) => new Date(NOW.getTime() + days * DAY);
const people: string[] = [];
let provider: FakeComputerProvider;
let made = 0;
const env = { provider: process.env.COMPUTER_PROVIDER, token: process.env.BOT_SERVICE_TOKEN };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function person(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  return { id: user.id, uuid: unique };
}

function asBotServer(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** A Brick with a bit of everything it can own, so a purge that forgets a table shows. */
async function fullBrick(owner: { id: string; uuid: string }, name: string, over: { computer?: boolean } = {}) {
  const brick = await createBrick({ ownerId: owner.id, name });
  const botId = brick.id;
  await prisma.botsMemory.create({ data: { botId, userUuid: owner.uuid, userId: owner.id, isGuest: false, memories: { personalInfo: { name: 'Sara', preferences: ['jazz'], facts: [], lastInfoUpdate: 1 } } } });
  await prisma.botsConversation.create({ data: { botId, userUuid: owner.uuid, userId: owner.id, messages: [{ role: 'user', content: 'a private line' }], startedAt: NOW, endedAt: NOW, messageCount: 1 } });
  await prisma.botMemoryForget.create({ data: { botId, userUuid: owner.uuid } });
  await prisma.botMemoryItemForget.create({ data: { botId, userUuid: owner.uuid, itemKey: 'pref:jazz', kind: 'preference' } });
  await prisma.botsMetric.create({ data: { botId, metricType: 'response_time', metricValue: new Prisma.Decimal(1.5), metadata: { note: 'private' } } });
  await prisma.botsTestResult.create({ data: { testId: `t-${randomUUID()}`, botId, results: { says: 'private' }, passed: true } });
  await prisma.spendRule.create({ data: { ruleKey: `r-${randomUUID()}`, ownerPersonId: owner.id, scope: 'bot', botId, period: 'day', capMicros: BigInt(5_000_000), words: 'Never more than $5 a day for this Brick', createdById: owner.id } });
  await prisma.appKeyRequest.create({ data: { ownerId: owner.id, botId, definition: { setup: 'private' }, definitionHash: 'h'.repeat(64), expiresAt: later(30) } });
  await prisma.brickItem.create({ data: { ownerId: owner.id, botId, kind: 'goal', words: 'Send me the recipes', cadence: {}, timeZone: 'UTC' } });
  await prisma.botFile.create({ data: { botId, number: 1, ownerId: owner.id, source: 'person', kind: 'document', name: 'passport.pdf', bucket: 'chat', fileId: `up-${tag}-${botId}`, chatKind: 'dm', chatRef: 'r1' } });
  await prisma.botFile.create({ data: { botId, number: 2, ownerId: owner.id, source: 'bot', kind: 'image', name: 'logo.png', bucket: 'chat', fileId: `made-${tag}-${botId}`, chatKind: 'dm', chatRef: 'r1' } });
  await prisma.taskReceipt.create({ data: { botId, personId: owner.id, taskKey: `job-${randomUUID()}`, title: 'Renew my passport', category: 'computer', state: 'done', chargedMicros: BigInt(1_250_000), payerKind: 'sponsor', payerName: 'Acme Universe' } });
  await prisma.voiceNoteTurn.create({
    data: { scope: 'bot', personKey: `person:${owner.id}`, target: botId, botId, clientTurnId: `c-${randomUUID()}`, fingerprint: 'f'.repeat(64), payer: 'owner', seconds: 12, heardSeconds: 12, state: 'delivered', costMicros: 4000, buffer: 'encrypted words heard', bufferUntil: later(1), providerRefs: { file: 'prov-file-1' } },
  });
  await prisma.meterEvent.create({
    data: { eventId: `ev-${randomUUID()}`, kind: 'model_call', pool: 'chat', occurredAt: NOW, personKey: `person:${owner.id}`, personId: owner.id, botId, brick: true, payerKind: 'universe', quantity: BigInt(900), unit: 'token', costMicros: BigInt(7000), basis: 'measured' },
  });
  const artifact = await prisma.artifact.create({ data: { ownerId: owner.id, makerBotId: botId, makerName: name, title: 'Menu', kind: 'markdown' } });
  if (over.computer) {
    await giveComputer(botId, owner.id);
    const job = await startJob({ botId, personId: owner.id, title: 'Renew passport' }, NOW);
    if (!job.ok) throw new Error('no job');
    await finishJob(job.job.id, 'done', new Date(NOW.getTime() + 60_000));
  }
  return { id: botId, artifactId: artifact.id };
}

/** Every table that holds something of this Brick, as a count: the whole of what a purge must clear (the books and its owner's artifacts apart). */
async function owned(botId: string) {
  const botIdIs = { where: { botId } };
  return {
    bot: await prisma.bot.count({ where: { id: botId } }),
    conversations: await prisma.botsConversation.count(botIdIs),
    memory: await prisma.botsMemory.count(botIdIs),
    forgets: (await prisma.botMemoryForget.count(botIdIs)) + (await prisma.botMemoryItemForget.count(botIdIs)),
    metrics: await prisma.botsMetric.count(botIdIs),
    tests: await prisma.botsTestResult.count(botIdIs),
    spendRules: await prisma.spendRule.count(botIdIs),
    setups: await prisma.appKeyRequest.count(botIdIs),
    goals: await prisma.brickItem.count(botIdIs),
    files: await prisma.botFile.count(botIdIs),
    computer: await prisma.brickComputer.count(botIdIs),
    jobs: await prisma.computerJob.count(botIdIs),
  };
}
const NOTHING = { bot: 0, conversations: 0, memory: 0, forgets: 0, metrics: 0, tests: 0, spendRules: 0, setups: 0, goals: 0, files: 0, computer: 0, jobs: 0 };

run('purging a deleted Brick, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
  });
  beforeEach(async () => {
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits'] } } });
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
    (Sentry.captureMessage as jest.Mock).mockClear();
  });
  afterAll(async () => {
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env.provider;
    process.env.BOT_SERVICE_TOKEN = env.token;
    await prisma.artifact.deleteMany({ where: { ownerId: { in: people } } });
    await prisma.meterEvent.deleteMany({ where: { personId: { in: people } } });
    await prisma.meterReservation.deleteMany({ where: { personId: { in: people } } });
    await prisma.botFileRemoval.deleteMany({ where: { fileId: { contains: tag } } });
    await prisma.taskReceipt.deleteMany({ where: { personId: { in: people } } });
    await prisma.voiceNoteTurn.deleteMany({ where: { personKey: { in: people.map((id) => `person:${id}`) } } });
    await prisma.spendRule.deleteMany({ where: { ownerPersonId: { in: people } } });
    await prisma.brickPurge.deleteMany({ where: { ownerId: { in: people } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('delete, then Undo (A32)', () => {
    it('gives the Brick back whole inside its days, with nothing purged, nothing outside touched and no note written', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Undo Brick', { computer: true });
      await deleteBrick(brick.id, sara.id, NOW);
      // While it waits everything is still there, off
      expect(await owned(brick.id)).toMatchObject({ bot: 1, memory: 1, conversations: 1, goals: 1, files: 2, computer: 1 });
      const calls = provider.calls.length;
      expect(await removeGoneBricks(later(3), sara.id)).toEqual([]);
      expect(await undoBrickDelete(brick.id, sara.id, later(4))).toMatchObject({ id: brick.id });
      expect(await owned(brick.id)).toMatchObject({ bot: 1, memory: 1, conversations: 1, forgets: 2, metrics: 1, tests: 1, spendRules: 1, setups: 1, goals: 1, files: 2, computer: 1 });
      expect(await prisma.brickPurge.count({ where: { botId: brick.id } })).toBe(0);
      expect(provider.calls.filter((call) => ['remove', 'removeAllFor', 'deleteSavedCopy'].includes(call.name))).toEqual([]);
      expect(provider.calls.length).toBeGreaterThanOrEqual(calls);
      // Once back, the sweep never takes it
      expect(await removeGoneBricks(later(30), sara.id)).toEqual([]);
      expect(await prisma.bot.count({ where: { id: brick.id } })).toBe(1);
    });

    it('purges nothing before the days are over, and a Brick Undo gave back at the last moment is left whole', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Not yet Brick');
      await deleteBrick(brick.id, sara.id, NOW);
      expect(await purgeBrick(brick.id, later(6))).toBe('not_due');
      expect(await owned(brick.id)).toMatchObject({ bot: 1, memory: 1, conversations: 1 });
      await undoBrickDelete(brick.id, sara.id, later(6));
      expect(await purgeBrick(brick.id, later(8))).toBe('not_due');
      expect(await owned(brick.id)).toMatchObject({ bot: 1, memory: 1, conversations: 1, goals: 1 });
      expect(await prisma.artifact.findUniqueOrThrow({ where: { id: brick.artifactId } })).toMatchObject({ makerName: 'Not yet Brick' });
    });
  });

  describe('the final purge (A32)', () => {
    it('deletes everything the Brick owned in one go, with no backup made first, and keeps only what a person owns and the money', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Gone Brick', { computer: true });
      const other = await fullBrick(sara, 'Bystander Brick');
      await deleteBrick(brick.id, sara.id, NOW);
      const saves = provider.calls.filter((call) => call.name === 'saveFiles').length;

      expect(await removeGoneBricks(later(8), sara.id)).toEqual([brick.id]);

      // Everything bot-owned is gone: its goals, files, chats, memory, what it was asked to forget, settings, its computer's record and jobs
      expect(await owned(brick.id)).toEqual(NOTHING);
      // The machine and the saved files were deleted without making a copy of anything first
      expect(provider.calls.filter((call) => call.name === 'saveFiles')).toHaveLength(saves);
      expect(provider.calls.filter((call) => call.name === 'remove').map((call) => call.ref)).toEqual([`fake-${brick.id}`]);
      expect(provider.calls.filter((call) => call.name === 'deleteSavedCopy').map((call) => call.ref)).toEqual([brick.id]);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ machinePending: false, copyPending: false, doneAt: expect.any(Date), providerRef: null });
      // A file a person sent is taken out of the uploader by the bot server (the list that already exists for it); what the Brick made is the person's
      expect(await prisma.botFileRemoval.findMany({ where: { botId: brick.id } })).toEqual([expect.objectContaining({ bucket: 'chat', fileId: `up-${tag}-${brick.id}` })]);

      // What a person owns stays, and the Brick's name on it is a neutral line
      expect(await prisma.artifact.findUniqueOrThrow({ where: { id: brick.artifactId } })).toMatchObject({ ownerId: sara.id, title: 'Menu', makerName: DELETED_MAKER_NAME });
      // Money stays and nothing said: amounts, ids and dates, never a title, a sponsor's name or the words of a voice note
      expect(await prisma.meterEvent.count({ where: { botId: brick.id, kind: 'model_call', costMicros: BigInt(7000) } })).toBe(1);
      expect(await prisma.taskReceipt.findFirstOrThrow({ where: { botId: brick.id } })).toMatchObject({ title: 'A task', payerName: null, chargedMicros: BigInt(1_250_000), payerKind: 'sponsor', state: 'done' });
      expect(await prisma.voiceNoteTurn.findFirstOrThrow({ where: { botId: brick.id } })).toMatchObject({ buffer: null, bufferUntil: null, providerRefs: null, seconds: 12, costMicros: 4000 });

      // Another Brick of the same person is not touched by any of it
      expect(await owned(other.id)).toMatchObject({ bot: 1, memory: 1, conversations: 1, forgets: 2, metrics: 1, tests: 1, spendRules: 1, setups: 1, goals: 1, files: 2 });
      expect(await prisma.artifact.findUniqueOrThrow({ where: { id: other.artifactId } })).toMatchObject({ makerName: 'Bystander Brick' });
      expect(await prisma.botFileRemoval.count({ where: { botId: other.id } })).toBe(0);
    });

    it('is the same whether the sweep asked for one person or for everyone, and asked twice changes nothing more', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Twice Brick');
      await deleteBrick(brick.id, sara.id, NOW);
      expect(await removeGoneBricks(later(8))).toContain(brick.id);
      expect(await owned(brick.id)).toEqual(NOTHING);
      expect(await removeGoneBricks(later(9), sara.id)).toEqual([]);
      expect(await removeGoneBricks(later(9))).not.toContain(brick.id);
      expect(await prisma.brickPurge.count({ where: { botId: brick.id } })).toBe(1);
    });

    it('purges a Brick that never had a computer without asking any provider, and one whose machine was never written down still has that machine looked for', async () => {
      const sara = await person('sara');
      const plain = await fullBrick(sara, 'No computer');
      await deleteBrick(plain.id, sara.id, NOW);
      expect(await removeGoneBricks(later(8), sara.id)).toEqual([plain.id]);
      expect(provider.calls).toEqual([]);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: plain.id } })).toMatchObject({ machinePending: false, copyPending: false, doneAt: expect.any(Date) });

      // A computer record with no machine written down (a make that was cut off): nothing is skipped, any machine made for this Brick is removed
      const cut = await fullBrick(sara, 'Cut off');
      await giveComputer(cut.id, sara.id);
      await deleteBrick(cut.id, sara.id, NOW);
      expect(await removeGoneBricks(later(8), sara.id)).toEqual([cut.id]);
      expect(provider.calls.filter((call) => call.name === 'removeAllFor').map((call) => call.ref)).toEqual([cut.id]);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: cut.id } })).toMatchObject({ doneAt: expect.any(Date) });
    });
  });

  describe('outside deletions are retried, never a reason to keep the Brick (F08)', () => {
    it('writes what is left outside with the purge, tries again with growing waits, and says so loudly when it keeps failing', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Stuck Brick', { computer: true });
      await deleteBrick(brick.id, sara.id, NOW);
      provider.failRemove = true;
      provider.failDeleteCopy = true;
      const waits: number[] = [];
      let at = later(8);
      expect(await removeGoneBricks(at, sara.id)).toEqual([brick.id]);
      // The Brick and everything it owned is gone, whatever the provider did
      expect(await owned(brick.id)).toEqual(NOTHING);
      for (let i = 0; i < 4; i++) {
        const note = await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } });
        expect(note).toMatchObject({ machinePending: true, copyPending: true, doneAt: null, attempts: i + 1 });
        waits.push(note.nextTryAt.getTime() - at.getTime());
        at = note.nextTryAt;
        // Four failures are not yet a reason to wake the team
        if (i === 3) expect(Sentry.captureMessage).not.toHaveBeenCalled();
        await removeGoneBricks(at);
      }
      // 1 minute, 5, 15, 60: each wait longer than the one before
      expect(waits.map((ms) => ms / 60_000)).toEqual([1, 5, 15, 60]);
      // The fifth failure goes to the team
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      // The provider is back: it finishes, once
      provider.failRemove = false;
      provider.failDeleteCopy = false;
      const sixth = await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } });
      await removeGoneBricks(sixth.nextTryAt);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ machinePending: false, copyPending: false, doneAt: expect.any(Date), providerRef: null });
    });

    it('does not lose the machine when the server has no provider for it right now: the note stays, and a later server with the provider finishes it', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Offline Brick', { computer: true });
      await deleteBrick(brick.id, sara.id, NOW);
      setComputerProviderForTests(null);
      delete process.env.AGENT37_API_KEY;
      process.env.COMPUTER_PROVIDER = '';
      expect(await removeGoneBricks(later(8), sara.id)).toEqual([brick.id]);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ machinePending: true, copyPending: true, providerRef: `fake-${brick.id}`, attempts: 1 });
      process.env.COMPUTER_PROVIDER = 'fake';
      setComputerProviderForTests(provider);
      await removeGoneBricks(later(9));
      expect(provider.calls.filter((call) => call.name === 'remove').map((call) => call.ref)).toContain(`fake-${brick.id}`);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ doneAt: expect.any(Date) });
    });

    it('waits only for the books (our own table, money) and never for a provider: a missing line is written first, and one that cannot be written keeps the Brick whole until it can', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Books Brick', { computer: true });
      await deleteBrick(brick.id, sara.id, NOW);
      provider.failRemove = true;
      const job = await prisma.computerJob.findFirstOrThrow({ where: { botId: brick.id } });
      await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${job.id}:time` } });
      (meter.recordMeterEvent as jest.Mock).mockRejectedValue(new Error('The books are down'));
      try {
        expect(await purgeBrick(brick.id, later(8))).toBe('books');
        expect(await owned(brick.id)).toMatchObject({ bot: 1, memory: 1, jobs: 1 });
      } finally {
        (meter.recordMeterEvent as jest.Mock).mockImplementation(actualRecord);
      }
      // The books work again: the line is written, then the Brick is purged even though the provider is down
      expect(await purgeBrick(brick.id, later(8))).toBe('purged');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${job.id}:time` } })).toBe(1);
      expect(await owned(brick.id)).toEqual(NOTHING);
    });
  });

  describe('nothing is written back (A31)', () => {
    it('a bot server that still holds the purged Brick gets its saves answered as done and nothing comes back: memory, chats and metrics', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Held Brick');
      await deleteBrick(brick.id, sara.id, NOW);
      await removeGoneBricks(later(8), sara.id);
      expect(await isPurged(brick.id)).toBe(true);

      const memory = await saveMemory(
        asBotServer(`/api/bots/memory/${brick.id}`, { saveType: 'periodic', memories: [{ userUuid: sara.uuid, userId: sara.id, isGuest: false, memories: { personalInfo: { name: 'Sara', preferences: ['jazz'], facts: [], lastInfoUpdate: 2 } } }] }),
        params(brick.id),
      );
      expect(memory.status).toBe(200);
      expect(await memory.json()).toMatchObject({ gone: true });
      const chat = await saveConversation(asBotServer(`/api/bots/${brick.id}/conversations`, { userUuid: sara.uuid, userId: sara.id, isGuest: false, messages: [{ role: 'user', content: 'hello again' }], startedAt: later(9).toISOString() }), params(brick.id));
      expect(chat.status).toBe(200);
      expect(await chat.json()).toMatchObject({ status: 'gone' });
      const metrics = await saveMetrics(asBotServer('/api/bots/metrics', { metrics: [{ botId: brick.id, timestamp: later(9).toISOString(), metrics: { responseTime: 2 } }] }));
      expect(metrics.status).toBe(200);
      // Give the fire-and-forget part of a memory save its moment: it must have written nothing either
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await owned(brick.id)).toEqual(NOTHING);
    });

    it('a save for a Brick that was only deleted (inside its days) is still taken as before', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Waiting Brick');
      await deleteBrick(brick.id, sara.id, NOW);
      expect(await isPurged(brick.id)).toBe(false);
      const chat = await saveConversation(asBotServer(`/api/bots/${brick.id}/conversations`, { userUuid: sara.uuid, userId: sara.id, isGuest: false, messages: [{ role: 'user', content: 'still here' }], startedAt: later(1).toISOString() }), params(brick.id));
      expect(await chat.json()).toMatchObject({ status: expect.stringMatching(/^(created|updated)$/), conversationId: expect.anything() });
    });

    it('keeps a bare marker for a while after everything outside is confirmed gone, then removes it; one still waiting on the outside is never removed', async () => {
      const sara = await person('sara');
      const done = await fullBrick(sara, 'Marker done');
      const stuck = await fullBrick(sara, 'Marker stuck', { computer: true });
      await deleteBrick(done.id, sara.id, NOW);
      await deleteBrick(stuck.id, sara.id, NOW);
      provider.failRemove = true;
      await removeGoneBricks(later(8));
      expect(await isPurged(done.id)).toBe(true);
      // The marker holds no content: an id, the owner for the books, dates and what is pending
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: done.id } })).toMatchObject({ providerRef: null, machinePending: false, copyPending: false });
      await removeGoneBricks(later(8 + PURGE_MARKER_DAYS - 1));
      expect(await isPurged(done.id)).toBe(true);
      await removeGoneBricks(later(8 + PURGE_MARKER_DAYS + 1));
      expect(await isPurged(done.id)).toBe(false);
      expect(await isPurged(stuck.id)).toBe(true);
    });
  });
});
