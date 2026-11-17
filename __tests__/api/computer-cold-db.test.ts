/**
 * Cold storage for a Brick's computer against a real database, with the PRETEND provider and an in-memory bucket: what only the database can show.
 * A computer idle for the Limit's days is packed away: the copy is stored, restored on a throwaway computer and checked BEFORE the computer is
 * deleted, and the deletion is confirmed. A job that arrives, a Brick that is deleted, a proof that fails or a provider that still lists the computer
 * all keep the computer. A return restores the newest proved copy, falls back to the one before it (and says so), and leaves the Brick cold when no
 * copy restores. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-cold-db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveServerLimits } from '@/lib/bot-limits';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { coldStatus, coldStep, heartbeat, packAway, restoreDrill, STUCK_MS } from '@/lib/computer-cold';
import { computerView, giveComputer, startJob, sweepComputers } from '@/lib/computer';
import { finishOutside, purgeBrick } from '@/lib/brick-purge';
import { deleteBrick, undoBrickDelete } from '@/lib/brick-delete';
import { listDeletedBricks } from '@/lib/brick-default';
import { computerReadiness } from '@/lib/computer-readiness';
import { archiveById, markVerified, mintDownloadToken, pruneArchives, setArchiveStoreForTests, storeArchive, verifiedArchives, type ArchiveStore } from '@/lib/computer-archives';
import { GET as download } from '@/app/api/computer/archives/[id]/download/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const NOW = new Date('2026-11-15T12:00:00Z');
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = { provider: process.env.COMPUTER_PROVIDER, url: process.env.ADMIN_API_URL, publicUrl: process.env.NEXT_PUBLIC_API_URL };

/** The bucket, in memory. What is "encrypted" in the real one is plain here: the encryption has its own tests (saved-copies). */
function memoryStore() {
  const objects = new Map<string, Buffer>();
  const store: ArchiveStore = {
    async put(finalKey, _stagingKey, archive) {
      const chunks: Buffer[] = [];
      const reader = archive.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      const body = Buffer.concat(chunks);
      objects.set(finalKey, body);
      return { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    },
    async open(key) {
      const body = objects.get(key);
      if (!body) throw new Error('not found');
      return { stream: Readable.from([body]), bytes: body.length };
    },
    async remove(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
  return { store, objects };
}
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

    it('a proof that ran so long its claim was taken over cannot fail the copy another run has proved since: the proved copy and the removal stay', async () => {
      const brick = await idleBrick();
      const original = provider.restoreInto.bind(provider);
      provider.restoreInto = async (ref, source) => {
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

    it('keeps the computer when it holds more outside its home folder than can be carried, and says why only by not packing it', async () => {
      const brick = await idleBrick();
      provider.inventory = { ...provider.inventory, blocked: 'too_big_outside' };
      expect(await packAway(brick.botId, provider, NOW)).toBe('failed');
      expect(names()).not.toContain(`streamFiles:${brick.ref}`);
      expect(await row(brick.botId)).toMatchObject({ machine: 'stopped', packFailures: 1 });
      expect((await coldStatus()).failing).toBe(1);
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
      expect(await prisma.computerColdRun.count({ where: { kind: 'drill', outcome: 'failed' } })).toBe(0);
      const readiness = await computerReadiness();
      const cold = readiness.checks.find((check) => check.name === 'cold storage');
      expect(cold).toMatchObject({ ok: true });
      expect(cold?.detail).toContain('1 computer packed away');
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
});
