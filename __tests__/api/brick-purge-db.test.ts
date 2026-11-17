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
// The give-back of a failed job's model calls, wrapped the same way
const actualGiveBack = jest.requireActual('@/lib/computer-calls').giveBackModelCalls;
jest.mock('@/lib/computer-calls', () => {
  const actual = jest.requireActual('@/lib/computer-calls');
  return { ...actual, giveBackModelCalls: jest.fn(actual.giveBackModelCalls) };
});
import * as computerCalls from '@/lib/computer-calls';
import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick, removeGoneBricks, undoBrickDelete } from '@/lib/brick-delete';
import { finishOutside, isPurged, purgeBrick, confirmChatPurges, DELETED_MAKER_NAME } from '@/lib/brick-purge';
import { GET as listChatPurges, POST as confirmChatPurgesRoute } from '@/app/api/brick-chat-purges/route';
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

function asBotServerGet(path: string, token: string | null = SERVICE_TOKEN) {
  return new NextRequest(`http://localhost${path}`, { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} });
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
      // Its chat rooms are cleared by the bot server, which says so: until then the purge is not finished
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ machinePending: false, copyPending: false, chatPending: true, doneAt: null });
      expect(await confirmChatPurges([brick.id], later(8))).toBe(1);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ machinePending: false, copyPending: false, chatPending: false, doneAt: expect.any(Date), providerRef: null });
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
      await confirmChatPurges([plain.id], later(8));
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: plain.id } })).toMatchObject({ machinePending: false, copyPending: false, doneAt: expect.any(Date) });

      // A computer record with no machine written down (a make that was cut off): nothing is skipped, any machine made for this Brick is removed
      const cut = await fullBrick(sara, 'Cut off');
      await giveComputer(cut.id, sara.id);
      await deleteBrick(cut.id, sara.id, NOW);
      expect(await removeGoneBricks(later(8), sara.id)).toEqual([cut.id]);
      expect(provider.calls.filter((call) => call.name === 'removeAllFor').map((call) => call.ref)).toEqual([cut.id]);
      await confirmChatPurges([cut.id], later(8));
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
      // The provider side is done, but the chat rooms are not cleared yet: not finished
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ machinePending: false, copyPending: false, chatPending: true, doneAt: null });
      await confirmChatPurges([brick.id], sixth.nextTryAt);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ machinePending: false, copyPending: false, chatPending: false, doneAt: expect.any(Date), providerRef: null });
    });

    it('is not done while the books cannot say that nothing is kept any more: the provider side is already finished, and the next try writes the line', async () => {
      const sara = await person('sara');
      provider.disk = 4_000_000_000;
      const brick = await fullBrick(sara, 'Books last Brick', { computer: true });
      await deleteBrick(brick.id, sara.id, NOW);
      (meter.recordMeterEvent as jest.Mock).mockRejectedValue(new Error('The books are down'));
      try {
        expect(await removeGoneBricks(later(8), sara.id)).toEqual([brick.id]);
      } finally {
        (meter.recordMeterEvent as jest.Mock).mockImplementation(actualRecord);
      }
      const note = await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } });
      expect(note).toMatchObject({ machinePending: false, copyPending: false, doneAt: null, attempts: 1 });
      const newest = async () => Number((await prisma.meterEvent.findFirstOrThrow({ where: { botId: brick.id, kind: 'stored_bytes' }, orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }] })).quantity);
      expect(await newest()).toBeGreaterThan(0);
      await confirmChatPurges([brick.id], note.nextTryAt);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ doneAt: expect.any(Date) });
      expect(await newest()).toBe(0);
      // The machine was not asked to go a second time
      expect(provider.calls.filter((call) => call.name === 'remove')).toHaveLength(1);
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
      await confirmChatPurges([brick.id], later(9));
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

  it('keeps a Brick whole while a failed job\u2019s model calls are still written against the person: the jobs go with the Brick, and nothing could find those calls to give them back after', async () => {
    const sara = await person('sara');
    const brick = await fullBrick(sara, 'Owed Brick', { computer: true });
    const job = await prisma.computerJob.findFirstOrThrow({ where: { botId: brick.id } });
    // The job failed on our side, and one of its model calls was written against the person
    await prisma.computerJob.update({ where: { id: job.id }, data: { status: 'failed', endedBy: 'error' } });
    const eventId = `computer:${job.id}:call:owed`;
    await prisma.meterEvent.create({
      data: { eventId, kind: 'model_call', pool: 'computer', occurredAt: NOW, personKey: `person:${sara.id}`, personId: sara.id, botId: brick.id, brick: true, payerKind: 'universe', jobId: job.id, sourceRef: `computer_jobs:${job.id}`, quantity: BigInt(1), unit: 'call', costMicros: BigInt(4000), basis: 'measured' },
    });
    await deleteBrick(brick.id, sara.id, NOW);
    (computerCalls.giveBackModelCalls as jest.Mock).mockRejectedValue(new Error('The books are down'));
    try {
      expect(await purgeBrick(brick.id, later(8))).toBe('books');
      expect(await owned(brick.id)).toMatchObject({ bot: 1, jobs: 1 });
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId } })).toMatchObject({ personKey: `person:${sara.id}` });
    } finally {
      (computerCalls.giveBackModelCalls as jest.Mock).mockImplementation(actualGiveBack);
    }
    // The books work again: the call is given back (written against nobody, still counted as our own cost), then the Brick is purged
    expect(await purgeBrick(brick.id, later(8))).toBe('purged');
    expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId } })).toMatchObject({ personKey: 'unknown', personId: null });
    expect(await owned(brick.id)).toEqual(NOTHING);
  });

  describe('chat rooms: a deleted Brick keeps nothing in chat (R29)', () => {
    it('writes that its chat rooms are still to clear with the purge, for every purged Brick, and keeps no content in that note', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Chatty Brick');
      await deleteBrick(brick.id, sara.id, NOW);
      expect(await prisma.brickPurge.count({ where: { botId: brick.id } })).toBe(0);
      await removeGoneBricks(later(8), sara.id);
      const note = await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } });
      expect(note).toMatchObject({ chatPending: true, doneAt: null });
      expect(Object.keys(note).sort()).toEqual(['attempts', 'botId', 'chatPending', 'copyPending', 'doneAt', 'lastTriedAt', 'machinePending', 'nextTryAt', 'ownerId', 'provider', 'providerRef', 'purgedAt']);
    });

    it('lists, to the bot server only, the Bricks whose chats are to clear (the id and nothing else), and a Brick Undo gave back is never on it', async () => {
      const sara = await person('sara');
      const gone = await fullBrick(sara, 'Listed Brick');
      const back = await fullBrick(sara, 'Undone Brick');
      await deleteBrick(gone.id, sara.id, NOW);
      await deleteBrick(back.id, sara.id, NOW);
      await undoBrickDelete(back.id, sara.id, later(3));
      await removeGoneBricks(later(8), sara.id);

      expect((await listChatPurges(asBotServerGet('/api/brick-chat-purges', null))).status).toBe(401);
      expect((await listChatPurges(asBotServerGet('/api/brick-chat-purges', 'wrong-token'))).status).toBe(401);
      const listed = await listChatPurges(asBotServerGet('/api/brick-chat-purges'));
      expect(listed.status).toBe(200);
      const { purges } = await listed.json();
      expect(purges).toContainEqual({ botId: gone.id });
      expect(purges.map((one: { botId: string }) => one.botId)).not.toContain(back.id);
      expect(purges.every((one: object) => Object.keys(one).join() === 'botId')).toBe(true);
    });

    it('does not call the saved files gone while a save may still put a copy there, and settles a save that stopped for good', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Saving Brick', { computer: true });
      await deleteBrick(brick.id, sara.id, NOW);
      // A save began (its row is written first) before the purge, and is still running
      const live = await prisma.savedCopyWrite.create({ data: { botId: brick.id, expiresAt: later(8) } });
      await removeGoneBricks(later(8), sara.id);
      const deletes = () => provider.calls.filter((call) => call.name === 'deleteSavedCopy').length;
      const first = await finishOutside(brick.id, later(8));
      expect(first.done).toBe(false);
      expect(first.left.join()).toContain('save was still running');
      expect(deletes()).toBeGreaterThan(0);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ copyPending: true, doneAt: null });
      // The save ends by itself and lets go of its row: the next try deletes once more and the saved files are gone
      await prisma.savedCopyWrite.delete({ where: { id: live.id } });
      const before = deletes();
      await prisma.brickPurge.update({ where: { botId: brick.id }, data: { chatPending: false } });
      expect((await finishOutside(brick.id, later(9))).done).toBe(true);
      expect(deletes()).toBeGreaterThan(before);
      // A save that stopped for good (its row is older than the longest a save runs) is settled the same way, and its row goes
      const other = await fullBrick(sara, 'Stopped save', { computer: true });
      await deleteBrick(other.id, sara.id, NOW);
      await prisma.savedCopyWrite.create({ data: { botId: other.id, expiresAt: new Date(later(8).getTime() - 1000) } });
      await removeGoneBricks(later(8), sara.id);
      await prisma.brickPurge.update({ where: { botId: other.id }, data: { chatPending: false } });
      expect((await finishOutside(other.id, later(8))).done).toBe(true);
      expect(await prisma.savedCopyWrite.count({ where: { botId: other.id } })).toBe(0);
    });

    it('lists them a page at a time, so Bricks that cannot be cleared for now never hide the ones behind them', async () => {
      const sara = await person('sara');
      const made = [await fullBrick(sara, 'Page one'), await fullBrick(sara, 'Page two'), await fullBrick(sara, 'Page three')];
      for (const brick of made) await deleteBrick(brick.id, sara.id, NOW);
      await removeGoneBricks(later(8), sara.id);
      // The bot server reads one at a time and confirms none of them (they cannot be cleared for now): each page is one Brick and the next page is behind it
      const seen: string[] = [];
      let after: string | null = null;
      for (let page = 0; page < 500; page++) {
        const answer = await listChatPurges(asBotServerGet(`/api/brick-chat-purges?limit=1${after ? `&after=${encodeURIComponent(after)}` : ''}`));
        expect(answer.status).toBe(200);
        const body: { purges: { botId: string }[]; next: string | null } = await answer.json();
        expect(body.purges.length).toBeLessThanOrEqual(1);
        seen.push(...body.purges.map((one) => one.botId));
        if (!body.next) break;
        after = body.next;
      }
      for (const brick of made) expect(seen).toContain(brick.id);
      expect(new Set(seen).size).toBe(seen.length);
      expect(await prisma.brickPurge.count({ where: { botId: { in: made.map((brick) => brick.id) }, chatPending: true } })).toBe(3);
      expect((await listChatPurges(asBotServerGet('/api/brick-chat-purges?limit=0'))).status).toBe(400);
    });

    it('stops listing a Brick once the bot server confirms it, finishes a purge that waited only for the chat at once, and ignores ids it does not know or twice', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Confirmed Brick');
      await deleteBrick(brick.id, sara.id, NOW);
      await removeGoneBricks(later(8), sara.id);

      const bad = await confirmChatPurgesRoute(asBotServer('/api/brick-chat-purges', { botIds: [] }));
      expect(bad.status).toBe(400);
      expect((await confirmChatPurgesRoute(asBotServer('/api/brick-chat-purges', { botIds: [brick.id], extra: 1 }))).status).toBe(400);
      const unauthorised = new NextRequest('http://localhost/api/brick-chat-purges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botIds: [brick.id] }) });
      expect((await confirmChatPurgesRoute(unauthorised)).status).toBe(401);
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ chatPending: true, doneAt: null });

      const done = await confirmChatPurgesRoute(asBotServer('/api/brick-chat-purges', { botIds: [brick.id, `unknown-${tag}`] }));
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ confirmed: 1 });
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ chatPending: false, doneAt: expect.any(Date) });
      const { purges } = await (await listChatPurges(asBotServerGet('/api/brick-chat-purges'))).json();
      expect(purges.map((one: { botId: string }) => one.botId)).not.toContain(brick.id);
      expect(await (await confirmChatPurgesRoute(asBotServer('/api/brick-chat-purges', { botIds: [brick.id] }))).json()).toEqual({ confirmed: 0 });
    });

    it('does not hurry a machine that is still waiting for its own retry: confirming the chat leaves that schedule alone', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Machine first Brick', { computer: true });
      await deleteBrick(brick.id, sara.id, NOW);
      provider.failRemove = true;
      await removeGoneBricks(later(8), sara.id);
      const before = await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } });
      const removes = provider.calls.filter((call) => call.name === 'remove').length;
      await confirmChatPurges([brick.id], later(8));
      const after = await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } });
      expect(after).toMatchObject({ chatPending: false, machinePending: true, doneAt: null, attempts: before.attempts, nextTryAt: before.nextTryAt });
      expect(provider.calls.filter((call) => call.name === 'remove')).toHaveLength(removes);
    });

    it('tells the team when the chat rooms are still not cleared after five tries, and keeps the marker after they are confirmed', async () => {
      const sara = await person('sara');
      const brick = await fullBrick(sara, 'Never cleared Brick');
      await deleteBrick(brick.id, sara.id, NOW);
      await removeGoneBricks(later(8), sara.id);
      let at = later(8);
      for (let i = 0; i < 4; i++) {
        at = (await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).nextTryAt;
        await removeGoneBricks(at);
      }
      // Other Bricks' notes in a shared test database are swept too: only this Brick's message counts here
      const told = (Sentry.captureMessage as jest.Mock).mock.calls.filter((call) => call[1]?.tags?.botId === brick.id);
      expect(told).toHaveLength(1);
      expect(told[0][0]).toContain('chat rooms');
      // A year on, the note is still there and still waiting for its chats; once they are confirmed the marker stays for good
      await removeGoneBricks(later(8 + 400));
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.id } })).toMatchObject({ chatPending: true, doneAt: null });
      await confirmChatPurges([brick.id], later(8 + 400));
      await removeGoneBricks(later(8 + 800));
      expect(await isPurged(brick.id)).toBe(true);
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

    it('keeps a bare marker for good after everything outside is confirmed gone, so a bot server that holds the Brick a year later still cannot write its chat back', async () => {
      const sara = await person('sara');
      const done = await fullBrick(sara, 'Marker done');
      const stuck = await fullBrick(sara, 'Marker stuck', { computer: true });
      await deleteBrick(done.id, sara.id, NOW);
      await deleteBrick(stuck.id, sara.id, NOW);
      provider.failRemove = true;
      await removeGoneBricks(later(8));
      await confirmChatPurges([done.id], later(8));
      expect(await isPurged(done.id)).toBe(true);
      // The marker holds no content: an id, the owner for the books, dates and what is pending
      expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: done.id } })).toMatchObject({ providerRef: null, machinePending: false, copyPending: false, chatPending: false });
      await removeGoneBricks(later(8 + 400));
      expect(await isPurged(done.id)).toBe(true);
      expect(await isPurged(stuck.id)).toBe(true);
      const chat = await saveConversation(asBotServer(`/api/bots/${done.id}/conversations`, { userUuid: sara.uuid, userId: sara.id, isGuest: false, messages: [{ role: 'user', content: 'a year later' }], startedAt: later(8 + 400).toISOString() }), params(done.id));
      expect(await chat.json()).toMatchObject({ conversationId: null, status: 'gone' });
      expect(await prisma.botsConversation.count({ where: { botId: done.id } })).toBe(0);
    });
  });
});
