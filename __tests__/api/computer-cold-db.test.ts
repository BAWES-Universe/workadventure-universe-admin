/**
 * Cold storage for a Brick's computer against a real database, with the PRETEND provider and an in-memory bucket: what only the database can show.
 * A computer idle for the Limit's days is packed away: the copy is stored, restored on a throwaway computer and checked BEFORE the computer is
 * deleted, and the deletion is confirmed. A job that arrives, a Brick that is deleted, a proof that fails or a provider that still lists the computer
 * all keep the computer. A return restores the newest proved copy, falls back to the one before it (and says so), and leaves the Brick cold when no
 * copy restores. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-cold-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), withScope: jest.fn() }));
// The books' write path, wrapped so a test can make it refuse one kind of line
const actualRecord = jest.requireActual('@/lib/meter').recordMeterEvent;
jest.mock('@/lib/meter', () => {
  const actual = jest.requireActual('@/lib/meter');
  return { ...actual, recordMeterEvent: jest.fn(actual.recordMeterEvent) };
});

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { memoryStore } from '../helpers/archive-store';
import { waitUntilBlockedOnLock } from '../helpers/db-blocked';
import { createBrick } from '@/lib/brick-create';
import { COLD_RUN_MAX_MS } from '@/lib/computer-values';
import { saveServerLimits } from '@/lib/bot-limits';
import * as meter from '@/lib/meter';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { bringBackFromCold, coldStatus, coldStep, heartbeat, packAway, restoreDrill, STUCK_MS } from '@/lib/computer-cold';
import { readOutsideManifest } from '@/lib/computer-outside';
import { computerView, giveComputer, startJob, sweepComputers } from '@/lib/computer';
import { finishOutside, purgeBrick } from '@/lib/brick-purge';
import { deleteBrick, undoBrickDelete } from '@/lib/brick-delete';
import { listDeletedBricks } from '@/lib/brick-default';
import { computerReadiness } from '@/lib/computer-readiness';
import { CopyOutcomeUnknown } from '@/lib/agent37/saved-copies';
import { archiveById, deleteAllArchives, markVerified, removeBrickObjects, mintDownloadToken, pruneArchives, removeStrayCopies, setArchiveStoreForTests, setStrayPassForTests, setWriteLimitForTests, storageDeletionsWaiting, storeArchive, STORAGE_DELETION_ALERT_MS, STRAY_CURSOR_KEY, verifiedArchives } from '@/lib/computer-archives';
import { GET as download } from '@/app/api/computer/archives/[id]/download/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const NOW = new Date('2026-11-15T12:00:00Z');
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = { provider: process.env.COMPUTER_PROVIDER, url: process.env.ADMIN_API_URL, publicUrl: process.env.NEXT_PUBLIC_API_URL };

let bucket: ReturnType<typeof memoryStore>;

async function idleBrick(daysIdle = 20) {
  const unique = `cold-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name: 'Cold' } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: 'Cold Brick' });
  await giveComputer(brick.id, user.id, NOW);
  const ref = `fake-${brick.id}`;
  await prisma.brickComputer.update({
    where: { botId: brick.id },
    data: { machine: 'resting', provider: 'fake', providerRef: ref, madeAt: new Date(NOW.getTime() - 60 * DAY), lastWorkedAt: new Date(NOW.getTime() - daysIdle * DAY) },
  });
  return { personId: user.id, botId: brick.id, ref };
}

const row = (botId: string) => prisma.brickComputer.findUniqueOrThrow({ where: { botId } });
const names = () => provider.calls.map((call) => (call.ref ? `${call.name}:${call.ref}` : call.name));
const bearer = (id: string, ref: string) => ({ authorization: `Bearer ${mintDownloadToken(id, ref)}` });
const fetchCopy = (id: string, headers: Record<string, string>) => download(new NextRequest(`http://orbit.test/api/computer/archives/${id}/download`, { headers }), { params: Promise.resolve({ id }) });

run('cold storage for a Brick’s computer, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    // The restore keys are signed with a key made from it
    process.env.ENCRYPTION_KEY ||= 'ab'.repeat(32);
    process.env.ADMIN_API_URL = 'https://orbit.test';
    delete process.env.NEXT_PUBLIC_API_URL;
  });
  beforeEach(async () => {
    await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
    await prisma.computerArchive.deleteMany({});
    await prisma.computerColdRun.deleteMany({});
    await prisma.brickComputer.deleteMany({});
    await prisma.meterEvent.deleteMany({});
    await prisma.meterReservation.deleteMany({});
    await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down'] } } });
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
    bucket = memoryStore();
    setArchiveStoreForTests(bucket.store);
    provider = new FakeComputerProvider();
    provider.homeArchive = Buffer.from('the home folder as a tar.gz');
    setComputerProviderForTests(provider);
  });
  afterAll(async () => {
    await prisma.computerArchive.deleteMany({});
    await prisma.computerColdRun.deleteMany({});
    await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down'] } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    setComputerProviderForTests(null);
    setArchiveStoreForTests(null);
    process.env.COMPUTER_PROVIDER = env.provider;
    if (env.url === undefined) delete process.env.ADMIN_API_URL;
    else process.env.ADMIN_API_URL = env.url;
    if (env.publicUrl !== undefined) process.env.NEXT_PUBLIC_API_URL = env.publicUrl;
    await prisma.$disconnect();
  });

  describe('packing away', () => {
    it('proves the copy on a throwaway computer BEFORE the computer is deleted, then confirms the deletion', async () => {
      const brick = await idleBrick();
      expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
      const calls = names();
      const restored = calls.findIndex((call) => call.startsWith('restoreInto:scratch-'));
      const removed = calls.indexOf(`remove:${brick.ref}`);
      expect(restored).toBeGreaterThan(calls.indexOf(`streamFiles:${brick.ref}`));
      expect(removed).toBeGreaterThan(restored);
      expect(calls.indexOf(`confirmRemoved:${brick.ref}`)).toBeGreaterThan(removed);
      // The throwaway computer is removed too, and billing for both is confirmed stopped
      expect(calls).toContain('remove:scratch-1');
      expect(calls).toContain('confirmRemoved:scratch-1');
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null, packStage: null, packClaimedAt: null, packFailures: 0 });
      expect((await row(brick.botId)).packedAt).not.toBeNull();
      const [copy] = await verifiedArchives(brick.botId);
      expect(copy).toMatchObject({ generation: 1, state: 'verified', bytes: bucket.objects.get(copy.objectKey)!.length });
      expect(copy.proofMs).toBe(provider.restoreMs);
      // What the scratch computer was asked: this copy, a key for this copy and this computer, the sha the bytes must have
      expect(provider.restored[0].source).toMatchObject({ sha256: copy.sha256, url: `https://orbit.test/api/computer/archives/${copy.id}/download` });
      // The old plain copy is replaced by the cold ones, and the books say what is kept
      expect(provider.calls.some((call) => call.name === 'deleteSavedCopy')).toBe(true);
      const kept = await prisma.meterEvent.findFirst({ where: { kind: 'stored_bytes', botId: brick.botId }, orderBy: { recordedAt: 'desc' } });
      expect(Number(kept?.quantity)).toBe(copy.bytes);
      // The awake time it took (the computer's own and the throwaway one) is written down and costs the computer pool
      expect(await prisma.computerColdRun.count({ where: { botId: brick.botId, kind: 'pack', scratch: false } })).toBe(1);
      expect(await prisma.computerColdRun.count({ where: { botId: brick.botId, kind: 'pack', scratch: true } })).toBe(1);
      expect(await prisma.meterEvent.count({ where: { kind: 'computer_time', botId: brick.botId, jobId: null } })).toBe(2);
    });

    it('leaves a computer alone until it has been idle for the Limit’s days, and follows a changed Limit', async () => {
      const brick = await idleBrick(5);
      expect((await coldStep(provider, NOW)).packed).toBe(0);
      expect((await row(brick.botId)).machine).toBe('resting');
      await saveServerLimits({ bricks: { coldStorageDays: 3 } }, 'admin');
      expect((await coldStep(provider, NOW)).packed).toBe(1);
      expect((await row(brick.botId)).machine).toBe('cold');
    });

    it('never packs a computer a job holds or has queued, nor one used inside the idle days', async () => {
      const busy = await idleBrick();
      await prisma.computerJob.create({ data: { botId: busy.botId, personId: busy.personId, title: 'waiting', status: 'queued' } });
      const recent = await idleBrick();
      await prisma.computerJob.create({ data: { botId: recent.botId, personId: recent.personId, title: 'yesterday', status: 'done', startedAt: new Date(NOW.getTime() - 2 * DAY), endedAt: new Date(NOW.getTime() - 2 * DAY + 60_000) } });
      expect((await coldStep(provider, NOW)).packed).toBe(0);
      expect((await row(busy.botId)).machine).toBe('resting');
      expect((await row(recent.botId)).machine).toBe('resting');
    });

    it('a PAUSED job is not use: it holds nothing, so its computer is packed away (and the job comes back through the line when resumed); CONTROL: a job waiting in line still keeps it', async () => {
      const paused = await idleBrick();
      await prisma.computerJob.create({ data: { botId: paused.botId, personId: paused.personId, title: 'paused for weeks', status: 'queued', queuedFor: 'paused', pausedWhy: 'person', pausedAt: new Date(NOW.getTime() - 20 * DAY), createdAt: new Date(NOW.getTime() - 30 * DAY), pauses: 1 } });
      const waiting = await idleBrick();
      await prisma.computerJob.create({ data: { botId: waiting.botId, personId: waiting.personId, title: 'in line', status: 'queued', queuedFor: 'turn', createdAt: new Date(NOW.getTime() - 30 * DAY) } });
      expect((await coldStep(provider, NOW)).packed).toBe(1);
      expect((await row(paused.botId)).machine).toBe('cold');
      expect((await row(waiting.botId)).machine).toBe('resting');
    });

    it('packs only a few computers a sweep, so a first run is never one burst of spending', async () => {
      for (let i = 0; i < 4; i++) await idleBrick();
      expect((await coldStep(provider, NOW)).packed).toBe(2);
      expect(await prisma.brickComputer.count({ where: { machine: 'cold' } })).toBe(2);
    });

    it('keeps the computer when the proof fails: nothing is deleted, the bad copy is thrown away, and it is not tried again at once', async () => {
      const brick = await idleBrick();
      provider.restoreResults = [{ ok: false, reason: 'compare_failed', ms: 10 }];
      expect(await packAway(brick.botId, provider, NOW)).toBe('failed');
      expect(names()).not.toContain(`remove:${brick.ref}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'stopped', providerRef: brick.ref, packStage: null, packFailures: 1 });
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(0);
      // The scratch computer was removed even though the proof failed
      expect(names()).toContain('remove:scratch-1');
      provider.calls.length = 0;
      expect((await coldStep(provider, NOW)).packed).toBe(0);
      expect(provider.calls.some((call) => call.name === 'prepack')).toBe(false);
      // After the wait it is tried again, and this time it passes
      expect((await coldStep(provider, new Date(Date.now() + 2 * 60 * 60_000))).packed).toBe(1);
    });

    it('a give-up takes the computer\'s row, so it waits for a take-over leader\'s stop that holds it longer than Prisma\'s own 5 s, and still gives the computer back', async () => {
      const brick = await idleBrick();
      let release: () => void = () => undefined;
      let holder: Promise<void> = Promise.resolve();
      const restore = jest.spyOn(provider, 'restoreInto').mockImplementationOnce(async () => {
        // While the proof runs, another connection takes the row and holds it for 7 s
        let locked: () => void = () => undefined;
        const taken = new Promise<void>((resolve) => (locked = resolve));
        holder = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1 AS one FROM "brick_computers" WHERE "bot_id" = ${brick.botId} FOR UPDATE`;
            locked();
            await new Promise<void>((resolve) => (release = resolve));
          },
          { timeout: 60_000 },
        );
        await taken;
        setTimeout(() => release(), 7_000);
        return { ok: false, reason: 'compare_failed', ms: 10 };
      });
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(await packAway(brick.botId, provider, NOW)).toBe('failed');
        expect(await row(brick.botId)).toMatchObject({ machine: 'stopped', providerRef: brick.ref, packStage: null, packFailures: 1 });
        // Not by a second try after a first one gave up with a transaction timeout
        expect(errors.mock.calls.map((call) => String(call.join(' '))).filter((line) => /Transaction API error|expired transaction/.test(line))).toEqual([]);
      } finally {
        errors.mockRestore();
        restore.mockRestore();
        release();
        await holder;
      }
    }, 60_000);

    it('a proof that ran so long its claim was taken over cannot fail the copy another run has proved since: the proved copy and the removal stay', async () => {
      const brick = await idleBrick();
      const original = provider.restoreInto.bind(provider);
      provider.restoreInto = async () => {
        void original;
        // Meanwhile the other run proved the same copy and moved the row on to the removal
        const archive = (await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } }));
        await markVerified(archive.id, 5);
        await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { packStage: 'removing' } });
        return { ok: false, reason: 'late_failure', ms: 10 };
      };
      expect(await packAway(brick.botId, provider, NOW)).toBe('busy');
      const archive = await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } });
      expect(archive.state).toBe('verified');
      expect(bucket.objects.size).toBeGreaterThan(0);
      expect(await row(brick.botId)).toMatchObject({ machine: 'packing', packStage: 'removing' });
    });

    it('says it is alive while a copy is being proved, so a slow proof is not taken for a stopped server', async () => {
      const brick = await idleBrick();
      const before = heartbeat.ms;
      heartbeat.ms = 25;
      try {
        const original = provider.restoreInto.bind(provider);
        let claimedAtStart: Date | null = null;
        let claimedAtEnd: Date | null = null;
        provider.restoreInto = async (ref, source) => {
          claimedAtStart = (await row(brick.botId)).packClaimedAt;
          await new Promise((resolve) => setTimeout(resolve, 200));
          claimedAtEnd = (await row(brick.botId)).packClaimedAt;
          return original(ref, source);
        };
        expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
        expect(claimedAtStart).not.toBeNull();
        expect((claimedAtEnd as unknown as Date).getTime()).toBeGreaterThan((claimedAtStart as unknown as Date).getTime());
      } finally {
        heartbeat.ms = before;
      }
    });

    it('another server’s clean-up leaves a copy alone while its pack-away is still alive, however old the copy is, and removes it once the pack-away stopped', async () => {
      const brick = await idleBrick();
      const old = new Date(NOW.getTime() - 3 * 3_600_000);
      const key = `computer-archives/${brick.botId}/1-test`;
      bucket.objects.set(key, Buffer.from('half written'));
      await prisma.computerArchive.create({ data: { botId: brick.botId, generation: 1, state: 'staging', objectKey: key, createdAt: old } });
      // A pack-away that has been copying for hours but said it was alive a minute ago
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'packing', packStage: 'claimed', packClaimedAt: new Date(NOW.getTime() - 60_000) } });
      expect(await pruneArchives(brick.botId, null, NOW)).toBe(0);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(1);
      expect(bucket.objects.has(key)).toBe(true);
      // The same pack-away silent for longer than a server may be: the half written copy is left behind and goes
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { packClaimedAt: new Date(NOW.getTime() - STUCK_MS - 60_000) } });
      expect(await pruneArchives(brick.botId, null, NOW)).toBe(1);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
    });

    it('a run whose claim was taken over during its proof changes nothing of the run that took over: the copy is not failed, the computer is not stopped', async () => {
      const brick = await idleBrick();
      provider.restoreInto = async () => {
        // Recovery took the claim over (a new id) while this run was still proving, and this run's proof then fails
        await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { packClaimId: 'taken-over', packClaimedAt: new Date() } });
        // Only what this run does from here on is looked at (the computer was put to sleep for the proof before it)
        provider.calls.length = 0;
        return { ok: false, reason: 'late_failure', ms: 10 };
      };
      expect(await packAway(brick.botId, provider, NOW)).toBe('busy');
      expect(await row(brick.botId)).toMatchObject({ machine: 'packing', packStage: 'stored', packClaimId: 'taken-over', packFailures: 0 });
      expect((await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } })).state).toBe('stored');
      expect(names().filter((call) => call.startsWith('stop:'))).toEqual([]);
    });

    it('CodeRabbit on #1040: a run that lost its claim between moving its step to `stored` and recording its stop records no stop and sends none', async () => {
      const brick = await idleBrick();
      const real = prisma.brickComputer.updateMany.bind(prisma.brickComputer);
      jest.spyOn(prisma.brickComputer, 'updateMany').mockImplementation((async (args: { data?: { packStage?: string } }) => {
        const done = await real(args as never);
        // Recovery takes the claim over right after the step moved to `stored`, before this run records its stop
        if (args.data?.packStage === 'stored') await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { packClaimId: 'taken-over', packClaimedAt: new Date() } });
        return done;
      }) as never);
      const result = await packAway(brick.botId, provider, NOW);
      jest.restoreAllMocks();
      expect(result).toBe('busy');
      expect(names().filter((call) => call.startsWith('stop:'))).toEqual([]);
      expect(await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM "computer_power_ops" WHERE "bot_id" = ${brick.botId}`).toEqual([{ n: BigInt(0) }]);
    });

    it('a pack-away stopped between marking its copy verified and moving its step on goes on from the proved copy: no new copy and no second proof', async () => {
      const brick = await idleBrick();
      // The server stopped after the proof passed and the copy was marked verified, before the step moved from "stored" to "verified"
      const archive = await storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>);
      await markVerified(archive.id, 10);
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'packing', packStage: 'stored', packArchiveId: archive.id, packClaimId: 'stopped-run', packClaimedAt: new Date(NOW.getTime() - STUCK_MS - 60_000) } });
      provider.calls.length = 0;
      const out = await coldStep(provider, NOW);
      expect(out.resumed).toBe(1);
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null, packStage: null, packFailures: 0 });
      // No new copy was streamed and no proof of this pack-away ran (the weekly drill the same sweep may run is a different kind of run)
      expect(names().filter((call) => call.startsWith('streamFiles'))).toEqual([]);
      expect(await prisma.computerColdRun.count({ where: { botId: brick.botId, kind: 'pack' } })).toBe(0);
      expect((await prisma.computerArchive.findUniqueOrThrow({ where: { id: archive.id } })).state).toBe('verified');
    });

    it('a pack-away whose computer is already being removed finishes when a job arrives: the Brick goes cold and the job brings it back from the copy', async () => {
      const brick = await idleBrick();
      const removeComputer = provider.remove.bind(provider);
      let broken = true;
      provider.remove = async (ref) => {
        if (broken && ref === brick.ref) throw new Error('the provider did not answer');
        return removeComputer(ref);
      };
      // The removal stops half way: the row stays at "removing" for the sweep
      expect(await packAway(brick.botId, provider, NOW)).toBe('busy');
      expect(await row(brick.botId)).toMatchObject({ machine: 'packing', packStage: 'removing' });
      broken = false;
      // A job arrives, and the sweep resumes the pack-away later
      await prisma.computerJob.create({ data: { botId: brick.botId, personId: brick.personId, title: 'arrived', status: 'running', startedAt: NOW, stretchStarted: NOW } });
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { packClaimedAt: new Date(NOW.getTime() - STUCK_MS - 60_000) } });
      const out = await coldStep(provider, NOW);
      expect(out.resumed).toBe(1);
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null, packStage: null });
    });

    it('a copy of a Brick purged while it was being written is not kept: no row and no object stay', async () => {
      const brick = await idleBrick();
      // The purge marker is written first, before the purge reads or deletes any copy
      await prisma.brickPurge.create({ data: { botId: brick.botId, machinePending: false, copyPending: true } });
      await expect(storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>)).rejects.toThrow();
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(0);
    });

    it('a write that fails before it takes up the stream (the Brick was purged) gives the stream up, so its connection is not held open', async () => {
      const brick = await idleBrick();
      await prisma.brickPurge.create({ data: { botId: brick.botId, machinePending: false, copyPending: true } });
      let cancelled = false;
      const response = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined), cancel: () => { cancelled = true; } });
      await expect(storeArchive(brick.botId, response)).rejects.toThrow('deleted');
      expect(cancelled).toBe(true);
    });

    it('a write whose copy into place was given up on before it answered keeps a marked row: the purge is not done while that copy may still land, and then takes the row and whatever landed', async () => {
      const brick = await idleBrick();
      bucket.store.put = async () => {
        // The purge's marker is there, and the request is given up on: it is not known whether it will still finish at the bucket
        await prisma.brickPurge.create({ data: { botId: brick.botId, machinePending: false, copyPending: true } });
        throw new CopyOutcomeUnknown();
      };
      await expect(storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>)).rejects.toThrow('no answer in time');
      const row = await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } });
      expect(row.state).toBe('failed');
      // The copy lands at the bucket later, after the purge saw an empty prefix
      await deleteAllArchives(brick.botId, new Date());
      expect(bucket.objects.size).toBe(0);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(1);
      bucket.objects.set(row.objectKey, Buffer.from('late'));
      // The clean-up sweep leaves it too, and a try soon after still finds the row
      await pruneArchives(brick.botId, null, new Date());
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(1);
      // Long after (more than the hold), the row is taken with the object that landed meanwhile
      await deleteAllArchives(brick.botId, new Date(Date.now() + 5 * 3_600_000));
      expect(bucket.objects.size).toBe(0);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
    });

    it('a copy that lands after its row was taken past the hold is found by listing: the purge is not done while it is young, and the sweep deletes it once no write can be running', async () => {
      const brick = await idleBrick();
      bucket.store.put = async () => {
        await prisma.brickPurge.create({ data: { botId: brick.botId, machinePending: false, copyPending: true } });
        throw new CopyOutcomeUnknown();
      };
      await expect(storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>)).rejects.toThrow('no answer in time');
      const row = await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } });
      // Past the hold the row is taken, and the bucket has nothing yet
      const past = new Date(Date.now() + 5 * 3_600_000);
      await deleteAllArchives(brick.botId, past);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(await removeBrickObjects(brick.botId, past)).toBe(0);
      // The copy finishes at the bucket after that: an object with no row
      bucket.objects.set(row.objectKey, Buffer.from('late'));
      bucket.written.set(row.objectKey, past);
      // Young: it may be a write still running, so it is left and the purge is not done
      expect(await removeBrickObjects(brick.botId, new Date(past.getTime() + 5 * 60_000))).toBe(1);
      expect(await removeStrayCopies(new Date(past.getTime() + 5 * 60_000))).toBe(0);
      expect(bucket.objects.size).toBe(1);
      // Once no write can be running it is deleted, by the purge or by the sweep
      expect(await removeStrayCopies(new Date(past.getTime() + 2 * 3_600_000))).toBe(1);
      expect(bucket.objects.size).toBe(0);
    });

    it('a copy that lands after the purge is done is reached by the sweep, however many objects the bucket holds before it', async () => {
      const brick = await idleBrick();
      bucket.store.put = async () => {
        await prisma.brickPurge.create({ data: { botId: brick.botId, provider: 'fake', providerRef: null, machinePending: false, copyPending: true } });
        throw new CopyOutcomeUnknown();
      };
      await expect(storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>)).rejects.toThrow('no answer in time');
      const row = await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } });
      // Past the hold the purge finds nothing: it is done
      const past = new Date(Date.now() + 5 * 3_600_000);
      const outcome = await finishOutside(brick.botId, past);
      expect(outcome).toMatchObject({ done: true });
      expect(bucket.objects.size).toBe(0);
      // Then the copy lands, behind more objects than one pass of the sweep looks at
      for (const name of ['a', 'b', 'c', 'd', 'e']) bucket.objects.set(`computer-cold/0-${name}/other.txt`, Buffer.from(name));
      bucket.objects.set(row.objectKey, Buffer.from('late'));
      bucket.written.set(row.objectKey, past);
      const later = new Date(past.getTime() + 2 * 3_600_000);
      setStrayPassForTests(2);
      try {
        let passes = 0;
        while (bucket.objects.has(row.objectKey) && passes < 6) {
          await removeStrayCopies(later);
          passes++;
        }
        expect(bucket.objects.has(row.objectKey)).toBe(false);
        expect(passes).toBeGreaterThan(1);
      } finally {
        setStrayPassForTests(20_000);
        await prisma.appSetting.deleteMany({ where: { key: STRAY_CURSOR_KEY } });
      }
    });

    it('the sweep writes down how far it has looked, so a restart goes on from there; it moves the mark only once the page is dealt with', async () => {
      for (const name of ['a', 'b', 'c', 'd', 'e']) bucket.objects.set(`computer-cold/0-${name}/other.txt`, Buffer.from(name));
      const lastSeen = async () => ((await prisma.appSetting.findUnique({ where: { key: STRAY_CURSOR_KEY } }))?.value as { after: string | null } | null)?.after;
      // Where each pass began, as the bucket was asked
      const asked: Array<string | undefined> = [];
      const real = bucket.store.list;
      setArchiveStoreForTests({ ...bucket.store, list: async (prefix, max, startAfter) => { asked.push(startAfter); return real(prefix, max, startAfter); } });
      setStrayPassForTests(2);
      try {
        await removeStrayCopies(NOW);
        expect(await lastSeen()).toBe('computer-cold/0-b/other.txt');
        // Nothing of the first pass is kept in memory: the next one begins where the database says
        await removeStrayCopies(NOW);
        expect(asked).toEqual([undefined, 'computer-cold/0-b/other.txt']);
        expect(await lastSeen()).toBe('computer-cold/0-d/other.txt');
        // A pass whose page could not be dealt with (an object that has to go cannot be deleted) leaves the mark where it was
        bucket.objects.set('computer-cold/0-e/9.' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + '.ubc', Buffer.from('stray'));
        bucket.written.set('computer-cold/0-e/9.' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + '.ubc', new Date(NOW.getTime() - 2 * 3_600_000));
        setArchiveStoreForTests({ ...bucket.store, remove: async () => { throw new Error('the bucket is down'); } });
        await expect(removeStrayCopies(NOW)).rejects.toThrow('down');
        expect(await lastSeen()).toBe('computer-cold/0-d/other.txt');
        // Then it goes on, reaches the end of the bucket and the mark goes back to the top
        setArchiveStoreForTests(bucket.store);
        expect(await removeStrayCopies(NOW)).toBe(1);
        expect(await lastSeen()).toBe('computer-cold/0-e/other.txt');
        await removeStrayCopies(NOW);
        expect(await lastSeen()).toBeNull();
      } finally {
        setStrayPassForTests(20_000);
        setArchiveStoreForTests(bucket.store);
        await prisma.appSetting.deleteMany({ where: { key: STRAY_CURSOR_KEY } });
      }
    });

    it('the marker of a copy whose outcome is not known is tried again; if it cannot be written the row stays and the object is still found by listing', async () => {
      const brick = await idleBrick();
      bucket.store.put = async () => {
        throw new CopyOutcomeUnknown();
      };
      const body = () => Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>;
      // Two failed tries, the third writes it
      const flaky = jest.spyOn(prisma.computerArchive, 'updateMany').mockRejectedValueOnce(new Error('the database blinked') as never).mockRejectedValueOnce(new Error('the database blinked') as never);
      try {
        await expect(storeArchive(brick.botId, body())).rejects.toThrow('no answer in time');
      } finally {
        flaky.mockRestore();
      }
      expect((await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } })).state).toBe('failed');
      await prisma.computerArchive.deleteMany({ where: { botId: brick.botId } });
      // Never written: the row is left as it was, and is taken as abandoned after the time a write can last, with whatever landed
      const down = jest.spyOn(prisma.computerArchive, 'updateMany').mockRejectedValue(new Error('the database is down') as never);
      try {
        await expect(storeArchive(brick.botId, body())).rejects.toThrow('no answer in time');
      } finally {
        down.mockRestore();
      }
      const row = await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } });
      expect(row.state).toBe('staging');
      bucket.objects.set(row.objectKey, Buffer.from('late'));
      await deleteAllArchives(brick.botId, new Date(Date.now() + 2 * 3_600_000));
      expect(bucket.objects.size).toBe(0);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
    });

    it('a write whose row cannot be written gives the stream up too', async () => {
      const brick = await idleBrick();
      let cancelled = false;
      const response = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined), cancel: () => { cancelled = true; } });
      const spy = jest.spyOn(prisma.computerArchive, 'create').mockRejectedValueOnce(new Error('the database did not answer') as never);
      try {
        await expect(storeArchive(brick.botId, response)).rejects.toThrow('did not answer');
      } finally {
        spy.mockRestore();
      }
      expect(cancelled).toBe(true);
    });

    it('a copy that lands after the purge read its rows is deleted by the copy itself, and an object that cannot be deleted keeps a row so the clean-up finds it', async () => {
      const brick = await idleBrick();
      const put = bucket.store.put.bind(bucket.store);
      bucket.store.put = async (finalKey, stagingKey, stream) => {
        // The purge runs while the upload is out: marker first, then it deletes every row it can take. The copy's own row (still being written, its object
        // not landed yet) is the record that a writer is out: it is not taken, so the purge cannot call itself done
        await prisma.brickPurge.create({ data: { botId: brick.botId, machinePending: false, copyPending: true } });
        await deleteAllArchives(brick.botId, new Date());
        expect(await prisma.computerArchive.count({ where: { botId: brick.botId, state: 'staging' } })).toBe(1);
        // The upload lands after the purge, and the bucket stops answering before the copy can take it back out
        const sealed = await put(finalKey, stagingKey, stream);
        failRemoval = true;
        return sealed;
      };
      const remove = bucket.store.remove.bind(bucket.store);
      let failRemoval = false;
      bucket.store.remove = async (keys) => {
        if (failRemoval) throw new Error('the bucket did not answer');
        return remove(keys);
      };
      await expect(storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>)).rejects.toThrow();
      // The object is still there, and so is a row that names it
      expect(bucket.objects.size).toBe(1);
      const left = await prisma.computerArchive.findMany({ where: { botId: brick.botId } });
      expect(left).toHaveLength(1);
      expect(left[0].state).toBe('superseded');
      // The next try (the Brick has no computer record, so the clean-up takes it) deletes the object and the row
      failRemoval = false;
      await deleteAllArchives(brick.botId);
      expect(bucket.objects.size).toBe(0);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
    });

    it('the purge deletes only the rows whose objects it deleted: a copy that began meanwhile keeps its row', async () => {
      const brick = await idleBrick();
      const first = await storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('one')])) as ReadableStream<Uint8Array>);
      const remove = bucket.store.remove.bind(bucket.store);
      bucket.store.remove = async (keys) => {
        await remove(keys);
        // A writer's row appears while the objects are being deleted
        await prisma.computerArchive.create({ data: { botId: brick.botId, generation: 99, state: 'staging', objectKey: `computer-cold/${brick.botId}/99.late.ubc` } });
      };
      await deleteAllArchives(brick.botId);
      const rowsLeft = await prisma.computerArchive.findMany({ where: { botId: brick.botId } });
      expect(rowsLeft.map((row) => row.generation)).toEqual([99]);
      expect(first.generation).toBe(1);
    });

    it('a write still uploading when the purge runs keeps its row, publishes nothing, and its row is taken by the next try', async () => {
      const brick = await idleBrick();
      const put = bucket.store.put.bind(bucket.store);
      bucket.store.put = async (finalKey, stagingKey, stream, mayPublish) => {
        // The purge runs while the upload is still out (marker first): the writer's row stays, and the purge is not done while it does
        await prisma.brickPurge.create({ data: { botId: brick.botId, machinePending: false, copyPending: true } });
        await deleteAllArchives(brick.botId, new Date());
        expect(await prisma.computerArchive.count({ where: { botId: brick.botId, state: 'staging' } })).toBe(1);
        return put(finalKey, stagingKey, stream, mayPublish);
      };
      await expect(storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>)).rejects.toThrow();
      expect(bucket.objects.size).toBe(0);
      // The writer gave up and said so in its row; the next try takes it
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId, state: 'failed' } })).toBe(1);
      await deleteAllArchives(brick.botId, new Date());
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
    });

    it('a writer whose upload lands after the purge found the bucket empty, and that can neither take its object back nor write down that it failed, leaves its row: the purge is not done, and a try after a write can last deletes the object', async () => {
      const brick = await idleBrick();
      const put = bucket.store.put.bind(bucket.store);
      const remove = bucket.store.remove.bind(bucket.store);
      let down = false;
      bucket.store.put = async (finalKey, stagingKey, stream) => {
        // The purge runs now (marker first): the writer's row is kept as a write that is out, and the prefix lists empty
        await prisma.brickPurge.create({ data: { botId: brick.botId, machinePending: false, copyPending: true } });
        await deleteAllArchives(brick.botId, new Date());
        expect(await removeBrickObjects(brick.botId, new Date())).toBe(0);
        // The upload lands after that, and then neither the bucket nor the database answers the writer
        const sealed = await put(finalKey, stagingKey, stream);
        down = true;
        return sealed;
      };
      bucket.store.remove = async (keys) => {
        if (down) throw new Error('the bucket did not answer');
        return remove(keys);
      };
      const spies = [jest.spyOn(prisma.computerArchive, 'update'), jest.spyOn(prisma.computerArchive, 'updateMany'), jest.spyOn(prisma.computerArchive, 'upsert')];
      for (const spy of spies) spy.mockImplementation((() => Promise.reject(new Error('the database did not answer'))) as never);
      try {
        await expect(storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>)).rejects.toThrow();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      // The object is in the bucket, and the writer's row is still there as it was: a purge that looked now would not be done
      expect(bucket.objects.size).toBe(1);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(1);
      // A try while the write could still be out leaves it; one after a write can last takes the row and the object
      down = false;
      await deleteAllArchives(brick.botId, new Date());
      expect(bucket.objects.size).toBe(1);
      await deleteAllArchives(brick.botId, new Date(Date.now() + 61 * 60_000));
      expect(bucket.objects.size).toBe(0);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
    });

    it('a write that runs past the limit is stopped: its stream is cancelled, nothing is published or left, and a write that finished its upload but waited past the limit is not published either', async () => {
      const brick = await idleBrick();
      setWriteLimitForTests(60);
      try {
        // An upload that never ends: it is stopped at the limit, so it cannot land an object after its row could have been taken
        const endless = new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new Uint8Array([1, 2, 3])),
          pull: () => new Promise<void>(() => undefined),
        });
        await expect(storeArchive(brick.botId, endless)).rejects.toThrow('longer than a write may');
        expect(bucket.objects.size).toBe(0);
        expect(await prisma.computerArchive.count({ where: { botId: brick.botId, state: 'staging' } })).toBe(0);
        // One that finished its upload and then waited (a slow bucket) past the limit is not allowed to publish
        const put = bucket.store.put.bind(bucket.store);
        bucket.store.put = async (finalKey, stagingKey, stream, mayPublish) => {
          const sealed = await put(finalKey, stagingKey, stream, async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return mayPublish ? mayPublish() : true;
          });
          return sealed;
        };
        await expect(storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>)).rejects.toThrow();
        expect(bucket.objects.size).toBe(0);
        expect(await prisma.computerArchive.count({ where: { botId: brick.botId, state: 'stored' } })).toBe(0);
      } finally {
        setWriteLimitForTests(null);
      }
    });

    it('the purge keeps the row a writer changed while the purge was deleting: a copy that landed after its objects were deleted and could not be taken back out is still found by the next try', async () => {
      const brick = await idleBrick();
      // A writer's row that is old (a write cannot last this long), so the purge takes it
      const row = await prisma.computerArchive.create({ data: { botId: brick.botId, generation: 1, state: 'staging', objectKey: `computer-cold/${brick.botId}/1.writer.ubc`, createdAt: new Date(Date.now() - 3 * 3_600_000) } });
      const remove = bucket.store.remove.bind(bucket.store);
      bucket.store.remove = async (keys) => {
        await remove(keys);
        // The writer finishes its upload after the objects were deleted, cannot take the object out again, and says so in its row
        bucket.objects.set(row.objectKey, Buffer.from('late'));
        await prisma.computerArchive.update({ where: { id: row.id }, data: { state: 'superseded' } });
      };
      await deleteAllArchives(brick.botId);
      // The row is still there (the purge had read it as staging), and so is the object it names
      expect(await prisma.computerArchive.findUnique({ where: { id: row.id } })).toMatchObject({ state: 'superseded' });
      expect(bucket.objects.has(row.objectKey)).toBe(true);
      // The next try deletes the object and then the row
      bucket.store.remove = remove;
      await deleteAllArchives(brick.botId);
      expect(bucket.objects.has(row.objectKey)).toBe(false);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
    });

    it('a clean-up takes a copy for deletion before it deletes its objects: a pack-away that proves the copy meanwhile cannot keep a copy whose objects are being removed', async () => {
      const brick = await idleBrick();
      const row = await prisma.computerArchive.create({ data: { botId: brick.botId, generation: 1, state: 'stored', objectKey: `computer-cold/${brick.botId}/1.old.ubc`, createdAt: new Date(NOW.getTime() - 3 * 3_600_000) } });
      bucket.objects.set(row.objectKey, Buffer.from('old'));
      const remove = bucket.store.remove.bind(bucket.store);
      let proved: unknown = 'not asked';
      bucket.store.remove = async (keys) => {
        // The pack-away that took the stale claim over proves this very copy while its objects are being deleted
        proved = await markVerified(row.id, 1000, NOW);
        await remove(keys);
      };
      await pruneArchives(brick.botId, null, NOW);
      bucket.store.remove = remove;
      expect(proved).toBeNull();
      // No copy is left that says it can be restored from while its object is gone
      const verified = await prisma.computerArchive.findMany({ where: { botId: brick.botId, state: 'verified' } });
      expect(verified.filter((one) => !bucket.objects.has(one.objectKey))).toEqual([]);
      expect(bucket.objects.has(row.objectKey)).toBe(false);
      expect(await prisma.computerArchive.count({ where: { id: row.id } })).toBe(0);
    });

    it('a write whose copy a clean-up took for deletion after the write was allowed to publish does not bring it back as stored', async () => {
      const brick = await idleBrick();
      const put = bucket.store.put.bind(bucket.store);
      const remove = bucket.store.remove.bind(bucket.store);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let pruning: Promise<number> = Promise.resolve(0);
      let heldOnce = false;
      bucket.store.put = async (finalKey, stagingKey, stream, mayPublish) => {
        // The write was allowed to publish and has published; then a clean-up (the row looks abandoned) takes the copy for deletion and is slow to delete
        const sealed = await put(finalKey, stagingKey, stream, mayPublish);
        await prisma.computerArchive.updateMany({ where: { botId: brick.botId }, data: { createdAt: new Date(NOW.getTime() - 3 * 3_600_000) } });
        bucket.store.remove = async (keys) => {
          if (!heldOnce) {
            heldOnce = true;
            await held;
          }
          return remove(keys);
        };
        pruning = pruneArchives(brick.botId, null, NOW);
        for (let tries = 0; tries < 100 && (await prisma.computerArchive.count({ where: { botId: brick.botId, state: 'superseded' } })) === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
        return sealed;
      };
      const outcome = await storeArchive(brick.botId, Readable.toWeb(Readable.from([Buffer.from('home')])) as ReadableStream<Uint8Array>).then(() => 'stored', () => 'refused');
      release();
      await pruning;
      bucket.store.put = put;
      bucket.store.remove = remove;
      expect(outcome).toBe('refused');
      // No copy stands as restorable while its object is gone
      const rows = await prisma.computerArchive.findMany({ where: { botId: brick.botId } });
      expect(rows.filter((row) => ['stored', 'verified'].includes(row.state) && !bucket.objects.has(row.objectKey))).toEqual([]);
    });

    it('a run that was open when its server stopped is closed at the longest a run may last, and its time is booked once', async () => {
      const brick = await idleBrick();
      const started = new Date(NOW.getTime() - 9 * 3_600_000);
      const run = await prisma.computerColdRun.create({ data: { kind: 'pack', botId: brick.botId, machineRef: brick.ref, scratch: false, startedAt: started } });
      await coldStep(provider, NOW);
      const closed = await prisma.computerColdRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(closed.endedAt?.getTime()).toBe(started.getTime() + COLD_RUN_MAX_MS);
      expect(closed).toMatchObject({ outcome: 'failed', seconds: COLD_RUN_MAX_MS / 1000 });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:cold:${run.id}:time` } })).toBe(1);
      // Asked again it is the same line
      await coldStep(provider, NOW);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:cold:${run.id}:time` } })).toBe(1);
    });

    it('writes the line of a run that ended but never reached the books (the write failed), once, and leaves one that ended a moment ago to write its own', async () => {
      const brick = await idleBrick();
      const ended = new Date(NOW.getTime() - 5 * 60_000);
      const lost = await prisma.computerColdRun.create({ data: { kind: 'pack', botId: brick.botId, machineRef: brick.ref, scratch: false, startedAt: new Date(ended.getTime() - 120_000), endedAt: ended, seconds: 120, outcome: 'ok' } });
      const justNow = await prisma.computerColdRun.create({ data: { kind: 'pack', botId: brick.botId, machineRef: brick.ref, scratch: false, startedAt: new Date(NOW.getTime() - 40_000), endedAt: new Date(NOW.getTime() - 10_000), seconds: 30, outcome: 'ok' } });
      await coldStep(provider, NOW);
      expect(await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:cold:${lost.id}:time` } })).toMatchObject({ quantity: BigInt(120), botId: brick.botId });
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:cold:${justNow.id}:time` } })).toBe(0);
      // Asked again it is the same line
      await coldStep(provider, NOW);
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:cold:${lost.id}:time` } })).toBe(1);
    });

    it('keeps the computer when it holds more outside its home folder than can be carried, and says why only by not packing it', async () => {
      const brick = await idleBrick();
      provider.inventory = { ...provider.inventory, blocked: 'too_big_outside' };
      expect(await packAway(brick.botId, provider, NOW)).toBe('failed');
      expect(names()).not.toContain(`streamFiles:${brick.ref}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'stopped', packFailures: 1 });
      expect((await coldStatus()).failing).toBe(1);
    });

    it('a file name that is not valid UTF-8 would be refused by the database; the computer reports it as blocked first, so the pack-away keeps the computer and no copy row is written', async () => {
      // The premise: a lone surrogate (what such a name reads as) cannot be kept in a JSON column
      const odd = { outside: { files: [['f', '/opt/x-\udcff', 1, 0o644, 'a'.repeat(64)]], packages: [] } };
      const brick = await idleBrick();
      await expect(storeArchive(brick.botId, new Response('x').body as ReadableStream<Uint8Array>, { manifest: odd })).rejects.toBeDefined();
      // What Orbit does with such a list: it is not one (readOutsideManifest), and the provider turns that into a blocked computer
      expect(readOutsideManifest(odd.outside)).toBeNull();
      provider.inventory = { ...provider.inventory, blocked: 'outside_name_not_utf8' };
      expect(await packAway(brick.botId, provider, NOW)).toBe('failed');
      expect(names()).not.toContain(`streamFiles:${brick.ref}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'stopped', packFailures: 1 });
    });

    it('keeps the computer when the copy cannot be read or stored (a stream that fails)', async () => {
      const brick = await idleBrick();
      provider.coldFail.stream = true;
      expect(await packAway(brick.botId, provider, NOW)).toBe('failed');
      expect((await row(brick.botId)).providerRef).toBe(brick.ref);
      expect(names()).not.toContain(`remove:${brick.ref}`);
    });

    it('a job that arrives during the proof keeps the computer: the copy stays proved, nothing is deleted', async () => {
      const brick = await idleBrick();
      const original = provider.restoreInto.bind(provider);
      provider.restoreInto = async (ref, source) => {
        await prisma.computerJob.create({ data: { botId: brick.botId, personId: brick.personId, title: 'arrived', status: 'running', startedAt: NOW, stretchStarted: NOW } });
        return original(ref, source);
      };
      expect(await packAway(brick.botId, provider, NOW)).toBe('failed');
      expect(names()).not.toContain(`remove:${brick.ref}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'resting', providerRef: brick.ref, packStage: null, packFailures: 0 });
    });

    it('a Brick deleted during the proof (its Undo days still run) is packed away all the same, after the copy is proved', async () => {
      const brick = await idleBrick();
      const original = provider.restoreInto.bind(provider);
      provider.restoreInto = async (ref, source) => {
        await prisma.bot.update({ where: { id: brick.botId }, data: { deletedAt: new Date(), goneAt: new Date(Date.now() + 7 * DAY), enabled: false } });
        return original(ref, source);
      };
      expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
      expect(names()).toContain(`remove:${brick.ref}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null });
      expect((await verifiedArchives(brick.botId)).length).toBe(1);
    });

    it('a Brick whose Undo days are over is not packed: the final purge needs no copy, so nothing is stored and nothing is made', async () => {
      const brick = await idleBrick();
      await prisma.bot.update({ where: { id: brick.botId }, data: { deletedAt: new Date(Date.now() - 8 * DAY), goneAt: new Date(Date.now() - DAY), enabled: false } });
      expect(await packAway(brick.botId, provider, NOW)).toBe('failed');
      expect(names().filter((call) => ['prepack', 'streamFiles', 'makeScratch'].includes(call.split(':')[0]))).toEqual([]);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(names()).not.toContain(`remove:${brick.ref}`);
    });

    it('is not cold until the provider says the computer is gone: still listed means it stays, and the sweep finishes it', async () => {
      const brick = await idleBrick();
      provider.stillThere = 1;
      expect(await packAway(brick.botId, provider, NOW)).toBe('busy');
      expect(await row(brick.botId)).toMatchObject({ machine: 'packing', packStage: 'removing', providerRef: brick.ref });
      expect(await computerView(brick.botId, brick.personId, NOW)).toMatchObject({ machine: 'packing' });
      // A server that stopped here: the claim is old, the sweep removes again and confirms
      const later = new Date(Date.now() + STUCK_MS + 60_000);
      const result = await coldStep(provider, later);
      expect(result.resumed).toBe(1);
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null, packStage: null });
    });

    it('picks up a pack-away a stopped server left, from the step it reached, without storing the copy twice', async () => {
      const brick = await idleBrick();
      // The copy was stored and proved; the server stopped before the removal
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'packing', packStage: 'claimed', packPrevious: 'resting', packClaimedAt: new Date(NOW.getTime() - 3 * 60 * 60_000) } });
      const result = await coldStep(provider, NOW);
      expect(result.resumed).toBe(1);
      expect((await row(brick.botId)).machine).toBe('cold');
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(1);
    });

    it('keeps the newest two proved copies and deletes the rest, from the bucket too', async () => {
      const brick = await idleBrick();
      for (let i = 0; i < 3; i++) {
        const stored = await storeArchive(brick.botId, new Response(`copy ${i}`).body as ReadableStream<Uint8Array>);
        await markVerified(stored.id, 100);
      }
      const bad = await storeArchive(brick.botId, new Response('bad').body as ReadableStream<Uint8Array>);
      await prisma.computerArchive.update({ where: { id: bad.id }, data: { state: 'failed' } });
      expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
      const kept = await verifiedArchives(brick.botId);
      // Generation 4 failed its check and is never kept: the newest two that were proved are 5 and 3
      expect(kept.map((copy) => copy.generation)).toEqual([5, 3]);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(2);
      expect(bucket.objects.size).toBe(2);
    });

    it('does nothing for a provider that keeps its computers where they are, and nothing while a wind-down is on', async () => {
      const brick = await idleBrick();
      expect((await coldStep(provider, NOW, true)).packed).toBe(0);
      expect((await row(brick.botId)).machine).toBe('resting');
      const bare = { ...provider, prepack: undefined } as unknown as FakeComputerProvider;
      expect(await packAway(brick.botId, bare, NOW)).toBe('skipped');
    });

    it('the sweep runs it, and the daily check of the books counts a pack-away’s awake time so it is not “unbooked”', async () => {
      const brick = await idleBrick();
      await sweepComputers(NOW);
      expect((await row(brick.botId)).machine).toBe('cold');
      expect(await prisma.computerColdRun.count({ where: { botId: brick.botId, scratch: false, outcome: 'ok' } })).toBe(1);
    });
  });

  describe('the download a restore fetches', () => {
    it('gives the decrypted copy to the computer it was made for, and only while the key lasts', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const [copy] = await verifiedArchives(brick.botId);
      const ok = await fetchCopy(copy.id, bearer(copy.id, 'scratch-9'));
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-length')).toBe(String(copy.bytes));
      expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('the home folder as a tar.gz');
      // No key, a key for another copy, a key that ran out, a garbled key
      expect((await fetchCopy(copy.id, {})).status).toBe(401);
      expect((await fetchCopy(copy.id, bearer('another-copy', 'scratch-9'))).status).toBe(401);
      expect((await fetchCopy(copy.id, { authorization: `Bearer ${mintDownloadToken(copy.id, 'scratch-9', Date.now() - 2 * 60 * 60_000)}` })).status).toBe(401);
      expect((await fetchCopy(copy.id, { authorization: 'Bearer nonsense' })).status).toBe(401);
    });

    it('Opus on #1025 (universe-cold): the list prepack printed is kept on the copy’s row, handed to the proof on the throwaway computer, and handed back when the computer comes back; a copy with no list is handed null', async () => {
      const brick = await idleBrick();
      const outside = { files: [['f', '/etc/app.conf', 4, 0o640, 'c'.repeat(64)], ['l', '/opt/tool/latest', 0, 0, 'run.sh']] as Array<['f' | 'l', string, number, number, string]>, packages: ['ffmpeg'] };
      provider.inventory = { ...provider.inventory, outsideFiles: 2, packages: ['ffmpeg'], outside };
      expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
      const [copy] = await verifiedArchives(brick.botId);
      // On the row (beside the counts, which no longer carry it), and handed to the proof
      expect(copy.manifest).toMatchObject({ outside, inventory: { outsideFiles: 2, packages: ['ffmpeg'] } });
      expect((copy.manifest as { inventory: Record<string, unknown> }).inventory).not.toHaveProperty('outside');
      expect(provider.restored[0].source.outside).toEqual(outside);
      // And back again when a job needs the computer
      provider.restored.length = 0;
      expect((await startJob({ botId: brick.botId, personId: brick.personId, title: 'Wake up' }, NOW)).ok).toBe(true);
      expect(provider.restored[0].source.outside).toEqual(outside);
    });

    it('Opus on #1025 (universe-cold): a copy with no list (made before the list was kept) is handed null on its proof and on its return', async () => {
      const brick = await idleBrick();
      expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
      const [copy] = await verifiedArchives(brick.botId);
      expect((copy.manifest as { outside: unknown }).outside).toBeNull();
      // An older row with no `outside` key at all reads the same
      await prisma.computerArchive.update({ where: { id: copy.id }, data: { manifest: { inventory: { homeFiles: 1 } } } });
      expect(provider.restored[0].source.outside).toBeNull();
      provider.restored.length = 0;
      expect((await startJob({ botId: brick.botId, personId: brick.personId, title: 'Wake up' }, NOW)).ok).toBe(true);
      expect(provider.restored[0].source.outside).toBeNull();
    });

    it('does not give a copy that failed its check or one that is not there', async () => {
      const brick = await idleBrick();
      const stored = await storeArchive(brick.botId, new Response('x').body as ReadableStream<Uint8Array>);
      await prisma.computerArchive.update({ where: { id: stored.id }, data: { state: 'failed' } });
      expect((await fetchCopy(stored.id, bearer(stored.id, 'm1'))).status).toBe(404);
      expect((await fetchCopy('missing', bearer('missing', 'm1'))).status).toBe(404);
    });
  });

  describe('coming back', () => {
    it('makes a computer again and restores the newest proved copy when a job needs it, and measures how long it took', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      provider.calls.length = 0;
      provider.restored.length = 0;
      const [copy] = await verifiedArchives(brick.botId);
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Wake up' }, NOW);
      expect(started.ok).toBe(true);
      expect(names().filter((call) => ['create', 'restoreInto', 'wake'].includes(call.split(':')[0]))).toEqual([`create:${brick.botId}`, `restoreInto:fake-${brick.botId}`, `wake:fake-${brick.botId}`]);
      expect(provider.restored[0].source.sha256).toBe(copy.sha256);
      expect(await row(brick.botId)).toMatchObject({ machine: 'working', providerRef: `fake-${brick.botId}`, olderCopyUsed: false, restoredFrom: null, packStage: null });
      const back = await row(brick.botId);
      expect(back.returnMs).toBeGreaterThanOrEqual(0);
      expect(back.returnedAt).not.toBeNull();
      // The newest copy is no event to tell the person about
      expect(started.ok && started.restoredFrom).toBeNull();
      expect(await computerView(brick.botId, brick.personId, NOW)).toMatchObject({ machine: 'working', olderCopyUsed: false, packedAt: null });
    });

    it('falls back to the older copy on a fresh computer when the newest does not restore, and tells the person which day', async () => {
      const brick = await idleBrick();
      const older = await storeArchive(brick.botId, new Response('older').body as ReadableStream<Uint8Array>);
      await markVerified(older.id, 5);
      const newer = await storeArchive(brick.botId, new Response('newer').body as ReadableStream<Uint8Array>);
      await markVerified(newer.id, 5);
      await prisma.computerArchive.update({ where: { id: older.id }, data: { createdAt: new Date('2026-10-30T10:00:00Z') } });
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'cold', providerRef: null } });
      provider.restoreResults = [{ ok: false, reason: 'sha_mismatch', ms: 1 }];
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Wake up' }, NOW);
      expect(started.ok).toBe(true);
      // The half-restored computer is removed, never used, and the older copy goes on a fresh one
      expect(names().filter((call) => call.startsWith('remove:') || call.startsWith('confirmRemoved:') || call.startsWith('create:'))).toEqual([`create:${brick.botId}`, `remove:fake-${brick.botId}`, `confirmRemoved:fake-${brick.botId}`, `create:${brick.botId}`]);
      expect(provider.restored.map((entry) => entry.source.sha256)).toEqual([newer.sha256, older.sha256]);
      const back = await row(brick.botId);
      expect(back).toMatchObject({ machine: 'working', olderCopyUsed: true });
      expect(back.restoredFrom?.toISOString()).toBe('2026-10-30T10:00:00.000Z');
      expect(started.ok && started.restoredFrom?.toISOString()).toBe('2026-10-30T10:00:00.000Z');
      expect(await computerView(brick.botId, brick.personId, NOW)).toMatchObject({ olderCopyUsed: true });
    });

    it('a computer that cannot be made ready for the newest copy (restoreInto THROWS) ends the return: the older copy is not tried, the computer is removed, and the next job tries the newest copy again', async () => {
      const brick = await idleBrick();
      const older = await storeArchive(brick.botId, new Response('older').body as ReadableStream<Uint8Array>);
      await markVerified(older.id, 5);
      const newer = await storeArchive(brick.botId, new Response('newer').body as ReadableStream<Uint8Array>);
      await markVerified(newer.id, 5);
      await prisma.computerArchive.update({ where: { id: older.id }, data: { createdAt: new Date('2026-10-30T10:00:00Z') } });
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'cold', providerRef: null } });
      const original = provider.restoreInto.bind(provider);
      provider.restoreInto = async () => {
        throw new Error('The computer could not take the current script');
      };
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Wake up' }, NOW);
      expect(started).toMatchObject({ ok: false, reason: 'broken_start' });
      // One computer was made and removed; the older copy never went on a computer
      expect(names().filter((call) => call.startsWith('remove:') || call.startsWith('confirmRemoved:') || call.startsWith('create:'))).toEqual([`create:${brick.botId}`, `remove:fake-${brick.botId}`, `confirmRemoved:fake-${brick.botId}`]);
      expect(provider.restored).toEqual([]);
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null, packStage: null, olderCopyUsed: false });
      // Later the NEWEST copy is the one tried again
      provider.restoreInto = original;
      provider.restoreResults = [];
      const again = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Try again' }, new Date(NOW.getTime() + 2 * 60 * 60_000));
      expect(again).toMatchObject({ ok: true });
      expect(provider.restored.map((entry) => entry.source.sha256)).toEqual([newer.sha256]);
    });

    it('leaves the Brick cold, with no computer left billing, when no copy restores', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      // One proved copy only, and it does not restore
      provider.restoreResults = [{ ok: false, reason: 'a', ms: 1 }];
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Wake up' }, NOW);
      expect(started).toMatchObject({ ok: false, reason: 'broken_start' });
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null, packStage: null });
      // Every computer that was made was removed again
      expect(names().filter((call) => call.startsWith('create:'))).toHaveLength(1);
      expect(names().filter((call) => call === `remove:fake-${brick.botId}`)).toHaveLength(2);
      expect((await verifiedArchives(brick.botId)).length).toBe(1);
      // The next job tries again, and works
      const again = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Try again' }, NOW);
      expect(again).toMatchObject({ ok: true });
      expect((await row(brick.botId)).machine).toBe('working');
    });

    it('a Brick with no proved copy is never made a blank computer: the start fails and it stays cold', async () => {
      const brick = await idleBrick();
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'cold', providerRef: null } });
      expect(await startJob({ botId: brick.botId, personId: brick.personId, title: 'Wake up' }, NOW)).toMatchObject({ ok: false, reason: 'broken_start' });
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null });
      expect(names().filter((call) => call.startsWith('create:'))).toEqual([]);
    });

    it('puts a job that arrives while the computer is being packed away in line, with nothing held, and starts it from cold storage after', async () => {
      const brick = await idleBrick();
      provider.stillThere = 1;
      expect(await packAway(brick.botId, provider, NOW)).toBe('busy');
      const waiting = await startJob({ botId: brick.botId, personId: brick.personId, title: 'During' }, NOW);
      expect(waiting.ok && waiting.job.status).toBe('queued');
      expect((await row(brick.botId)).machine).toBe('packing');
      expect(await prisma.meterReservation.count({ where: { state: 'held' } })).toBe(0);
      // The pack-away is finished; the sweep then brings the computer back for the job in line
      await coldStep(provider, new Date(Date.now() + STUCK_MS + 60_000));
      expect((await row(brick.botId)).machine).toBe('cold');
      const swept = await sweepComputers(new Date(Date.now() + STUCK_MS + 120_000));
      expect(swept.started).toBe(1);
      expect((await row(brick.botId)).machine).toBe('working');
    });

    it('after a newer plain copy exists, the cold copies are dropped (they say nothing newer and cost bucket space)', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Wake up' }, NOW);
      expect(started.ok).toBe(true);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(1);
      if (started.ok) {
        const { finishJob } = await import('@/lib/computer');
        await finishJob(started.job.id, 'done', NOW);
      }
      // The rest saves a plain copy of the working computer, and that replaces the cold ones
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { updatedAt: new Date(NOW.getTime() - 10 * 60_000) } });
      await sweepComputers(new Date(NOW.getTime() + 10 * 60_000));
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(0);
    });

    it('says it is alive while a copy is being restored for a return, so a slow return is not taken for a stopped server', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const before = heartbeat.ms;
      heartbeat.ms = 25;
      try {
        const original = provider.restoreInto.bind(provider);
        let claimedAtStart: Date | null = null;
        let claimedAtEnd: Date | null = null;
        provider.restoreInto = async (ref, source) => {
          claimedAtStart = (await row(brick.botId)).packClaimedAt;
          await new Promise((resolve) => setTimeout(resolve, 200));
          claimedAtEnd = (await row(brick.botId)).packClaimedAt;
          return original(ref, source);
        };
        await bringBackFromCold(brick.botId, provider, NOW);
        expect(claimedAtStart).not.toBeNull();
        expect((claimedAtEnd as unknown as Date).getTime()).toBeGreaterThan((claimedAtStart as unknown as Date).getTime());
      } finally {
        heartbeat.ms = before;
      }
    });

    it('says it is alive while the provider makes the computer for a return and while a pack-away’s computer is being removed', async () => {
      const brick = await idleBrick();
      const before = heartbeat.ms;
      heartbeat.ms = 25;
      try {
        // The removal at the end of a pack-away is slow
        const removeComputer = provider.remove.bind(provider);
        let removeStart: Date | null = null;
        let removeEnd: Date | null = null;
        provider.remove = async (ref) => {
          if (ref === brick.ref) {
            removeStart = (await row(brick.botId)).packClaimedAt;
            await new Promise((resolve) => setTimeout(resolve, 200));
            removeEnd = (await row(brick.botId)).packClaimedAt;
          }
          return removeComputer(ref);
        };
        expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
        expect(removeStart).not.toBeNull();
        expect((removeEnd as unknown as Date).getTime()).toBeGreaterThan((removeStart as unknown as Date).getTime());
        // Making the computer for the return is slow too
        const create = provider.create.bind(provider);
        let madeStart: Date | null = null;
        let madeEnd: Date | null = null;
        provider.create = async (botId) => {
          madeStart = (await row(brick.botId)).packClaimedAt;
          await new Promise((resolve) => setTimeout(resolve, 200));
          madeEnd = (await row(brick.botId)).packClaimedAt;
          return create(botId);
        };
        await bringBackFromCold(brick.botId, provider, NOW);
        expect(madeStart).not.toBeNull();
        expect((madeEnd as unknown as Date).getTime()).toBeGreaterThan((madeStart as unknown as Date).getTime());
      } finally {
        heartbeat.ms = before;
      }
    });

    it('keeps the disk room of a computer made for a return while the books would not take its disk, until the sweep has written it', async () => {
      const brick = await idleBrick();
      provider.disk = 4_000_000_000;
      await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 90_000, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
      expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
      const heldDisk = () => prisma.meterReservation.count({ where: { state: 'held', reservationKey: { startsWith: 'computer:diskroom:' } } });
      // A job brings it back, and the books refuse the line for the new computer's disk: the job is not failed for that, and the disk's room stays held
      (meter.recordMeterEvent as jest.Mock).mockImplementation(async (event: { kind: string }, ...rest: unknown[]) => {
        if (event.kind === 'stored_bytes') throw new Error('The books are down');
        return (actualRecord as (...args: unknown[]) => unknown)(event, ...rest);
      });
      try {
        const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Back' }, NOW);
        expect(started.ok && started.job.status).toBe('running');
        expect(await heldDisk()).toBe(1);
      } finally {
        (meter.recordMeterEvent as jest.Mock).mockImplementation(actualRecord);
      }
      // The books work again: the sweep writes the line first, then gives the room back
      await sweepComputers(new Date(NOW.getTime() + 21 * 60_000));
      expect(await prisma.meterEvent.count({ where: { botId: brick.botId, kind: 'stored_bytes' } })).toBeGreaterThanOrEqual(1);
      expect(await heldDisk()).toBe(0);
    });

    it('writes the line that says a packed-away computer’s disk is gone when the books refused it at the time, and only once', async () => {
      const brick = await idleBrick();
      provider.disk = 4_000_000_000;
      // The disk is in the books as kept storage
      const { recordKeptBytes } = await import('@/lib/computer-disk');
      expect(await recordKeptBytes({ botId: brick.botId, reason: 'made', machineBytes: 4_000_000_000, copyBytes: 0, now: new Date(NOW.getTime() - 60_000) })).toBe(true);
      (meter.recordMeterEvent as jest.Mock).mockImplementation(async (event: { kind: string }, ...rest: unknown[]) => {
        if (event.kind === 'stored_bytes') throw new Error('The books are down');
        return (actualRecord as (...args: unknown[]) => unknown)(event, ...rest);
      });
      try {
        // Packed and removed, but the line saying the disk is gone could not be written
        expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
        await coldStep(provider, NOW);
      } finally {
        (meter.recordMeterEvent as jest.Mock).mockImplementation(actualRecord);
      }
      const level = () => prisma.meterEvent.findMany({ where: { botId: brick.botId, kind: 'stored_bytes' }, orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }] });
      expect(await level()).toHaveLength(1);
      // The books work again: the next sweep writes the level, which is the copy only
      await coldStep(provider, new Date(NOW.getTime() + 60_000));
      const lines = await level();
      expect(lines).toHaveLength(2);
      expect(Number(lines[1].quantity)).toBe(Number((await prisma.computerArchive.findFirstOrThrow({ where: { botId: brick.botId } })).bytes));
      // Asked again it is not written twice
      await coldStep(provider, new Date(NOW.getTime() + 120_000));
      expect(await level()).toHaveLength(2);
    });

    it('a return that was taken over while it restored changes nothing: the Brick is not marked awake on a computer the other run removed', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const original = provider.restoreInto.bind(provider);
      provider.restoreInto = async (ref, source) => {
        const result = await original(ref, source);
        // The sweep took the return over (a new claim id), removed this computer and put the Brick back to cold, before this run finished
        await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'cold', packStage: null, providerRef: null, packClaimId: 'took-over' } });
        return result;
      };
      await expect(bringBackFromCold(brick.botId, provider, NOW)).rejects.toMatchObject({ why: 'busy' });
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null, packStage: null, packClaimId: 'took-over' });
    });

    it('a return that lost its claim while its computer was being made leaves that computer to the return that took over, which got the same machine from the provider', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const before = names().length;
      const create = provider.create.bind(provider);
      provider.create = async (botId) => {
        const machine = await create(botId);
        // A sweep took the stopped return over and a replacement came: the provider gave it this very machine and it has recorded it
        await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { packClaimId: 'replacement', providerRef: machine.ref } });
        return machine;
      };
      await expect(bringBackFromCold(brick.botId, provider, NOW)).rejects.toMatchObject({ why: 'busy' });
      expect(names().slice(before)).not.toContain(`remove:fake-${brick.botId}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'restoring', providerRef: `fake-${brick.botId}`, packClaimId: 'replacement' });
    });

    it('a return that lost its claim and whose replacement is still on its way (nothing recorded yet) leaves the machine alone too', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const before = names().length;
      const create = provider.create.bind(provider);
      provider.create = async (botId) => {
        const machine = await create(botId);
        await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { packClaimId: 'replacement', providerRef: null } });
        return machine;
      };
      await expect(bringBackFromCold(brick.botId, provider, NOW)).rejects.toMatchObject({ why: 'busy' });
      expect(names().slice(before)).not.toContain(`remove:fake-${brick.botId}`);
    });

    it('a return that lost its claim and finds nobody holding the Brick any more still removes the computer it made', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const before = names().length;
      const create = provider.create.bind(provider);
      provider.create = async (botId) => {
        const machine = await create(botId);
        // Taken over and put back to cold, with no replacement yet
        await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'cold', packStage: null, providerRef: null, packClaimId: 'took-over' } });
        return machine;
      };
      await expect(bringBackFromCold(brick.botId, provider, NOW)).rejects.toMatchObject({ why: 'busy' });
      expect(names().slice(before)).toContain(`remove:fake-${brick.botId}`);
    });

    it('no clean-up deletes the copies a return that is still alive is restoring from, whoever asks: a later save or another server\u2019s sweep leaves them, and takes them again once the return is over or has gone quiet', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId, state: 'verified' } })).toBe(1);
      // A return is under way and says it is alive
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'restoring', packStage: 'returning', packClaimId: 'return-1', packClaimedAt: NOW, returnedAt: new Date(NOW.getTime() - 86_400_000) } });
      const { dropColdCopiesIfNewer } = await import('@/lib/computer-cold');
      await dropColdCopiesIfNewer(brick.botId);
      expect(await pruneArchives(brick.botId, null, NOW, 0)).toBe(0);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId, state: 'verified' } })).toBe(1);
      // The return went quiet for longer than a claim lives: it no longer holds them
      expect(await pruneArchives(brick.botId, null, new Date(NOW.getTime() + 60 * 60_000), 0)).toBe(1);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
    });

    it('a replacement return cannot claim the Brick between the look and the removal: the removal holds the computer row until the machine is gone', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const create = provider.create.bind(provider);
      provider.create = async (botId) => {
        const machine = await create(botId);
        // Taken over and put back to cold, with no replacement yet: nobody holds the Brick when the cleanup looks
        await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'cold', packStage: null, providerRef: null, packClaimId: 'took-over' } });
        return machine;
      };
      let claimTried: Promise<{ count: number }> | null = null;
      let claimAnswered = false;
      let answeredEarly: boolean | null = null;
      const remove = provider.remove.bind(provider);
      provider.remove = async (ref) => {
        // A replacement return tries to claim the Brick while the machine is being removed (it would be handed this very machine)
        claimTried = prisma.brickComputer
          .updateMany({ where: { botId: brick.botId, machine: 'cold', providerRef: null }, data: { machine: 'restoring', packStage: 'returning', packClaimId: 'replacement' } })
          .then((done) => { claimAnswered = true; return done; });
        await waitUntilBlockedOnLock();
        answeredEarly = claimAnswered;
        return remove(ref);
      };
      await expect(bringBackFromCold(brick.botId, provider, NOW)).rejects.toMatchObject({ why: 'busy' });
      // It was not let in while the removal was still going on, and is let in after
      expect(answeredEarly).toBe(false);
      expect(claimTried).not.toBeNull();
      expect(await claimTried).toMatchObject({ count: 1 });
      expect(await row(brick.botId)).toMatchObject({ packClaimId: 'replacement' });
    });

    it('a return that lost its claim during the restore does not remove the half-restored computer the return that took over now holds', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const before = names().length;
      const original = provider.restoreInto.bind(provider);
      provider.restoreInto = async (ref, source) => {
        await original(ref, source);
        await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { packClaimId: 'replacement' } });
        return { ok: false, reason: 'did not check out', ms: 1 };
      };
      await expect(bringBackFromCold(brick.botId, provider, NOW)).rejects.toMatchObject({ why: 'busy' });
      expect(names().slice(before)).not.toContain(`remove:fake-${brick.botId}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'restoring', providerRef: `fake-${brick.botId}`, packClaimId: 'replacement' });
    });

    it('the line that says a packed-away disk is gone is written only while the Brick is still cold: a return that claimed meanwhile keeps its own disk line as the newest', async () => {
      const brick = await idleBrick();
      const { recordKeptBytes } = await import('@/lib/computer-disk');
      expect(await recordKeptBytes({ botId: brick.botId, reason: 'made', machineBytes: 4_000_000_000, copyBytes: 0, now: new Date(NOW.getTime() - 60_000) })).toBe(true);
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'cold', providerRef: null, packStage: null } });
      const lines = () => prisma.meterEvent.count({ where: { botId: brick.botId, kind: 'stored_bytes' } });
      // The return claims the row and holds it while it makes its computer: the correction waits for it, then finds the Brick is not cold and writes nothing
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let claimed!: () => void;
      const claimedIt = new Promise<void>((resolve) => { claimed = resolve; });
      const returning = prisma.$transaction(async (tx) => {
        await tx.brickComputer.updateMany({ where: { botId: brick.botId, machine: 'cold' }, data: { machine: 'restoring', packStage: 'returning', packClaimId: 'return-1' } });
        claimed();
        await held;
      });
      await claimedIt;
      const settling = recordKeptBytes({ botId: brick.botId, reason: 'gone', machineBytes: null, copyBytes: 7, now: NOW, onlyWhileCold: true });
      // It has not finished while the return holds the row: the database shows it waiting on that row
      let settled = false;
      void settling.then(() => { settled = true; });
      await waitUntilBlockedOnLock();
      expect(settled).toBe(false);
      release();
      await returning;
      expect(await settling).toBe(true);
      expect(await lines()).toBe(1);
    });

    it('the line that says a packed-away disk is gone is still written when the Brick stays cold', async () => {
      const brick = await idleBrick();
      const { recordKeptBytes } = await import('@/lib/computer-disk');
      await recordKeptBytes({ botId: brick.botId, reason: 'made', machineBytes: 4_000_000_000, copyBytes: 0, now: new Date(NOW.getTime() - 60_000) });
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'cold', providerRef: null, packStage: null } });
      expect(await recordKeptBytes({ botId: brick.botId, reason: 'gone', machineBytes: null, copyBytes: 7, now: NOW, onlyWhileCold: true })).toBe(true);
      const lines = await prisma.meterEvent.findMany({ where: { botId: brick.botId, kind: 'stored_bytes' }, orderBy: [{ occurredAt: 'asc' }] });
      expect(lines.map((line) => Number(line.quantity))).toEqual([4_000_000_000, 7]);
    });

    it('the disk of a computer made for a return sorts after a correction the sweep wrote while the Brick was cold, even when the job started before that correction', async () => {
      const brick = await idleBrick();
      provider.disk = 4_000_000_000;
      expect(await packAway(brick.botId, provider, NOW)).toBe('packed');
      const { recordKeptBytes } = await import('@/lib/computer-disk');
      // The correction ran at a later time than the job's own start (the job's `now` is the day it was asked, which can be older than the sweep's clock)
      expect(await recordKeptBytes({ botId: brick.botId, reason: 'gone', machineBytes: null, copyBytes: 7, now: new Date(NOW.getTime() + DAY), onlyWhileCold: true })).toBe(true);
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Back' }, NOW);
      expect(started.ok && started.job.status).toBe('running');
      const newest = await prisma.meterEvent.findFirstOrThrow({ where: { botId: brick.botId, kind: 'stored_bytes' }, orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }] });
      // The newest level counts the new computer's disk
      expect(Number(newest.quantity)).toBeGreaterThanOrEqual(4_000_000_000);
    });

    it('a second job that comes in while a machine is waking after an older-copy return keeps the day the files are from, even though the saved-copy date is later than that day', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const cameFrom = new Date(NOW.getTime() - 3 * DAY);
      // The newest copy (a day ago) stayed the saved-copy date; the older copy (3 days ago) was restored an hour ago and nothing was saved since
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'waking', providerRef: `fake-${brick.botId}`, olderCopyUsed: true, restoredFrom: cameFrom, filesSavedAt: new Date(NOW.getTime() - DAY), returnedAt: new Date(NOW.getTime() - 60 * 60_000) } });
      // The machine is `waking` with no start behind it (its wake is older than a start can take): this start wakes it
      await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "bot_id" = ${brick.botId}`;
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Second' }, NOW);
      expect(started.ok && started.job.status).toBe('running');
      expect(await row(brick.botId)).toMatchObject({ machine: 'working', olderCopyUsed: true, restoredFrom: cameFrom });
    });

    it('that day is dropped once the files were saved after the return', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const cameFrom = new Date(NOW.getTime() - 3 * DAY);
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'waking', providerRef: `fake-${brick.botId}`, olderCopyUsed: true, restoredFrom: cameFrom, filesSavedAt: new Date(NOW.getTime() - 10 * 60_000), returnedAt: new Date(NOW.getTime() - 60 * 60_000) } });
      // The machine is `waking` with no start behind it (its wake is older than a start can take): this start wakes it
      await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "bot_id" = ${brick.botId}`;
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Third' }, NOW);
      expect(started.ok && started.job.status).toBe('running');
      expect(await row(brick.botId)).toMatchObject({ machine: 'working', olderCopyUsed: false, restoredFrom: null });
    });

    it('cleans up a return a stopped server left: the half-restored computer is removed and the Brick is cold again', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      await prisma.brickComputer.update({ where: { botId: brick.botId }, data: { machine: 'restoring', packStage: 'returning', providerRef: 'half-1', packClaimedAt: new Date(NOW.getTime() - 3 * 60 * 60_000) } });
      const result = await coldStep(provider, NOW);
      expect(result.recovered).toBe(1);
      expect(names()).toEqual(expect.arrayContaining(['remove:half-1', 'confirmRemoved:half-1']));
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null, packStage: null });
    });
  });

  describe('deleting a Brick', () => {
    it('the final purge removes every cold copy with it, from the bucket too, and is tried again while one cannot be deleted', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      expect(bucket.objects.size).toBe(1);
      await prisma.brickPurge.create({ data: { botId: brick.botId, provider: 'fake', providerRef: null, machinePending: false, copyPending: true, nextTryAt: NOW } });
      const failing = { ...bucket.store, remove: async () => { throw new Error('the bucket is down'); } };
      setArchiveStoreForTests(failing);
      expect(await finishOutside(brick.botId, NOW)).toMatchObject({ done: false });
      expect(bucket.objects.size).toBe(1);
      setArchiveStoreForTests(bucket.store);
      expect(await finishOutside(brick.botId, new Date(NOW.getTime() + 60 * 60_000))).toMatchObject({ done: true });
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(0);
      await prisma.brickPurge.deleteMany({ where: { botId: brick.botId } });
    });

    it('a purge is not finished while any copy row of the Brick remains: it is tried again, and finishes when none is left', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      await prisma.brickPurge.create({ data: { botId: brick.botId, provider: 'fake', providerRef: null, machinePending: false, copyPending: true, nextTryAt: NOW } });
      // A copy begins to be written while the purge deletes the others: its row did not exist when the rows were read
      let lateId = '';
      const removeObjects = bucket.store.remove.bind(bucket.store);
      setArchiveStoreForTests({
        ...bucket.store,
        remove: async (keys) => {
          await removeObjects(keys);
          const late = await prisma.computerArchive.create({ data: { botId: brick.botId, generation: 99, state: 'staging', objectKey: `computer-cold/${brick.botId}/99.${randomUUID()}.ubc` } });
          lateId = late.id;
        },
      });
      try {
        const first = await finishOutside(brick.botId, NOW);
        expect(first.done).toBe(false);
        expect(first.left).toContain('cold storage copies');
        expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(1);
        expect(await prisma.brickPurge.findUniqueOrThrow({ where: { botId: brick.botId } })).toMatchObject({ copyPending: true, doneAt: null });
      } finally {
        setArchiveStoreForTests(bucket.store);
      }
      // The next try finds the late row too and deletes it
      expect((await finishOutside(brick.botId, new Date(Date.now() + 61 * 60_000))).done).toBe(true);
      expect(await prisma.computerArchive.count({ where: { id: lateId } })).toBe(0);
      await prisma.brickPurge.deleteMany({ where: { botId: brick.botId } });
    });

    it('a write that stopped after a purge took its row leaves an object no row points at, and the sweep finds it once no write can still be running', async () => {
      const brick = await idleBrick();
      // The process dies after the check that let the copy publish: nothing it would have done after that (removing its objects) happens
      const real = bucket.store.remove.bind(bucket.store);
      let dead = false;
      setArchiveStoreForTests({
        ...bucket.store,
        put: async (finalKey, stagingKey, archive, mayPublish) => {
          const sealed = await bucket.store.put(finalKey, stagingKey, archive, async () => {
            const allowed = mayPublish ? await mayPublish() : true;
            // The purge deletes the writer's row right after the check (the process is gone before the copy and before any clean-up)
            await prisma.computerArchive.deleteMany({ where: { botId: brick.botId } });
            dead = true;
            return allowed;
          });
          return sealed;
        },
        remove: async (keys) => {
          if (dead) return; // the process is gone: it removes nothing
          return real(keys);
        },
      });
      try {
        await expect(storeArchive(brick.botId, new Response('half done').body as ReadableStream<Uint8Array>)).rejects.toBeDefined();
      } finally {
        setArchiveStoreForTests(bucket.store);
      }
      // An object with no row is left
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(1);
      const [key] = [...bucket.objects.keys()];
      // A young one may belong to a write that is still running: it is left
      bucket.written.set(key, new Date(NOW.getTime() - 5 * 60_000));
      expect(await removeStrayCopies(NOW)).toBe(0);
      expect(bucket.objects.size).toBe(1);
      // Old enough that no write can still be running: it goes
      bucket.written.set(key, new Date(NOW.getTime() - 2 * 60 * 60_000));
      expect(await removeStrayCopies(NOW)).toBe(1);
      expect(bucket.objects.size).toBe(0);
    });

    it('a purge is not done while an object is left that its writer could neither take back nor write a row for: found by listing the Brick’s part of the bucket, and removed once no write can still be running', async () => {
      const brick = await idleBrick();
      // The Brick is purged while its copy is written: the row is taken and the marker written right after the check that let it publish, and then the bucket
      // cannot delete the object and the database cannot write the record that would let a clean-up find it
      setArchiveStoreForTests({
        ...bucket.store,
        put: async (finalKey, stagingKey, archive, mayPublish) => {
          const sealed = await bucket.store.put(finalKey, stagingKey, archive, mayPublish);
          await prisma.computerArchive.deleteMany({ where: { botId: brick.botId } });
          await prisma.brickPurge.create({ data: { botId: brick.botId, provider: 'fake', providerRef: null, machinePending: false, copyPending: true, nextTryAt: NOW } });
          return sealed;
        },
        remove: async () => {
          throw new Error('the bucket is down');
        },
      });
      const upsert = jest.spyOn(prisma.computerArchive, 'upsert').mockRejectedValue(new Error('the database is down'));
      try {
        await expect(storeArchive(brick.botId, new Response('half done').body as ReadableStream<Uint8Array>)).rejects.toBeDefined();
      } finally {
        upsert.mockRestore();
        setArchiveStoreForTests(bucket.store);
      }
      // The object is in the bucket with no row anywhere: a purge that works from rows would call the Brick clear
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(1);
      const [key] = [...bucket.objects.keys()];
      // It may belong to a write that is still running: it is left, and the purge is not done
      bucket.written.set(key, new Date(NOW.getTime() - 5 * 60_000));
      const first = await finishOutside(brick.botId, NOW);
      expect(first).toMatchObject({ done: false });
      expect(first.left).toContain('cold storage copies');
      expect(bucket.objects.size).toBe(1);
      // Old enough that no write can still be running, but the bucket is still down: still not done, still there
      bucket.written.set(key, new Date(NOW.getTime() - 2 * 60 * 60_000));
      setArchiveStoreForTests({ ...bucket.store, remove: async () => { throw new Error('the bucket is down'); } });
      expect(await finishOutside(brick.botId, NOW)).toMatchObject({ done: false });
      setArchiveStoreForTests(bucket.store);
      expect(bucket.objects.size).toBe(1);
      // The bucket is back: it is removed, and only then is the Brick clear
      expect(await finishOutside(brick.botId, NOW)).toMatchObject({ done: true });
      expect(bucket.objects.size).toBe(0);
      await prisma.brickPurge.deleteMany({ where: { botId: brick.botId } });
    });

    it('the sweep leaves an old object alone while a row points at it', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      const [copy] = await verifiedArchives(brick.botId);
      bucket.written.set(copy.objectKey, new Date(NOW.getTime() - 5 * 60 * 60_000));
      expect(await removeStrayCopies(NOW)).toBe(0);
      expect(bucket.objects.has(copy.objectKey)).toBe(true);
    });

    it('the sweep removes the copies of a Brick that no longer has a computer record (a pack-away that met the purge)', async () => {
      const brick = await idleBrick();
      await storeArchive(brick.botId, new Response('left behind').body as ReadableStream<Uint8Array>);
      await prisma.brickComputer.delete({ where: { botId: brick.botId } });
      await coldStep(provider, NOW);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(0);
    });

    it('a pack-away whose Brick was purged half way gives up quietly and removes only what it made', async () => {
      const brick = await idleBrick();
      const original = provider.restoreInto.bind(provider);
      provider.restoreInto = async (ref, source) => {
        await prisma.brickComputer.delete({ where: { botId: brick.botId } });
        return original(ref, source);
      };
      expect(await packAway(brick.botId, provider, NOW)).not.toBe('packed');
      expect(names()).toContain('remove:scratch-1');
      expect(names()).not.toContain(`remove:${brick.ref}`);
      // The copy it stored for a Brick that is gone is removed by the sweep
      await coldStep(provider, NOW);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(0);
    });
  });

  describe('a deleted Brick while its Undo days run (the computer is removed only after a copy passes the restore check)', () => {
    const deleteNow = async (brick: { botId: string; personId: string }) => {
      const now = new Date();
      await deleteBrick(brick.botId, brick.personId, now);
      return now;
    };

    it('is packed at once, without waiting for the idle days, and the owner sees the day the provider’s copy of it went', async () => {
      const brick = await idleBrick(0);
      const now = await deleteNow(brick);
      expect((await coldStep(provider, now)).packed).toBe(1);
      expect(await row(brick.botId)).toMatchObject({ machine: 'cold', providerRef: null });
      expect(names()).toContain(`remove:${brick.ref}`);
      const [card] = (await listDeletedBricks(brick.personId, now)).filter((entry) => entry.id === brick.botId);
      expect(card.computerRemovedAt).not.toBeNull();
      // The two clocks are separate: Undo ends on its own date, the computer went on its own
      expect(card.goneAt).not.toBe(card.computerRemovedAt);
    });

    it('stays tracked and stopped when the copy does not pass the restore check: nothing is removed, and it is tried again after the wait', async () => {
      const brick = await idleBrick(0);
      const now = await deleteNow(brick);
      provider.restoreResults = [{ ok: false, reason: 'compare_failed', ms: 10 }];
      expect((await coldStep(provider, now)).packed).toBe(0);
      expect(names()).not.toContain(`remove:${brick.ref}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'stopped', providerRef: brick.ref, packFailures: 1 });
      expect((await listDeletedBricks(brick.personId, now)).find((entry) => entry.id === brick.botId)?.computerRemovedAt).toBeNull();
      provider.calls.length = 0;
      expect((await coldStep(provider, now)).packed).toBe(0);
      expect(provider.calls.some((call) => call.name === 'prepack')).toBe(false);
      expect((await coldStep(provider, new Date(Date.now() + 2 * 60 * 60_000))).packed).toBe(1);
    });

    it('Undo, then a job: the computer comes back from the copy on a fresh machine, with no old key or authority on it', async () => {
      const brick = await idleBrick(0);
      const now = await deleteNow(brick);
      await coldStep(provider, now);
      expect((await row(brick.botId)).machine).toBe('cold');
      expect(await undoBrickDelete(brick.botId, brick.personId, new Date())).not.toBeNull();
      provider.calls.length = 0;
      const started = await startJob({ botId: brick.botId, personId: brick.personId, title: 'Back again' }, new Date());
      expect(started.ok).toBe(true);
      expect(names().filter((call) => ['create', 'restoreInto'].includes(call.split(':')[0]))).toEqual([`create:${brick.botId}`, `restoreInto:fake-${brick.botId}`]);
      expect(await row(brick.botId)).toMatchObject({ machine: 'working', packStage: null });
    });

    it('the final purge removes the copies and the computer without making a new copy', async () => {
      const brick = await idleBrick(0);
      const now = await deleteNow(brick);
      await coldStep(provider, now);
      provider.calls.length = 0;
      await prisma.bot.update({ where: { id: brick.botId }, data: { goneAt: new Date(Date.now() - 1000) } });
      const purged = await purgeBrick(brick.botId, new Date());
      expect(['purged', 'books']).toContain(purged);
      if (purged === 'purged') await finishOutside(brick.botId, new Date());
      expect(names().filter((call) => ['prepack', 'streamFiles', 'makeScratch', 'restoreInto'].includes(call.split(':')[0]))).toEqual([]);
      expect(await prisma.computerArchive.count({ where: { botId: brick.botId } })).toBe(0);
      expect(bucket.objects.size).toBe(0);
    });
  });

  describe('the weekly restore drill', () => {
    it('restores one proved copy on a throwaway computer once a week, writes it down, and removes the computer', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      provider.calls.length = 0;
      expect(await restoreDrill(provider, NOW)).toBe('ok');
      expect(names()).toEqual(expect.arrayContaining(['makeScratch', 'remove:scratch-2', 'confirmRemoved:scratch-2']));
      expect(await prisma.computerColdRun.count({ where: { kind: 'drill', scratch: true, outcome: 'ok' } })).toBe(1);
      // Not again inside the week, and again after it
      expect(await restoreDrill(provider, new Date(Date.now() + 6 * DAY))).toBeNull();
      expect(await restoreDrill(provider, new Date(Date.now() + 8 * DAY))).toBe('ok');
      expect((await coldStatus()).lastDrill).toMatchObject({ ok: true });
    });

    it('says plainly when a stored copy cannot be restored, and the readiness page is not ready until it passes', async () => {
      const brick = await idleBrick();
      await packAway(brick.botId, provider, NOW);
      provider.restoreResults = [{ ok: false, reason: 'damaged', ms: 1 }];
      expect(await restoreDrill(provider, new Date(Date.now() + 8 * DAY))).toBe('failed');
      // The run is written down as failed (not as a run that went fine), and the readiness page is not ready
      expect(await prisma.computerColdRun.count({ where: { kind: 'drill', outcome: 'failed' } })).toBe(1);
      expect((await coldStatus()).lastDrill).toMatchObject({ ok: false });
      const readiness = await computerReadiness();
      const cold = readiness.checks.find((check) => check.name === 'cold storage');
      expect(cold).toMatchObject({ ok: false });
      expect(cold?.detail).toContain('FAILED');
      expect(cold?.detail).toContain('1 computer packed away');
    });

    it('says so on the readiness page, and is not ready, when the cold storage status cannot be read', async () => {
      const spy = jest.spyOn(prisma.computerColdRun, 'findFirst').mockRejectedValue(new Error('the database is down') as never);
      try {
        const readiness = await computerReadiness();
        expect(readiness.checks.find((check) => check.name === 'cold storage')).toMatchObject({ ok: false, detail: 'The cold storage status could not be read' });
        expect(readiness.ready).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('does nothing when there is no proved copy to restore', async () => {
      expect(await restoreDrill(provider, NOW)).toBeNull();
      expect(provider.calls.some((call) => call.name === 'makeScratch')).toBe(false);
    });
  });

  it('a computer packed away is as the owner is told: cold, with the day it was packed', async () => {
    const brick = await idleBrick();
    await packAway(brick.botId, provider, NOW);
    const view = await computerView(brick.botId, brick.personId, NOW);
    expect(view).toMatchObject({ machine: 'cold', olderCopyUsed: false });
    expect(view?.packedAt).toBeInstanceOf(Date);
    expect((await archiveById((await verifiedArchives(brick.botId))[0].id))?.state).toBe('verified');
  });

  it('the status sizes the storage by the bytes really kept, at the storage Limit, and counts the awake seconds measured', async () => {
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 50_000, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');
    const brick = await idleBrick();
    provider.homeArchive = Buffer.alloc(2_000_000_000 / 1000, 1);
    await packAway(brick.botId, provider, NOW);
    const status = await coldStatus();
    expect(status.storedBytes).toBe(provider.homeArchive.length);
    // 2 MB at $0.05 a GB-month is rounded up to whole millionths of a dollar: 100 micros
    expect(status.storageMonthMicros).toBe(100);
    expect(status.last30Days.runs).toBeGreaterThan(0);
    expect(status.last30Days.scratchSeconds).toBeGreaterThanOrEqual(0);
  });
  // GPT money review O1b: a deletion that cannot finish keeps its record (never dropped to make the page look clean) and says how long it has waited, so a
  // slow bucket and one that has stopped accepting deletes can be told apart. Aged in whole hours here; the bucket is the in-memory one with `remove` refused.
  describe('the oldest deletion still waiting', () => {
    const HOUR = 3_600_000;
    const down = () => setArchiveStoreForTests({ ...bucket.store, remove: async () => { throw new Error('the bucket is down'); } });
    const copy = async (botId: string, generation: number, state: 'failed' | 'verified' | 'superseded', extra: { deletionSince?: Date | null } = {}) => {
      const id = randomUUID();
      const objectKey = `computer-cold/${botId}/${generation}.${id}.ubc`;
      bucket.objects.set(objectKey, Buffer.from('copy'));
      bucket.written.set(objectKey, new Date(NOW.getTime() - 40 * DAY));
      return prisma.computerArchive.create({ data: { id, botId, generation, state, objectKey, createdAt: new Date(NOW.getTime() - 40 * DAY), ...extra } });
    };

    it('says nothing is waiting when nothing is', async () => {
      expect(await storageDeletionsWaiting(NOW)).toEqual({ count: 0, oldestSince: null, ageMs: null, strayCopiesSince: null });
    });

    it('a copy whose object cannot be deleted keeps its row and counts from the FIRST try, not from the copy’s own age or the latest try', async () => {
      const brick = await idleBrick();
      const old = await copy(brick.botId, 1, 'failed');
      down();
      expect(await pruneArchives(brick.botId, null, NOW)).toBe(0);
      const waiting = await prisma.computerArchive.findUniqueOrThrow({ where: { id: old.id } });
      expect(waiting.state).toBe('superseded');
      expect(waiting.deletionSince?.toISOString()).toBe(NOW.toISOString());
      // Three hours and another failed try later: still one wait that began at the first try
      expect(await pruneArchives(brick.botId, null, new Date(NOW.getTime() + 3 * HOUR))).toBe(0);
      expect(await storageDeletionsWaiting(new Date(NOW.getTime() + 3 * HOUR))).toEqual({ count: 1, oldestSince: NOW, ageMs: 3 * HOUR, strayCopiesSince: null });
      // The bucket comes back: the object and the row go, and nothing waits
      setArchiveStoreForTests(bucket.store);
      expect(await pruneArchives(brick.botId, null, new Date(NOW.getTime() + 4 * HOUR))).toBe(1);
      expect(bucket.objects.size).toBe(0);
      expect(await storageDeletionsWaiting(new Date(NOW.getTime() + 4 * HOUR))).toMatchObject({ count: 0, ageMs: null });
    });

    it('the wait begins when the copy is taken for deletion, before its object is touched (a server that stops there leaves the time written)', async () => {
      const brick = await idleBrick();
      const old = await copy(brick.botId, 1, 'failed');
      let seenWhenDeleting: Date | null | undefined;
      setArchiveStoreForTests({ ...bucket.store, remove: async () => { seenWhenDeleting = (await prisma.computerArchive.findUnique({ where: { id: old.id } }))?.deletionSince; throw new Error('the bucket is down'); } });
      await pruneArchives(brick.botId, null, NOW);
      expect(seenWhenDeleting?.toISOString()).toBe(NOW.toISOString());
    });

    it('a copy left superseded by an older version, with no time written, begins its wait at the first try that fails', async () => {
      const brick = await idleBrick();
      const old = await copy(brick.botId, 1, 'superseded');
      expect(await storageDeletionsWaiting(NOW)).toMatchObject({ count: 0 });
      down();
      await pruneArchives(brick.botId, null, NOW);
      expect((await prisma.computerArchive.findUniqueOrThrow({ where: { id: old.id } })).deletionSince?.toISOString()).toBe(NOW.toISOString());
    });

    it('the oldest of several is the one read, and a purge that cannot delete marks every copy it tried', async () => {
      const brick = await idleBrick();
      const first = await copy(brick.botId, 1, 'verified');
      const second = await copy(brick.botId, 2, 'verified');
      down();
      await expect(deleteAllArchives(brick.botId, NOW)).rejects.toThrow('down');
      await expect(deleteAllArchives(brick.botId, new Date(NOW.getTime() + 2 * HOUR))).rejects.toThrow('down');
      const rows = await prisma.computerArchive.findMany({ where: { id: { in: [first.id, second.id] } } });
      expect(rows.map((row) => row.deletionSince?.toISOString())).toEqual([NOW.toISOString(), NOW.toISOString()]);
      // A younger one on another Brick does not hide the older wait
      const other = await idleBrick();
      await copy(other.botId, 1, 'failed', { deletionSince: new Date(NOW.getTime() + 5 * HOUR) });
      expect(await storageDeletionsWaiting(new Date(NOW.getTime() + 6 * HOUR))).toEqual({ count: 3, oldestSince: NOW, ageMs: 6 * HOUR, strayCopiesSince: null });
    });

    it('a sweep for copies no row points at that cannot delete says since when, keeps where it was, and clears when it can', async () => {
      const key = 'computer-cold/0-z/9.' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + '.ubc';
      bucket.objects.set(key, Buffer.from('stray'));
      bucket.written.set(key, new Date(NOW.getTime() - 2 * HOUR));
      down();
      await expect(removeStrayCopies(NOW)).rejects.toThrow('down');
      await expect(removeStrayCopies(new Date(NOW.getTime() + 2 * HOUR))).rejects.toThrow('down');
      expect(await storageDeletionsWaiting(new Date(NOW.getTime() + 2 * HOUR))).toEqual({ count: 0, oldestSince: NOW, ageMs: 2 * HOUR, strayCopiesSince: NOW });
      setArchiveStoreForTests(bucket.store);
      expect(await removeStrayCopies(new Date(NOW.getTime() + 3 * HOUR))).toBe(1);
      expect(await storageDeletionsWaiting(new Date(NOW.getTime() + 3 * HOUR))).toMatchObject({ oldestSince: null, ageMs: null, strayCopiesSince: null });
      await prisma.appSetting.deleteMany({ where: { key: STRAY_CURSOR_KEY } });
    });

    it('a prune that read the row before a purge wrote its first failure keeps the earlier time: the wait is the database’s own, not the one read', async () => {
      const brick = await idleBrick();
      const old = await copy(brick.botId, 1, 'failed');
      const early = new Date(NOW.getTime() - 3 * HOUR);
      const real = prisma.brickComputer.findUnique.bind(prisma.brickComputer);
      // Between the prune's read of the rows and its guarded update, a purge writes down its own (earlier) first failure, leaving the row's state as it was
      const spy = jest.spyOn(prisma.brickComputer, 'findUnique').mockImplementationOnce(((args: never) =>
        prisma.computerArchive.update({ where: { id: old.id }, data: { deletionSince: early } }).then(() => real(args))) as never);
      down();
      try {
        expect(await pruneArchives(brick.botId, null, NOW)).toBe(0);
      } finally {
        spy.mockRestore();
      }
      expect((await prisma.computerArchive.findUniqueOrThrow({ where: { id: old.id } })).deletionSince).toEqual(early);
      expect(await storageDeletionsWaiting(NOW)).toMatchObject({ count: 1, oldestSince: early, ageMs: 3 * HOUR });
    });

    it('when the stray-sweep state cannot be read the status says so (never "nothing waits"), while a sweep pass still goes on from the top and writes nothing it cannot check', async () => {
      const key = 'computer-cold/0-z/9.' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + '.ubc';
      bucket.objects.set(key, Buffer.from('stray'));
      bucket.written.set(key, new Date(NOW.getTime() - 2 * HOUR));
      down();
      await expect(removeStrayCopies(NOW)).rejects.toThrow('down');
      await expect(removeStrayCopies(new Date(NOW.getTime() + 2 * HOUR))).rejects.toThrow('down');
      expect(await storageDeletionsWaiting(new Date(NOW.getTime() + 2 * HOUR))).toMatchObject({ strayCopiesSince: NOW });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const realFind = prisma.appSetting.findUnique.bind(prisma.appSetting);
      // Only the stray-sweep row cannot be read; everything else the readiness page reads works
      const unreadable = jest.spyOn(prisma.appSetting, 'findUnique').mockImplementation(((args: { where: { key: string } }) => (args.where.key === STRAY_CURSOR_KEY ? Promise.reject(new Error('the database is busy')) : realFind(args as never))) as never);
      try {
        // The status caller is told: an overdue failure that cannot be read is not "no wait"
        await expect(storageDeletionsWaiting(new Date(NOW.getTime() + 30 * HOUR))).rejects.toThrow('busy');
        const readiness = (await computerReadiness()).checks.find((one) => one.name === 'storage deletions');
        expect(readiness).toMatchObject({ ok: false, detail: 'The deletions waiting in storage could not be read' });
        // Cursor recovery is tolerant: the pass lists from the top and deletes, but writes nothing (it cannot tell whether a newer pass wrote since)
        setArchiveStoreForTests(bucket.store);
        expect(await removeStrayCopies(new Date(NOW.getTime() + 30 * HOUR))).toBe(1);
      } finally {
        unreadable.mockRestore();
        quiet.mockRestore();
      }
      // The failure written before is still there, not cleared by a pass that could not read it
      expect(await storageDeletionsWaiting(new Date(NOW.getTime() + 30 * HOUR))).toMatchObject({ strayCopiesSince: NOW });
      await prisma.appSetting.deleteMany({ where: { key: STRAY_CURSOR_KEY } });
    });

    it('an older pass that finishes after a newer one wrote a failure never clears that failure or moves the cursor back', async () => {
      for (const name of ['a', 'b', 'c', 'd']) bucket.objects.set(`computer-cold/0-${name}/other.txt`, Buffer.from(name));
      setStrayPassForTests(2);
      const real = bucket.store.list;
      let overtaken = false;
      // While the older pass is listing, a newer pass records a failure and has already moved the cursor on
      setArchiveStoreForTests({
        ...bucket.store,
        list: async (prefix, max, startAfter) => {
          if (!overtaken) {
            overtaken = true;
            await prisma.appSetting.upsert({ where: { key: STRAY_CURSOR_KEY }, create: { key: STRAY_CURSOR_KEY, value: { after: 'computer-cold/0-d/other.txt', failingSince: NOW.toISOString() } }, update: { value: { after: 'computer-cold/0-d/other.txt', failingSince: NOW.toISOString() } } });
          }
          return real(prefix, max, startAfter);
        },
      });
      try {
        await removeStrayCopies(new Date(NOW.getTime() + HOUR));
        // The older pass looked at the first page only: what it wrote does not replace the newer state
        expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: STRAY_CURSOR_KEY } })).value).toEqual({ after: 'computer-cold/0-d/other.txt', failingSince: NOW.toISOString() });
        expect(await storageDeletionsWaiting(new Date(NOW.getTime() + HOUR))).toMatchObject({ strayCopiesSince: NOW });
      } finally {
        setStrayPassForTests(20_000);
        setArchiveStoreForTests(bucket.store);
        await prisma.appSetting.deleteMany({ where: { key: STRAY_CURSOR_KEY } });
      }
    });

    it('the readiness page shows how long, is still ready inside a day, and is not ready once a deletion has waited longer than a day', async () => {
      const brick = await idleBrick();
      const old = await copy(brick.botId, 1, 'superseded', { deletionSince: new Date() });
      const check = async () => (await computerReadiness()).checks.find((one) => one.name === 'storage deletions');
      expect(await check()).toMatchObject({ ok: true, detail: expect.stringMatching(/^1 copy deletion waiting; the oldest for \d+ min$/) });
      await prisma.computerArchive.update({ where: { id: old.id }, data: { deletionSince: new Date(Date.now() - 5 * HOUR) } });
      expect(await check()).toMatchObject({ ok: true, detail: '1 copy deletion waiting; the oldest for 5 hours' });
      await prisma.computerArchive.update({ where: { id: old.id }, data: { deletionSince: new Date(Date.now() - 50 * HOUR) } });
      const stalled = await check();
      expect(stalled).toMatchObject({ ok: false });
      expect(stalled?.detail).toBe('1 copy deletion waiting; the oldest for 2 days: the bucket may have stopped accepting deletes');
      expect((await computerReadiness()).ready).toBe(false);
      await prisma.computerArchive.deleteMany({ where: { id: old.id } });
      expect(await check()).toMatchObject({ ok: true, detail: 'No deletion is waiting in storage' });
    });

    it('the sweep tells the team once a deletion has waited more than a day, and not again until some hours later', async () => {
      const brick = await idleBrick();
      await copy(brick.botId, 1, 'superseded', { deletionSince: new Date(NOW.getTime() - STORAGE_DELETION_ALERT_MS + HOUR) });
      down();
      (Sentry.captureMessage as jest.Mock).mockClear();
      await coldStep(provider, NOW);
      expect(Sentry.captureMessage).not.toHaveBeenCalledWith(expect.stringContaining('deletion of stored computer copies'), expect.anything());
      const later = new Date(NOW.getTime() + 2 * HOUR);
      await coldStep(provider, later);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('deletion of stored computer copies has waited more than a day'), expect.objectContaining({ level: 'warning', extra: expect.objectContaining({ waiting: 1 }) }));
      const times = () => (Sentry.captureMessage as jest.Mock).mock.calls.filter((call) => String(call[0]).includes('deletion of stored computer copies')).length;
      expect(times()).toBe(1);
      await coldStep(provider, new Date(later.getTime() + HOUR));
      expect(times()).toBe(1);
      await coldStep(provider, new Date(later.getTime() + 7 * HOUR));
      expect(times()).toBe(2);
    });
  });
});
