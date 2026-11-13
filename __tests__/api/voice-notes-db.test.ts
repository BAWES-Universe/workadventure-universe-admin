/**
 * Voice notes for every bot against a real database (game: every bot hears voice notes): what only the database can show. A
 * note is reserved before anything is paid, once however often it is asked, never past a limit however many come at once; each
 * paid stage is run by one bot server, a late one is fenced out and an expired lease is never a free retry; hearing that was done
 * stays counted; a lost answer comes back once and is deleted when the device has it; and the provider's copies are deleted until
 * it confirms. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/voice-notes-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { saveVoiceLimits } from '@/lib/voice-limits';
import { leaseVoiceNoteStage, recordVoiceNote, reserveVoiceNote, type Reservation } from '@/lib/voice-note-turns';
import { addVoiceNoteCleanup, claimVoiceNoteCleanups, settleVoiceNoteCleanup } from '@/lib/voice-note-cleanups';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
const universes: string[] = [];
const providers: string[] = [];
let makerId = '';
let botId = '';
let roomUrl = '';
let settingBefore: { value: unknown } | null = null;
let defaultsBefore: string[] = [];

const ADAPTERS = ['soniox'];
const turnId = () => `turn-${randomUUID()}`;
const reserveFor = (botForTurn: string, userId: string, changes: Record<string, unknown> = {}) =>
  reserveVoiceNote({ scope: 'bot', botId: botForTurn, userId, isGuest: true, clientTurnId: turnId(), contentHash: randomUUID(), seconds: 60, adapters: ADAPTERS, source: 'own-key', ...changes });
const reserve = (userId: string, changes: Record<string, unknown> = {}) => reserveFor(botId, userId, changes);
const guestBrick = (guestId: string, changes: Record<string, unknown> = {}) =>
  reserveVoiceNote({ scope: 'guest-brick', roomUrl, userId: guestId, clientTurnId: turnId(), contentHash: randomUUID(), seconds: 60, adapters: ADAPTERS, ...changes });
const turnOf = (reservation: Reservation) => {
  if (!reservation.ok) throw new Error(`not reserved: ${JSON.stringify(reservation)}`);
  return reservation.turn;
};
const today = () => new Date(new Date().toISOString().slice(0, 10));
const botDay = async (id = botId) => (await prisma.voiceListenUse.findUnique({ where: { botId_day: { botId: id, day: today() } } }))?.seconds ?? 0;

async function newBot(name: string) {
  const roomId = (await prisma.room.findFirstOrThrow({ where: { world: { universeId: universes[0] } }, select: { id: true } })).id;
  return (await prisma.bot.create({ data: { roomId, name, createdById: makerId } })).id;
}

run('voice notes for every bot, in a real database', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const maker = await prisma.user.create({ data: { uuid: `maker-${tag}`, email: `maker-${tag}@example.test`, name: 'Maker' } });
    people.push(maker.id);
    makerId = maker.id;
    const universe = await prisma.universe.create({ data: { slug: `notes-${tag}`, name: 'Notes', ownerId: makerId } });
    universes.push(universe.id);
    const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
    await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
    roomUrl = `https://play.example.test/@/${universe.slug}/hq/lobby`;
    // Universe AI's listening; any other default is set aside for these tests and put back after
    defaultsBefore = (await prisma.voiceProvider.findMany({ where: { ownerId: null, defaultRecognition: true }, select: { id: true } })).map((row) => row.id);
    await prisma.voiceProvider.updateMany({ where: { id: { in: defaultsBefore } }, data: { defaultRecognition: false } });
    const soniox = await prisma.voiceProvider.create({
      data: { adapter: 'soniox', name: `Soniox ${tag}`, recognition: true, enabled: true, apiKeyEncrypted: 'iv:tag:ua', defaultRecognition: true, models: [{ id: 'stt-rt-v3', kind: 'recognition' }] },
    });
    providers.push(soniox.id);
    botId = await newBot('Nora');
    settingBefore = await prisma.appSetting.findUnique({ where: { key: 'voice-limits' }, select: { value: true } });
    // Small numbers, so each case can fill them. Minutes: 3 for a person, 3 for a bot's day, 2 for a guest, 3 for a universe
    await saveVoiceLimits({ noteMinutesPerPerson: 3, listenMinutesPerDay: 60, guestNoteMinutesPerGuest: 2, guestNoteMinutesPerUniverse: 3, notesAtOnce: 1_000, noteMinutesPerHour: 100_000 }, makerId);
  });

  afterAll(async () => {
    if (settingBefore) await prisma.appSetting.update({ where: { key: 'voice-limits' }, data: { value: settingBefore.value as never } });
    else await prisma.appSetting.deleteMany({ where: { key: 'voice-limits' } });
    const bots = (await prisma.bot.findMany({ where: { createdById: makerId }, select: { id: true } })).map((row) => row.id);
    await prisma.voiceNoteTurn.deleteMany({ where: { OR: [{ botId: { in: bots } }, { universeKey: { in: universes } }] } });
    if (defaultsBefore.length) await prisma.voiceProvider.updateMany({ where: { id: { in: defaultsBefore } }, data: { defaultRecognition: true } });
    await prisma.voiceNoteCleanup.deleteMany({ where: { providerId: { in: providers } } });
    await prisma.voiceProvider.deleteMany({ where: { id: { in: providers } } });
    if (universes.length) await prisma.universe.deleteMany({ where: { id: { in: universes } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  describe('reserving', () => {
    it('counts a person\'s Universe AI note minutes and the bot\'s day, and says when it carries on', async () => {
      const sara = `sara-${randomUUID()}`;
      for (let n = 0; n < 3; n += 1) expect(await reserve(sara)).toMatchObject({ ok: true, replay: false, turn: { state: 'reserved', payer: 'universe-ai', seconds: 60 } });
      const refused = await reserve(sara);
      expect(refused).toMatchObject({ ok: false, reason: 'note-minutes', limit: 'person' });
      expect(new Date((refused as { resetsAt: string }).resetsAt).getTime()).toBeGreaterThan(Date.now());
      // Another person still has theirs
      expect(await reserve(`omar-${randomUUID()}`)).toMatchObject({ ok: true });
    });

    it('never passes a person\'s minutes when many notes come at the same moment', async () => {
      const omar = `omar-${randomUUID()}`;
      const answers = await Promise.all(Array.from({ length: 10 }, () => reserve(omar)));
      expect(answers.filter((answer) => answer.ok)).toHaveLength(3);
      expect(await prisma.voiceNoteTurn.aggregate({ _sum: { seconds: true }, where: { personKey: `guest:${omar}` } })).toMatchObject({ _sum: { seconds: 180 } });
    });

    it('is the same turn when asked again, never reserved twice, and refuses the same id with other contents', async () => {
      const lina = `lina-${randomUUID()}`;
      const clientTurnId = turnId();
      const first = turnOf(await reserve(lina, { clientTurnId, contentHash: 'note-a' }));
      const before = await botDay();
      expect(await reserve(lina, { clientTurnId, contentHash: 'note-a' })).toMatchObject({ ok: true, replay: true, turn: { id: first.id } });
      expect(await botDay()).toBe(before);
      await expect(reserve(lina, { clientTurnId, contentHash: 'note-b' })).rejects.toMatchObject({ status: 409 });
    });

    it('stops at the bot\'s daily listening, which group listening counts on too', async () => {
      const quiet = await newBot('Quiet');
      await prisma.voiceListenUse.create({ data: { botId: quiet, day: today(), seconds: 3_600 } });
      expect(await reserveFor(quiet, `noor-${randomUUID()}`)).toMatchObject({ ok: false, reason: 'note-minutes', limit: 'bot' });
    });

    it('stops at the hour\'s minutes and the notes heard at once, for everyone, with "busy"', async () => {
      await saveVoiceLimits({ notesAtOnce: 1 }, makerId);
      try {
        // Notes reserved a moment ago by others are still starting
        expect(await reserve(`a-${randomUUID()}`)).toMatchObject({ ok: false, reason: 'busy' });
      } finally {
        await saveVoiceLimits({ notesAtOnce: 1_000 }, makerId);
      }
    });

    it('counts the Brick for guests on a guest\'s own minutes and their universe\'s', async () => {
      const g1 = `g1-${randomUUID()}`;
      expect(await guestBrick(g1)).toMatchObject({ ok: true, turn: { payer: 'universe-ai' } });
      expect(await guestBrick(g1)).toMatchObject({ ok: true });
      expect(await guestBrick(g1)).toMatchObject({ ok: false, reason: 'note-minutes', limit: 'person' });
      expect(await guestBrick(`g2-${randomUUID()}`)).toMatchObject({ ok: true });
      expect(await guestBrick(`g3-${randomUUID()}`)).toMatchObject({ ok: false, reason: 'note-minutes', limit: 'universe' });
    });

    it('refuses a note longer than the longest voice note, read live from the Limits page, and a length nobody measured', async () => {
      // Room in the person's and the bot's minutes, so only the length decides
      const quiet = await newBot('Long');
      const ask = (seconds: unknown) => reserveFor(quiet, `x-${randomUUID()}`, { seconds });
      await saveVoiceLimits({ noteMinutesPerPerson: 60 }, makerId);
      try {
        // 5 minutes by default, with the second the measurement may run over
        expect(await ask(301)).toMatchObject({ ok: true });
        expect(await ask(302)).toEqual({ ok: false, reason: 'too-long', longestSeconds: 300 });
        await saveVoiceLimits({ longestNoteSeconds: 60 }, makerId);
        expect(await ask(62)).toEqual({ ok: false, reason: 'too-long', longestSeconds: 60 });
        expect(await ask(61)).toMatchObject({ ok: true });
      } finally {
        await saveVoiceLimits({ longestNoteSeconds: 300, noteMinutesPerPerson: 3 }, makerId);
      }
      await expect(reserve(`x-${randomUUID()}`, { seconds: '60' })).rejects.toMatchObject({ status: 400 });
      await expect(reserve(`x-${randomUUID()}`, { seconds: 0 })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('running a turn', () => {
    const fresh = async () => turnOf(await reserve(`p-${randomUUID()}`));

    it('hears once, answers once, keeps the answer for a lost reply and deletes it when the device has it', async () => {
      const person = `p-${randomUUID()}`;
      const clientTurnId = turnId();
      const turn = turnOf(await reserve(person, { clientTurnId, contentHash: 'h' }));
      const hearing = await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS });
      expect(hearing).toMatchObject({ granted: true, generation: 1, hearing: { route: 'universe-ai', provider: { adapter: 'soniox' } } });
      // A second bot server at the same moment gets nothing
      expect(await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS })).toEqual({ granted: false, reason: 'held' });
      await recordVoiceNote(turn.id, { event: 'submitted', generation: 1, refs: { file: 'f-1', transcription: 't-1' } });
      await recordVoiceNote(turn.id, { event: 'heard', generation: 1, transcript: 'Where is the coffee?', seconds: 58 });

      const answer = await leaseVoiceNoteStage(turn.id, { stage: 'answer' });
      expect(answer).toMatchObject({ granted: true, generation: 2, transcript: 'Where is the coffee?' });
      await recordVoiceNote(turn.id, { event: 'answered', generation: 2, answer: 'Second row.' });

      // The reply got lost: the same turn gives the same answer, with nothing run again
      expect(await reserve(person, { clientTurnId, contentHash: 'h' })).toMatchObject({ ok: true, replay: true, answer: { transcript: 'Where is the coffee?', answer: 'Second row.' } });
      const row = await prisma.voiceNoteTurn.findUniqueOrThrow({ where: { id: turn.id } });
      expect(row.buffer).not.toContain('coffee');
      expect(row).toMatchObject({ heardSeconds: 58, seconds: 60 });

      await recordVoiceNote(turn.id, { event: 'delivered' });
      expect(await prisma.voiceNoteTurn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ state: 'delivered', buffer: null });
      expect(await reserve(person, { clientTurnId, contentHash: 'h' })).toMatchObject({ ok: true, turn: { state: 'delivered' } });
    });

    it('fences out a bot server whose lease was taken over', async () => {
      const turn = await fresh();
      await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS });
      await prisma.voiceNoteTurn.update({ where: { id: turn.id }, data: { leaseUntil: new Date(Date.now() - 1_000), providerRefs: { transcription: 't-9' } } });
      // Another picks it up: its provider ids are known, so it looks the hearing up instead of sending the note again
      expect(await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS })).toMatchObject({ granted: true, generation: 2, reconcile: { transcription: 't-9' } });
      await expect(recordVoiceNote(turn.id, { event: 'heard', generation: 1, transcript: 'late' })).rejects.toMatchObject({ status: 409 });
      await recordVoiceNote(turn.id, { event: 'heard', generation: 2, transcript: 'on time' });
    });

    it('never sends a note again when nobody knows whether the provider got it', async () => {
      const turn = await fresh();
      await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS });
      await prisma.voiceNoteTurn.update({ where: { id: turn.id }, data: { leaseUntil: new Date(Date.now() - 1_000) } });
      expect(await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS })).toEqual({ granted: false, reason: 'uncertain' });
      expect(await prisma.voiceNoteTurn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ state: 'uncertain', released: false });
    });

    it('gives back a reservation the provider never charged for, and keeps one it may have', async () => {
      const turn = await fresh();
      const before = await botDay();
      await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS });
      await recordVoiceNote(turn.id, { event: 'hearing-failed', generation: 1, charged: 'no' });
      expect(await prisma.voiceNoteTurn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ state: 'failed', released: true });
      expect(await botDay()).toBe(before - 60);

      const timedOut = await fresh();
      await leaseVoiceNoteStage(timedOut.id, { stage: 'hearing', adapters: ADAPTERS });
      await recordVoiceNote(timedOut.id, { event: 'hearing-failed', generation: 1, charged: 'unknown' });
      expect(await prisma.voiceNoteTurn.findUniqueOrThrow({ where: { id: timedOut.id } })).toMatchObject({ state: 'failed', released: false });
    });

    it('tries the answer again from the words heard, never hearing the note again, and keeps the hearing counted', async () => {
      const turn = await fresh();
      await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS });
      await recordVoiceNote(turn.id, { event: 'heard', generation: 1, transcript: 'Hello' });
      await leaseVoiceNoteStage(turn.id, { stage: 'answer' });
      await recordVoiceNote(turn.id, { event: 'answer-failed', generation: 2 });
      expect(await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS })).toEqual({ granted: false, reason: 'heard' });
      expect(await leaseVoiceNoteStage(turn.id, { stage: 'answer' })).toMatchObject({ granted: true, generation: 3, transcript: 'Hello' });
      expect(await prisma.voiceNoteTurn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ released: false });
    });

    it('says an answer is no longer kept after its 15 minutes', async () => {
      const person = `p-${randomUUID()}`;
      const clientTurnId = turnId();
      const turn = turnOf(await reserve(person, { clientTurnId, contentHash: 'h' }));
      await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS });
      await recordVoiceNote(turn.id, { event: 'heard', generation: 1, transcript: 'Hi' });
      await leaseVoiceNoteStage(turn.id, { stage: 'answer' });
      await recordVoiceNote(turn.id, { event: 'answered', generation: 2, answer: 'Hello!' });
      await prisma.voiceNoteTurn.update({ where: { id: turn.id }, data: { bufferUntil: new Date(Date.now() - 1_000) } });
      expect(await reserve(person, { clientTurnId, contentHash: 'h' })).toEqual({ ok: false, reason: 'expired' });
    });

    it('never hears with Universe AI once it is turned off after the reservation, and gives the reservation back', async () => {
      const turn = await fresh();
      await prisma.voiceProvider.update({ where: { id: providers[0] }, data: { enabled: false } });
      try {
        expect(await leaseVoiceNoteStage(turn.id, { stage: 'hearing', adapters: ADAPTERS })).toEqual({ granted: false, reason: 'no-hearing' });
        expect(await prisma.voiceNoteTurn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ state: 'failed', released: true });
      } finally {
        await prisma.voiceProvider.update({ where: { id: providers[0] }, data: { enabled: true } });
      }
    });
  });

  describe('deleting what the provider still holds', () => {
    it('hands each job to one bot server once, and is done on a 2xx or 404', async () => {
      const object = randomUUID();
      const file = await addVoiceNoteCleanup({ providerId: providers[0], kind: 'file', objectId: `f-${object}` });
      const transcription = await addVoiceNoteCleanup({ providerId: providers[0], kind: 'transcription', objectId: `t-${object}` });
      expect(await addVoiceNoteCleanup({ providerId: providers[0], kind: 'file', objectId: `f-${object}` })).toEqual(file);
      const [first, second] = await Promise.all([claimVoiceNoteCleanups({ limit: 50 }), claimVoiceNoteCleanups({ limit: 50 })]);
      const handed = [...first, ...second].filter((job) => job.id === file.id || job.id === transcription.id);
      expect(handed.map((job) => job.id).sort()).toEqual([file.id, transcription.id].sort());
      expect(handed[0].provider).toMatchObject({ adapter: 'soniox', apiKeyEncrypted: 'iv:tag:ua' });
      expect(await settleVoiceNoteCleanup(transcription.id, { status: 204 })).toMatchObject({ state: 'done' });
      expect(await settleVoiceNoteCleanup(file.id, { status: 404 })).toMatchObject({ state: 'done' });
    });

    it('tries a 409 again in 30 seconds and anything else later each time, and tells the engineers once after a day', async () => {
      const job = await addVoiceNoteCleanup({ providerId: providers[0], kind: 'transcription', objectId: `t-${randomUUID()}` });
      const now = new Date();
      const busy = await settleVoiceNoteCleanup(job.id, { status: 409 }, now);
      expect(new Date(busy.nextAt!).getTime() - now.getTime()).toBe(30_000);
      const first = await settleVoiceNoteCleanup(job.id, { status: 500 }, now);
      const second = await settleVoiceNoteCleanup(job.id, { failed: true }, now);
      expect(new Date(second.nextAt!).getTime() - now.getTime()).toBeGreaterThan(new Date(first.nextAt!).getTime() - now.getTime());
      const later = new Date(now.getTime() + 25 * 60 * 60_000);
      await settleVoiceNoteCleanup(job.id, { status: 429 }, later);
      await settleVoiceNoteCleanup(job.id, { status: 429 }, later);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('sets aside a job whose provider is gone', async () => {
      const gone = await prisma.voiceProvider.create({ data: { adapter: 'soniox', name: `Gone ${tag}`, recognition: true, enabled: true, models: [] } });
      providers.push(gone.id);
      const job = await addVoiceNoteCleanup({ providerId: gone.id, kind: 'file', objectId: `f-${randomUUID()}` });
      const jobs = await claimVoiceNoteCleanups({ limit: 50 });
      expect(jobs.some((handed) => handed.id === job.id)).toBe(false);
      expect(await prisma.voiceNoteCleanup.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'orphaned' });
    });
  });
});
