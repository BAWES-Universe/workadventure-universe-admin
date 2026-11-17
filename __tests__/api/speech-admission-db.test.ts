/**
 * The speech admission contract against a real database (docs/speech-admission-contract.md, billing consensus v2, Brief F): one funded
 * utterance from admission to receipt under one id, a hold released by its event and never by time, a missing receipt that stays counted,
 * live hearing in windows, the five reasons kept apart, own keys never counted, and every number a saved setting that changes the very next
 * admission. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

import { prisma } from '@/lib/db';
import { saveMeterSettings, recordMeterEvent } from '@/lib/meter';
import { checkVoiceAllowance, releaseVoiceReply } from '@/lib/voice-allowance';
import { admitHearingWindow, releaseHearingWindow } from '@/lib/voice-hearing-window';
import { readSpeechFields, recordSpeechReceipt, replyEventId } from '@/lib/speech-receipts';
import { reconcileSpeech, resolveSpeechHold, speechStatus } from '@/lib/speech-status';
import { speechReserved } from '@/lib/speech-reserved';
import { speechSpent } from '@/lib/speech-cap';
import { getRateCard, saveRateCard } from '@/lib/speech-rates';
import { saveSpeechTerms } from '@/lib/speech-terms';
import { memberAllowance } from '@/lib/meter-allowance';
import { getMeterSettings } from '@/lib/meter';
import type { MeterEventInput } from '@/lib/meter-values';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
// A month of its own, far from any real one
const A = new Date('2031-06-15T12:00:00Z');
const later = (seconds: number) => new Date(A.getTime() + seconds * 1000);
let makerId = '';
let botId = '';
let universeId = '';
let personUuid = '';
const saved: Record<string, { value: unknown } | null> = {};
const KEYS = ['meter', 'speech-rates', 'speech-terms', 'speech-provider-funds'];

const turn = () => `turn-${randomUUID()}`;
const heldAt = async (now: Date) => (await prisma.$transaction((tx) => speechReserved(tx, { personKey: null, replySeconds: 60, now }))).all;
const admit = (turnId: string, over: Record<string, unknown> = {}, now: Date = A) => checkVoiceAllowance(botId, { userId: `guest-${tag}`, isGuest: true, turnId, contract: 2, ...over }, now);
const speakingEvent = (turnId: string | null, over: Partial<MeterEventInput> = {}): MeterEventInput => ({
  eventId: `game-${randomUUID()}`,
  kind: 'speech',
  pool: 'chat',
  occurredAt: A,
  personKey: `guest:guest-${tag}`,
  personId: null,
  botId,
  brick: false,
  payerKind: 'universe',
  payerPersonId: null,
  route: 'universe-ai',
  jobId: null,
  quantity: 12,
  unit: 'second',
  costMicros: null,
  basis: 'unknown',
  sourceRef: null,
  detail: { part: 'speaking', ...(turnId ? {} : {}) },
  ...over,
});
const receipt = (turnId: string, over: Partial<MeterEventInput> = {}, extra: Record<string, unknown> = {}, now: Date = later(30)) =>
  recordSpeechReceipt(speakingEvent(turnId, over), readSpeechFields({ turnId, contract: 2, ...extra }), now);
const eventsOf = (turnId: string) => prisma.meterEvent.findMany({ where: { eventId: replyEventId(botId, turnId) } });

const setBudget = (micros: number | null, memberSeconds: number | null = 1_000_000) => saveMeterSettings({ speechBudgetMicros: micros, speechMemberCeilingSeconds: memberSeconds }, makerId);

run('the speech admission contract, in a real database', () => {
  beforeAll(async () => {
    for (const key of KEYS) saved[key] = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    const maker = await prisma.user.create({ data: { uuid: `maker-${tag}`, email: `maker-${tag}@example.test`, name: 'Maker' } });
    makerId = maker.id;
    personUuid = `person-${tag}`;
    await prisma.user.create({ data: { uuid: personUuid, email: `person-${tag}@example.test`, name: 'Person' } });
    const universe = await prisma.universe.create({ data: { slug: `adm-${tag}`, name: 'Admission', ownerId: makerId } });
    universeId = universe.id;
    const world = await prisma.world.create({ data: { universeId, slug: 'hq', name: 'HQ' } });
    const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
    botId = (await prisma.bot.create({ data: { roomId: room.id, name: 'Nora', createdById: makerId } })).id;
  });
  afterAll(async () => {
    await prisma.meterEvent.deleteMany({ where: { botId } });
    await prisma.voiceReplyUse.deleteMany({ where: { botId } });
    await prisma.voiceHearingWindow.deleteMany({ where: { botId } });
    for (const key of KEYS) {
      const before = saved[key];
      if (before) await prisma.appSetting.upsert({ where: { key }, create: { key, value: before.value as never }, update: { value: before.value as never } });
      else await prisma.appSetting.deleteMany({ where: { key } });
    }
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.user.deleteMany({ where: { uuid: { in: [`maker-${tag}`, personUuid] } } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.meterEvent.deleteMany({ where: { botId } });
    await prisma.voiceReplyUse.deleteMany({ where: { botId } });
    await prisma.voiceHearingWindow.deleteMany({ where: { botId } });
    await prisma.appSetting.deleteMany({ where: { key: 'speech-provider-funds' } });
    await setBudget(10_000_000);
  });

  describe('one utterance, from admission to receipt', () => {
    it('admits a reply with what it sets aside, and a receipt with the same turn id settles it: counted once, priced at the version admitted, never 0', async () => {
      const id = turn();
      const answer = await admit(id);
      expect(answer).toMatchObject({ allowed: true, admission: { contract: 2, turnId: id } });
      const admission = (answer as { admission: { rateVersion: number; admittedSeconds: number; maxSeconds: number; admittedMicros: number } }).admission;
      // The member estimate is the usual length; Universe's exposure is the enforceable longest reply, in money
      expect(admission.admittedSeconds).toBeLessThanOrEqual(admission.maxSeconds);
      expect(admission.admittedMicros).toBeGreaterThan(0);
      expect((await heldAt(later(5))).openMicros).toBe(admission.admittedMicros);

      const first = await receipt(id, { quantity: 12 }, { admission: { rateVersion: admission.rateVersion, admittedSeconds: admission.admittedSeconds, admittedMicros: admission.admittedMicros } });
      expect(first).toMatchObject({ recorded: true, conflict: false, admission: 'settled', eventId: replyEventId(botId, id) });
      const [event] = await eventsOf(id);
      expect(event).toMatchObject({ kind: 'speech', payerKind: 'universe', quantity: BigInt(12), basis: 'estimated' });
      expect(Number(event.costMicros)).toBeGreaterThan(0);
      expect(event.detail).toMatchObject({ turnId: id, rateVersion: admission.rateVersion });
      // The hold went when the event arrived: what was set aside is now what was spent
      expect(await heldAt(later(31))).toMatchObject({ openMicros: 0, unknownMicros: 0 });
      expect(await prisma.voiceReplyUse.findUniqueOrThrow({ where: { botId_turnId: { botId, turnId: id } } })).toMatchObject({ settledSeconds: 12 });
    });

    it('counts the same utterance once however often and under whatever event id it is sent, and a different figure for the same turn adds nothing', async () => {
      const id = turn();
      await admit(id);
      expect(await receipt(id, { quantity: 12 })).toMatchObject({ recorded: true, admission: 'settled' });
      expect(await receipt(id, { quantity: 12 })).toMatchObject({ recorded: false, conflict: false, admission: 'already_settled' });
      // A game restarted: the same turn under another event id is still the same utterance
      expect(await receipt(id, { quantity: 12, eventId: `restart-${randomUUID()}` })).toMatchObject({ recorded: false, admission: 'already_settled' });
      // The same turn with other figures is a conflict, and adds nothing
      expect(await receipt(id, { quantity: 30 })).toMatchObject({ recorded: false, conflict: true });
      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0].quantity).toBe(BigInt(12));
    });

    it('counts a receipt for a reply nobody admitted (an older game, or a restart that lost it), and says so', async () => {
      const id = turn();
      expect(await receipt(id)).toMatchObject({ recorded: true, admission: 'no_admission' });
      expect((await eventsOf(id)).length).toBe(1);
      // An event with no turn id at all (an old game) is counted as it always was
      const old = await recordSpeechReceipt(speakingEvent(null, { eventId: `old-${randomUUID()}` }), readSpeechFields({}), later(30));
      expect(old).toMatchObject({ recorded: true, admission: 'not_applicable' });
    });

    it('gives a reply that was never spoken back with its release, once', async () => {
      const id = turn();
      await admit(id);
      expect((await heldAt(later(5))).openMicros).toBeGreaterThan(0);
      expect(await releaseVoiceReply(botId, { turnId: id })).toEqual({ released: true });
      expect(await heldAt(later(5))).toMatchObject({ openMicros: 0, unknownMicros: 0 });
      expect(await releaseVoiceReply(botId, { turnId: id })).toEqual({ released: false });
    });

    it('never releases a hold that was settled by its receipt', async () => {
      const id = turn();
      await admit(id);
      await receipt(id);
      expect(await releaseVoiceReply(botId, { turnId: id })).toEqual({ released: false });
      expect(await eventsOf(id)).toHaveLength(1);
    });
  });

  describe('a hold is released by its event, never by time', () => {
    it('keeps a reply with no receipt counted: open while it could still be speaking, unknown after, through a day and the reconcile pass, until its receipt arrives', async () => {
      const id = turn();
      const admission = (await admit(id) as { admission: { admittedMicros: number; maxSeconds: number } }).admission;
      // Past the longest reply and the grace, hours later, with nothing sent: still counted, now as unknown
      const hours = later(6 * 3_600);
      expect(await heldAt(hours)).toMatchObject({ openMicros: 0, unknownMicros: admission.admittedMicros });
      const report = await reconcileSpeech(hours);
      expect(report.status.unknownMicros).toBeGreaterThanOrEqual(admission.admittedMicros);
      expect(await heldAt(hours)).toMatchObject({ unknownMicros: admission.admittedMicros });
      expect(await prisma.voiceReplyUse.findUniqueOrThrow({ where: { botId_turnId: { botId, turnId: id } } })).toMatchObject({ settledAt: null });
      // It fills the budget while unknown: waiting never frees it ("budget", not "hold")
      await setBudget(admission.admittedMicros + admission.admittedMicros - 1);
      expect(await admit(turn(), {}, hours)).toMatchObject({ allowed: false, stoppedBy: 'budget' });
      // The receipt settles it, whenever it comes: the money is spent, no longer unknown
      expect(await receipt(id, { quantity: 20, occurredAt: A }, {}, hours)).toMatchObject({ admission: 'settled' });
      expect(await heldAt(hours)).toMatchObject({ openMicros: 0, unknownMicros: 0 });
    });

    it('lets a super admin end a hold whose receipt never came, as released or as charged, once', async () => {
      const gone = turn();
      const lost = turn();
      await admit(gone);
      await admit(lost);
      expect(await resolveSpeechHold({ botId, turnId: gone, outcome: 'release' }, later(7_200))).toEqual({ ok: true, outcome: 'released' });
      expect(await resolveSpeechHold({ botId, turnId: gone, outcome: 'release' }, later(7_200))).toEqual({ ok: true, outcome: 'already_settled' });
      expect(await resolveSpeechHold({ botId, turnId: lost, outcome: 'charge' }, later(7_200))).toEqual({ ok: true, outcome: 'charged' });
      expect(await eventsOf(gone)).toHaveLength(0);
      const [charged] = await eventsOf(lost);
      expect(charged).toMatchObject({ basis: 'estimated' });
      expect(Number(charged.costMicros)).toBeGreaterThan(0);
      expect(await heldAt(later(7_200))).toMatchObject({ openMicros: 0, unknownMicros: 0 });
      expect(await resolveSpeechHold({ botId, turnId: turn(), outcome: 'release' })).toEqual({ ok: false, error: 'not_found' });
    });

    it('holds a version-1 reply (an older game with no receipt id) for the saved time, then lets it go: no receipt can name it', async () => {
      const id = turn();
      expect(await checkVoiceAllowance(botId, { userId: `guest-${tag}`, isGuest: true, turnId: id }, A)).not.toHaveProperty('admission');
      expect((await heldAt(later(60))).openMicros).toBeGreaterThan(0);
      // The saved legacy hold time (600 s) is read on every check
      expect(await heldAt(later(601))).toMatchObject({ openMicros: 0, unknownMicros: 0 });
      await saveSpeechTerms({ legacyHoldSeconds: 1_800 }, makerId);
      expect((await heldAt(later(601))).openMicros).toBeGreaterThan(0);
    });

    it('counts the month a reply happened in, and does not carry an earlier month’s hold into the next', async () => {
      const id = turn();
      await admit(id);
      const nextMonth = new Date('2031-07-02T00:00:00Z');
      expect(await heldAt(nextMonth)).toMatchObject({ openMicros: 0, unknownMicros: 0 });
      // Its receipt, late, is counted in the month it occurred in and settles the old hold
      expect(await receipt(id, { occurredAt: A }, {}, nextMonth)).toMatchObject({ admission: 'settled' });
      const june = await speechSpent(prisma, await getRateCard(prisma), A);
      const july = await speechSpent(prisma, await getRateCard(prisma), nextMonth);
      expect(june.seconds).toBe(12);
      expect(july.seconds).toBe(0);
    });
  });

  describe('live hearing in windows', () => {
    it('admits a window once for the same id, uses it up with hearing events, and gives back what was not used', async () => {
      const windowId = `w-${randomUUID()}`;
      const first = await admitHearingWindow(botId, { userId: `guest-${tag}`, isGuest: true, windowId }, A);
      expect(first).toMatchObject({ allowed: true, windowId, admittedSeconds: expect.any(Number), renewAfterSeconds: expect.any(Number) });
      const again = await admitHearingWindow(botId, { userId: `guest-${tag}`, isGuest: true, windowId }, later(5));
      expect(again).toEqual(first);
      expect(await prisma.voiceHearingWindow.count({ where: { botId, windowId } })).toBe(1);
      const held = (await heldAt(later(6))).openMicros;
      expect(held).toBe((first as { admittedMicros: number }).admittedMicros);

      // Hearing heard in the window reduces what it holds
      const heard = await recordSpeechReceipt(
        speakingEvent(null, { eventId: `hear-${randomUUID()}`, quantity: 20, detail: { part: 'hearing' } }),
        readSpeechFields({ windowId, contract: 2 }),
        later(25),
      );
      expect(heard).toMatchObject({ recorded: true, admission: 'settled' });
      expect((await heldAt(later(26))).openMicros).toBeLessThan(held);
      expect((await prisma.voiceHearingWindow.findFirstOrThrow({ where: { botId, windowId } })).usedSeconds).toBe(20);

      // Given back when the call ends: safe to send twice; what was heard stays in the books
      expect(await releaseHearingWindow(botId, { windowId }, later(30))).toEqual({ released: true });
      expect(await releaseHearingWindow(botId, { windowId }, later(30))).toEqual({ released: false });
      expect(await heldAt(later(31))).toMatchObject({ openMicros: 0, unknownMicros: 0 });
      expect((await speechSpent(prisma, await getRateCard(prisma), A)).seconds).toBe(20);
    });

    it('keeps a window never released and never used counted as unknown, until it is reconciled', async () => {
      const windowId = `w-${randomUUID()}`;
      const w = (await admitHearingWindow(botId, { userId: `guest-${tag}`, isGuest: true, windowId }, A)) as { admittedMicros: number };
      const hours = later(5 * 3_600);
      expect(await heldAt(hours)).toMatchObject({ openMicros: 0, unknownMicros: w.admittedMicros });
      await reconcileSpeech(hours);
      expect((await heldAt(hours)).unknownMicros).toBe(w.admittedMicros);
    });

    it('refuses the next window with the reason, so the game can say why it stopped hearing', async () => {
      await setBudget(0);
      expect(await admitHearingWindow(botId, { userId: `guest-${tag}`, isGuest: true, windowId: `w-${randomUUID()}` }, A)).toMatchObject({ allowed: false, stoppedBy: 'budget' });
      expect(await prisma.voiceHearingWindow.count({ where: { botId } })).toBe(0);
    });
  });

  describe('the five reasons, kept apart', () => {
    it('person: the person’s own entitlement is used up, while the platform budget has room', async () => {
      await setBudget(10_000_000, 1);
      expect(await admit(turn(), { userId: personUuid, isGuest: false })).toMatchObject({ allowed: false, stoppedBy: 'person' });
      // Someone nobody could name has no entitlement of their own to be used up
      expect(await admit(turn(), { userId: undefined })).toMatchObject({ allowed: true });
    });

    it('budget: the platform Speech budget is spent, and says no number', async () => {
      await setBudget(1);
      const refused = await admit(turn());
      expect(refused).toMatchObject({ allowed: false, stoppedBy: 'budget', resetsAt: '2031-07-01T00:00:00.000Z' });
      expect(JSON.stringify(refused)).not.toMatch(/micros|budget":|balance/i);
    });

    it('hold: it would fit if what is only set aside were released, and waiting helps', async () => {
      const firstId = turn();
      const first = (await admit(firstId)) as { admission: { admittedMicros: number } };
      await setBudget(first.admission.admittedMicros + first.admission.admittedMicros - 1);
      const refused = await admit(turn(), {}, later(2));
      expect(refused).toMatchObject({ allowed: false, stoppedBy: 'hold' });
      expect((refused as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
      // Once the first reply is over and its receipt in, there is room again
      await receipt(firstId, { quantity: 1 });
      expect(await admit(turn(), {}, later(40))).toMatchObject({ allowed: true });
    });

    it('provider: the voice company said its funds are out; new funded speech on it is stopped until it is back, and no one else’s is', async () => {
      const id = turn();
      await admit(id, { provider: 'elevenlabs' });
      await receipt(id, { quantity: 3 }, { provider: 'elevenlabs', providerStatus: 'funds_unavailable' });
      expect(await admit(turn(), { provider: 'elevenlabs' }, later(60))).toMatchObject({ allowed: false, stoppedBy: 'provider' });
      expect(await admitHearingWindow(botId, { userId: `guest-${tag}`, isGuest: true, windowId: `w-${randomUUID()}`, provider: 'elevenlabs' }, later(60))).toMatchObject({ allowed: false, stoppedBy: 'provider' });
      // Another company is not stopped
      expect(await admit(turn(), { provider: 'cartesia' }, later(60))).toMatchObject({ allowed: true });
      // It is back
      const back = turn();
      await receipt(back, { quantity: 1, eventId: `back-${randomUUID()}` }, { provider: 'elevenlabs', providerStatus: 'ok' });
      expect(await admit(turn(), { provider: 'elevenlabs' }, later(90))).toMatchObject({ allowed: true });
    });

    it('does not stop speech just because one reason was met by someone else: refusals carry allowed and resetsAt as before', async () => {
      await setBudget(1);
      expect(await admit(turn(), { contract: undefined })).toMatchObject({ allowed: false, resetsAt: expect.any(String), stoppedBy: 'budget' });
    });
  });

  describe('every number is a saved setting read on every check', () => {
    it('applies a changed budget, entitlement, rate and window length to the very next admission, with no restart', async () => {
      await setBudget(1);
      expect(await admit(turn())).toMatchObject({ allowed: false, stoppedBy: 'budget' });
      await setBudget(10_000_000);
      const cheap = (await admit(turn())) as { admission: { rateVersion: number; admittedMicros: number } };
      expect(cheap).toMatchObject({ allowed: true });
      // A changed price is a new rate version; the next admission records it, and a receipt for the old one is priced at the old one
      const oldId = turn();
      const old = (await admit(oldId)) as { admission: { rateVersion: number; admittedMicros: number } };
      const card = (await getRateCard(prisma))!;
      const next = await saveRateCard({ rates: card.rates.map((rate) => (rate.job === 'speaking' ? { ...rate, microsPerUnit: rate.microsPerUnit * 2 } : rate)) }, makerId);
      expect(next.version).toBe(card.version + 1);
      const dearer = (await admit(turn())) as { admission: { rateVersion: number; admittedMicros: number } };
      expect(dearer.admission.rateVersion).toBe(next.version);
      expect(dearer.admission.admittedMicros).toBe(old.admission.admittedMicros * 2);
      await receipt(oldId, { quantity: 10 });
      const [event] = await eventsOf(oldId);
      expect(event.detail).toMatchObject({ rateVersion: old.admission.rateVersion });
      // The window length is a saved term too
      await saveSpeechTerms({ hearingWindowSeconds: 30 }, makerId);
      expect(await admitHearingWindow(botId, { userId: `guest-${tag}`, isGuest: true, windowId: `w-${randomUUID()}` }, A)).toMatchObject({ allowed: true, admittedSeconds: 30 });
      await saveSpeechTerms({ hearingWindowSeconds: 90 }, makerId);
      expect(await admitHearingWindow(botId, { userId: `guest-${tag}`, isGuest: true, windowId: `w-${randomUUID()}` }, A)).toMatchObject({ allowed: true, admittedSeconds: 90 });
      await setBudget(10_000_000, 1);
      expect(await admit(turn(), { userId: personUuid, isGuest: false })).toMatchObject({ allowed: false, stoppedBy: 'person' });
    });

    it('stops speech that needs a setting nobody has saved, rather than assuming one', async () => {
      const terms = await prisma.appSetting.findUniqueOrThrow({ where: { key: 'speech-terms' } });
      await prisma.appSetting.deleteMany({ where: { key: 'speech-terms' } });
      try {
        expect(await admitHearingWindow(botId, { userId: `guest-${tag}`, isGuest: true, windowId: `w-${randomUUID()}` }, A)).toMatchObject({ allowed: false });
      } finally {
        await prisma.appSetting.create({ data: { key: 'speech-terms', value: terms.value as never } });
      }
    });
  });

  describe('what speech pausing leaves alone', () => {
    it('never counts speech on an owner’s own key, and never stops the text and computer allowances when speech is paused', async () => {
      const own = await recordMeterEvent({ ...speakingEvent(null, { eventId: `own-${randomUUID()}`, quantity: 3_600, payerKind: 'person', costMicros: 900_000 }) });
      expect(own.recorded).toBe(true);
      expect((await speechSpent(prisma, await getRateCard(prisma), A)).micros).toBe(0);
      // A paused speech budget leaves the money allowance of a member (computers, apps) as it was
      await saveMeterSettings({ memberAllowanceMicros: 250_000 }, makerId);
      const before = await memberAllowance(makerId, A, await getMeterSettings());
      await setBudget(0);
      expect(await admit(turn())).toMatchObject({ allowed: false, stoppedBy: 'budget' });
      expect(await memberAllowance(makerId, A, await getMeterSettings())).toEqual(before);
    });

    it('tells the Budget page what is spent, set aside and unknown, and nothing a visitor could use', async () => {
      const id = turn();
      await admit(id);
      const status = await speechStatus(later(6 * 3_600));
      expect(status.unknownMicros).toBeGreaterThan(0);
    });
  });
});
