import crypto from 'crypto';
import { Prisma, type VoiceNoteTurn } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getVoiceLimits } from '@/lib/voice-limits';
import { VOICE_RANGES, savedVoiceKeyLimits } from '@/lib/voice-limit-values';
import { checkReplyAllowance, type ReplyAllowance } from '@/lib/reply-limits';
import { resolveUsagePerson } from '@/lib/usage-person';
import { placeFor } from '@/lib/guest-brick';
import { botHearing, universeAiHearing, type NoteHearing } from '@/lib/voice-note-hearing';
import { BotSettingsError } from '@/lib/bot-access-settings';

/**
 * Voice note turns (game: every bot hears voice notes, plan v3 sections 2 to 4). The bot server measures a note's real length for
 * free, then asks here before anything is paid:
 *
 * 1. `reserveVoiceNote`: who pays is fixed (lib/voice-note-hearing.ts), the person's reply is checked when the bot answers on
 *    Universe AI, and the note's seconds are reserved on every pool that applies in one go, under one lock, so two bot servers
 *    never both take the last minute:
 *    - Universe AI hearing: the person's note minutes for the day (a guest's on the Brick for guests, and their universe's), the
 *      minutes Universe AI hears in an hour and the notes it hears at once, for everyone;
 *    - an owner's key: the bot's daily listening (the same minutes group listening counts on), stopped at the day the owner set on
 *      that key. A note Universe AI hears never counts on, or is stopped by, a bot's live listening.
 *    The same turn asked again is the same turn: never reserved twice, and its answer comes back while it is kept.
 * 2. `leaseVoiceNoteStage`: hearing and answering each run under a lease with a generation, so two bot servers never run the same
 *    paid step and a late one is fenced out. An expired lease is not a free retry: a hearing whose provider ids are known is looked
 *    up instead of sent again, anything else is "uncertain" and never sent again.
 * 3. `recordVoiceNote`: what happened. Hearing that was done stays counted when anything after it fails; only a reservation never
 *    used is given back. The words heard and the answer are kept encrypted for 15 minutes, for a reply that got lost, and deleted
 *    once the device has them.
 *
 * Never words or audio anywhere else: the rows hold who, which turn, seconds and cost.
 */

export class VoiceNoteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) {
    super(message);
  }
}

/**
 * The second a measured length may run over the longest note (Limits, Voice, "Longest voice note"): ffmpeg stops one second past
 * it, so a note right at the limit is not refused for rounding.
 */
export const MEASURE_SLACK_SECONDS = 1;
/** The most any length can be, whatever the setting: the setting's own top value and the slack. Only checks the number's shape. */
const LENGTH_CEILING = VOICE_RANGES.longestNoteSeconds.max + MEASURE_SLACK_SECONDS;
/** How long a bot server holds a stage before another may look at it. */
export const LEASE_MS = 2 * 60_000;
/** How long the words and answer of a turn are kept for a reply that got lost. */
export const BUFFER_MS = 15 * 60_000;
export const BUFFER_MAX_BYTES = 64 * 1024;
/** A note reserved this long ago and never started is no longer "being heard" for the notes-at-once count. */
const STARTING_MS = LEASE_MS;

/**
 * For a transaction that takes the reservations' lock: how long it may wait for a connection, and for the lock and its few reads
 * (each indexed). Past that it fails, and the bot server is told to try again, rather than holding a connection.
 */
const LOCKED = { maxWait: 5_000, timeout: 15_000 };

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const dayOf = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export type Scope = 'bot' | 'guest-brick';
export type TurnState = 'reserved' | 'hearing' | 'heard' | 'answering' | 'answered' | 'delivered' | 'failed' | 'uncertain';

// ---------------------------------------------------------------------------------------------------------------------
// Keys: one secret, a key for each use (HKDF), never the secret itself
// ---------------------------------------------------------------------------------------------------------------------

function secret(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY environment variable is not set');
  return key.length === 64 ? Buffer.from(key, 'hex') : Buffer.from(key, 'utf8');
}

const derive = (label: string, salt: string) => Buffer.from(crypto.hkdfSync('sha256', secret(), Buffer.from(salt, 'utf8'), Buffer.from(label, 'utf8'), 32));

/** A keyed hash of what a turn holds, so the same turn id with other contents is told apart without keeping the contents. */
export const fingerprintOf = (contentHash: string) => crypto.createHmac('sha256', derive('voice-note-fingerprint', 'v1')).update(contentHash).digest('hex');

interface Buffered {
  transcript: string;
  answer?: string;
}

/** Encrypted with a key for this turn alone: "iv.tag.data", base64url. */
export function sealBuffer(turnId: string, value: Buffered): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive('voice-note-buffer', turnId), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

export function openBuffer(turnId: string, sealed: string): Buffered | null {
  try {
    const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', derive('voice-note-buffer', turnId), iv);
    decipher.setAuthTag(tag);
    const value = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as Buffered;
    return typeof value.transcript === 'string' ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what the bot server sends
// ---------------------------------------------------------------------------------------------------------------------

const idOf = (value: unknown, name: string, max = 255): string => {
  if (typeof value !== 'string' || !value.trim()) throw new VoiceNoteError(`${name} is required`, 400);
  return value.trim().slice(0, max);
};

const wholeOf = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new VoiceNoteError(`${name} must be a whole number from ${min} to ${max}`, 400);
  return value;
};

const readAdapterList = (value: unknown): Set<string> => {
  if (!Array.isArray(value) || value.length > 20) throw new VoiceNoteError('adapters must be a list of the providers the bot server can send a file to', 400);
  return new Set(value.filter((name): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,48}$/.test(name)));
};

// ---------------------------------------------------------------------------------------------------------------------
// Reserving
// ---------------------------------------------------------------------------------------------------------------------

/** What the bot server sees of a turn. The words and answer only while they are kept. */
export interface TurnView {
  id: string;
  state: TurnState;
  payer: 'owner' | 'universe-ai';
  seconds: number;
}

export type Reservation =
  /** `answer` comes back for a turn already answered, while it is kept: send it, never run it again. */
  | { ok: true; turn: TurnView; replay: boolean; answer?: Buffered }
  /** The person's reply allowance is used up: the usual limit card, and nothing is heard. */
  | { ok: false; reason: 'reply-limit'; allowance: Extract<ReplyAllowance, { allowed: false }> }
  /**
   * Note minutes for the day are used up. `person`: the person's own (a guest's on the Brick for guests), the limit card.
   * `universe`: the universe's guests together on the Brick for guests. `bot`: the day the owner set on the key that hears it.
   */
  | { ok: false; reason: 'note-minutes'; limit: 'person' | 'universe' | 'bot'; resetsAt: string }
  /** Too many notes for everyone right now: "Couldn't listen to this note right now. Type it instead." */
  | { ok: false; reason: 'busy' }
  /** Nothing can hear this note: the mic should not have been there. */
  | { ok: false; reason: 'no-hearing' }
  /** The answer of this turn is no longer kept: "This answer is no longer available. Send it again." */
  | { ok: false; reason: 'expired' }
  /** Longer than the longest voice note (Limits, Voice), in seconds: "This note is over 5 minutes. Send a shorter one." */
  | { ok: false; reason: 'too-long'; longestSeconds: number };

const view = (turn: VoiceNoteTurn): TurnView => ({ id: turn.id, state: turn.state as TurnState, payer: turn.payer as TurnView['payer'], seconds: turn.seconds });

/** The same turn asked again: what it is now, with its answer while it is kept. Never reserved or paid again. */
function replay(turn: VoiceNoteTurn, now: Date): Reservation {
  if (turn.state === 'answered') {
    const kept = turn.buffer && turn.bufferUntil && turn.bufferUntil > now ? openBuffer(turn.id, turn.buffer) : null;
    if (!kept?.answer) return { ok: false, reason: 'expired' };
    return { ok: true, turn: view(turn), replay: true, answer: kept };
  }
  return { ok: true, turn: view(turn), replay: true };
}

/**
 * The daily listening limit a note counts on, in seconds, or null when none applies. Only the owner's own key that hears it, with
 * the limit the owner set on that key: the owner's money and the owner's limit. A note Universe AI hears is never stopped by a
 * bot's live listening ("Listening a day" is for live voice, and "Never" there must not stop notes): the person's note minutes,
 * the hour's minutes and the notes heard at once bound it instead, and it leaves the bot's live listening day alone.
 */
async function ownerKeyDayLimitSeconds(hearing: NoteHearing): Promise<number | null> {
  if (hearing.payer !== 'owner' || !hearing.provider) return null;
  const row = await prisma.voiceProvider.findUnique({ where: { id: hearing.provider.id }, select: { voiceLimits: true } });
  const minutes = savedVoiceKeyLimits(row?.voiceLimits).listenMinutesPerDay;
  return minutes === undefined || minutes === null ? null : Math.max(0, Math.round(minutes * 60));
}

/** Whether a turn's seconds are on its bot's listening day: notes an owner's key hears. */
const onBotDay = (turn: Pick<VoiceNoteTurn, 'botId' | 'payer'>) => Boolean(turn.botId) && turn.payer === 'owner';

/**
 * Reserves one voice note before anything is paid. `seconds` is the length the bot server measured from the audio itself (never the
 * header or the device's number). `contentHash` is the bot server's hash of what the turn holds (the note's file and version, the
 * text, the history it was sent with): the same `clientTurnId` with another hash is refused.
 */
export async function reserveVoiceNote(
  input: {
    scope?: unknown;
    botId?: unknown;
    roomUrl?: unknown;
    userId?: unknown;
    isGuest?: unknown;
    clientTurnId?: unknown;
    contentHash?: unknown;
    seconds?: unknown;
    adapters?: unknown;
    source?: unknown;
  },
  now: Date = new Date()
): Promise<Reservation> {
  const scope = input.scope;
  if (scope !== 'bot' && scope !== 'guest-brick') throw new VoiceNoteError('scope must be bot or guest-brick', 400);
  const userId = idOf(input.userId, 'userId');
  const clientTurnId = idOf(input.clientTurnId, 'clientTurnId');
  const contentHash = idOf(input.contentHash, 'contentHash', 128);
  const seconds = wholeOf(input.seconds, 'seconds', 1, LENGTH_CEILING);
  const adapters = readAdapterList(input.adapters);
  const fingerprint = fingerprintOf(contentHash);

  let personKey: string;
  let target: string;
  let botId: string | null = null;
  let universeKey: string | null = null;
  // An email is only ever a signed-in person's (lib/usage-person.ts), whatever the bot server said
  const signedIn = input.isGuest !== true || userId.includes('@');
  if (scope === 'bot') {
    botId = idOf(input.botId, 'botId', 64);
    const person = await resolveUsagePerson(userId, signedIn ? false : true);
    // A signed-in person Orbit could not look up just now is never filed as a guest: asked again once the lookup works, the same
    // note would be a second turn under another key, and be heard twice
    if (!person.personId && person.guest !== true) throw new VoiceNoteError('Who sent this note can\'t be looked up now', 503);
    personKey = person.personId ? `person:${person.personId}` : `guest:${userId}`;
    target = botId;
  } else {
    universeKey = (await placeFor(input.roomUrl)).universeKey;
    personKey = `guest:${userId}`;
    target = `gb:${universeKey}`;
  }
  // The same note from a signed-in person Orbit had no account for yet was filed under their guest key: it is still that turn
  const askedFor = (key: string): Prisma.VoiceNoteTurnWhereInput => ({ scope, target, clientTurnId, personKey: { in: key.startsWith('person:') ? [key, `guest:${userId}`] : [key] } });
  let asked = askedFor(personKey);
  const same = (turn: VoiceNoteTurn) => {
    if (turn.fingerprint !== fingerprint) throw new VoiceNoteError('This turn id was used for something else', 409);
    return replay(turn, now);
  };

  const earlier = await prisma.voiceNoteTurn.findFirst({ where: asked, orderBy: { createdAt: 'asc' } });
  if (earlier) return same(earlier);

  // Read now, so a change on the Limits page counts from the next note
  const { limits } = await getVoiceLimits();
  if (seconds > limits.longestNoteSeconds + MEASURE_SLACK_SECONDS) return { ok: false, reason: 'too-long', longestSeconds: limits.longestNoteSeconds };

  // Who pays is fixed here, for this attempt. Throws BotSettingsError(404) for a bot that isn't there
  const hearing = scope === 'bot' ? await botHearing(botId!, adapters) : await universeAiHearing(adapters);
  if (hearing.route === 'none' || !hearing.payer) return { ok: false, reason: 'no-hearing' };

  // The note and its answer are one reply, checked before anything is heard: the bot's own daily cap whatever it answers on, and
  // Universe AI's windows when it answers there (lib/reply-limits.ts skips those for a person's own key)
  if (scope === 'bot') {
    const source = input.source;
    if (source !== 'universe-ai' && source !== 'provider' && source !== 'own-key') throw new VoiceNoteError('source must be universe-ai, provider or own-key', 400);
    const allowance = await checkReplyAllowance(botId!, { userId, isGuest: input.isGuest, source }, now);
    if (!allowance.allowed) return { ok: false, reason: 'reply-limit', allowance };
  }

  const ownerDayLimit = scope === 'bot' ? await ownerKeyDayLimitSeconds(hearing) : null;
  const day = dayOf(now);
  const tomorrow = new Date(day.getTime() + DAY).toISOString();
  const universeAi = hearing.payer === 'universe-ai';

  return prisma.$transaction(async (tx): Promise<Reservation> => {
    // One lock for every reservation: they are short and few, and nothing can take the last minute twice
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('voice-note-reserve'))`);
    if (scope === 'bot' && personKey.startsWith('guest:') && signedIn) {
      // A signed-in person Orbit had no account for a moment ago: looked up again under the lock, so an ask that found the account
      // in the meantime and reserved this note under it is found here, and the note is never two turns
      const again = await resolveUsagePerson(userId, false);
      if (!again.personId && again.guest !== true) throw new VoiceNoteError('Who sent this note can\'t be looked up now', 503);
      if (again.personId) {
        personKey = `person:${again.personId}`;
        asked = askedFor(personKey);
      }
    }
    const raced = await tx.voiceNoteTurn.findFirst({ where: asked, orderBy: { createdAt: 'asc' } });
    if (raced) return same(raced);

    const counted = { released: false };
    const sum = async (where: Prisma.VoiceNoteTurnWhereInput) => (await tx.voiceNoteTurn.aggregate({ _sum: { seconds: true }, where: { ...counted, ...where } }))._sum.seconds ?? 0;
    const fits = (used: number, minutes: number) => used + seconds <= minutes * 60;

    if (universeAi) {
      if (scope === 'bot') {
        if (!fits(await sum({ scope: 'bot', personKey, payer: 'universe-ai', createdAt: { gte: day } }), limits.noteMinutesPerPerson)) return { ok: false, reason: 'note-minutes', limit: 'person', resetsAt: tomorrow };
      } else {
        if (!fits(await sum({ scope: 'guest-brick', personKey, createdAt: { gte: day } }), limits.guestNoteMinutesPerGuest)) return { ok: false, reason: 'note-minutes', limit: 'person', resetsAt: tomorrow };
        if (!fits(await sum({ scope: 'guest-brick', universeKey, createdAt: { gte: day } }), limits.guestNoteMinutesPerUniverse)) return { ok: false, reason: 'note-minutes', limit: 'universe', resetsAt: tomorrow };
      }
      if (!fits(await sum({ payer: 'universe-ai', createdAt: { gte: new Date(now.getTime() - HOUR) } }), limits.noteMinutesPerHour)) return { ok: false, reason: 'busy' };
      const atOnce = await tx.voiceNoteTurn.count({
        where: {
          payer: 'universe-ai',
          OR: [
            { state: 'reserved', createdAt: { gt: new Date(now.getTime() - STARTING_MS) } },
            { state: 'hearing', leaseUntil: { gt: now } },
          ],
        },
      });
      if (atOnce >= limits.notesAtOnce) return { ok: false, reason: 'busy' };
    }

    if (scope === 'bot' && !universeAi) {
      // The owner's key: the same day its group listening counts on (lib/voice-listening.ts), so a note counts there too. Only a
      // note that fits whole is taken, as on every other pool: the length is known before anything is paid. The limit is checked in
      // the same statement that adds to the day, so live listening reported at that moment (which takes no lock) is counted too
      const where = { botId_day: { botId: botId!, day } };
      if (ownerDayLimit === null) {
        await tx.voiceListenUse.upsert({ where, create: { botId: botId!, day, seconds }, update: { seconds: { increment: seconds } } });
      } else {
        await tx.voiceListenUse.upsert({ where, create: { botId: botId!, day, seconds: 0 }, update: {} });
        const added = await tx.voiceListenUse.updateMany({ where: { botId: botId!, day, seconds: { lte: ownerDayLimit - seconds } }, data: { seconds: { increment: seconds } } });
        if (added.count === 0) return { ok: false, reason: 'note-minutes', limit: 'bot', resetsAt: tomorrow };
      }
    }

    const turn = await tx.voiceNoteTurn.create({
      data: { scope, personKey, target, botId, universeKey, clientTurnId, fingerprint, payer: hearing.payer!, providerId: hearing.provider?.id ?? null, seconds, state: 'reserved', createdAt: now },
    });
    return { ok: true, turn: view(turn), replay: false };
  }, LOCKED);
}

/** Gives back a reservation that was never used: its seconds stop counting, on the bot's day too. */
async function release(turn: VoiceNoteTurn, db: Prisma.TransactionClient | typeof prisma = prisma) {
  if (onBotDay(turn)) {
    await db.$executeRaw(
      Prisma.sql`UPDATE "voice_listen_uses" SET "seconds" = GREATEST("seconds" - ${turn.seconds}, 0), "updated_at" = NOW() WHERE "bot_id" = ${turn.botId} AND "day" = ${dayOf(turn.createdAt).toISOString().slice(0, 10)}::date`
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------------------------------------------------

export type Lease =
  /**
   * `hearing` names the key to hear with (checked again now, so a key pulled since the reservation is never used). `reconcile`:
   * the provider ids of a hearing a bot server started and lost; look it up, never send the note again. `transcript`: the words
   * heard, for the answer stage.
   */
  | { granted: true; generation: number; leaseUntil: string; hearing?: NoteHearing; reconcile?: unknown; transcript?: string }
  /** `held`: another bot server has it now. Anything else is the turn's state: nothing more to run. */
  | { granted: false; reason: 'held' | 'no-hearing' | 'expired' | TurnState };

async function findTurn(id: string): Promise<VoiceNoteTurn> {
  const turn = await prisma.voiceNoteTurn.findUnique({ where: { id: idOf(id, 'id', 64) } });
  if (!turn) throw new VoiceNoteError('Turn not found', 404);
  return turn;
}

/** Moves a turn on only if nobody else did first: the state and generation it was read with. */
const moveOn = (turn: VoiceNoteTurn, data: Prisma.VoiceNoteTurnUpdateManyMutationInput) =>
  prisma.voiceNoteTurn.updateMany({ where: { id: turn.id, state: turn.state, generation: turn.generation }, data });

/** Marks a turn failed and gives back its reservation, once. */
async function failUnused(turn: VoiceNoteTurn) {
  await prisma.$transaction(async (tx) => {
    const done = await tx.voiceNoteTurn.updateMany({ where: { id: turn.id, state: turn.state, generation: turn.generation, released: false }, data: { state: 'failed', released: true, leaseUntil: null } });
    if (done.count > 0) await release(turn, tx);
  });
}

/**
 * The hearing for a turn now: the same payer and the same provider it was reserved with, or nothing. A key swapped since was never
 * checked against its own day, and a hearing being looked up is only ever looked up at the provider that took the note.
 */
async function hearingFor(turn: VoiceNoteTurn, adapters: Set<string>): Promise<NoteHearing | null> {
  // Only a bot that is gone has no hearing; anything else (the database away a moment) is thrown, and the turn stays as it is to
  // be asked again, never given up on
  const now =
    turn.scope === 'bot'
      ? await botHearing(turn.botId!, adapters).catch((error: unknown) => {
          if (error instanceof BotSettingsError && error.status === 404) return null;
          throw error;
        })
      : await universeAiHearing(adapters);
  return now && now.route !== 'none' && now.payer === turn.payer && (now.provider?.id ?? null) === turn.providerId ? now : null;
}

/** Asks to run a stage of a turn: "hearing" (send the note to the provider) or "answer" (run the model on the words). */
export async function leaseVoiceNoteStage(id: string, input: { stage?: unknown; adapters?: unknown }, now: Date = new Date()): Promise<Lease> {
  const entered = Date.now();
  const stage = input.stage;
  if (stage !== 'hearing' && stage !== 'answer') throw new VoiceNoteError('stage must be hearing or answer', 400);
  const turn = await findTurn(id);
  const generation = turn.generation + 1;
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const granted = { granted: true as const, generation, leaseUntil: leaseUntil.toISOString() };
  const live = turn.leaseUntil !== null && turn.leaseUntil > now;

  if (stage === 'hearing') {
    if (turn.state === 'hearing' && live) return { granted: false, reason: 'held' };
    if (turn.state === 'hearing' && !turn.providerRefs) {
      // The bot server that held it is gone, and nobody knows whether the provider got the note: never sent again
      const done = await moveOn(turn, { state: 'uncertain', leaseUntil: null });
      return { granted: false, reason: done.count > 0 ? 'uncertain' : 'held' };
    }
    if (turn.state !== 'reserved' && turn.state !== 'hearing') return { granted: false, reason: turn.state as TurnState };
    if (turn.state === 'reserved' && turn.createdAt.getTime() <= now.getTime() - STARTING_MS) {
      // Too late to start: it stopped counting as one being heard (the notes-at-once count) and is given back, so it never starts
      // past that count. A new send is a new turn
      await failUnused(turn);
      return { granted: false, reason: 'expired' };
    }
    const hearing = await hearingFor(turn, readAdapterList(input.adapters));
    if (!hearing) {
      // The key it was reserved with can't be used now. A hearing that was started stays counted
      if (turn.state === 'reserved') await failUnused(turn);
      else await moveOn(turn, { state: 'uncertain', leaseUntil: null });
      return { granted: false, reason: 'no-hearing' };
    }
    if (turn.state === 'reserved') {
      // Started under the reservations' lock, still young enough at that moment (the clock moved on while the hearing was looked
      // up): a reservation counts as being heard until it is too old, then never starts, so nothing passes the notes at once
      const started = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('voice-note-reserve'))`);
        const at = now.getTime() + (Date.now() - entered);
        return tx.voiceNoteTurn.updateMany({
          where: { id: turn.id, state: 'reserved', generation: turn.generation, createdAt: { gt: new Date(at - STARTING_MS) } },
          data: { state: 'hearing', generation, leaseUntil },
        });
      }, LOCKED);
      if (started.count === 0) {
        const after = await findTurn(turn.id);
        if (after.state !== 'reserved') return { granted: false, reason: 'held' };
        await failUnused(after);
        return { granted: false, reason: 'expired' };
      }
      return { ...granted, hearing };
    }
    const done = await moveOn(turn, { state: 'hearing', generation, leaseUntil });
    if (done.count === 0) return { granted: false, reason: 'held' };
    return { ...granted, hearing, reconcile: turn.providerRefs };
  }

  if (turn.state === 'answering' && live) return { granted: false, reason: 'held' };
  if (turn.state === 'answering') {
    // The model may have run: not run again on its own
    const done = await moveOn(turn, { state: 'uncertain', leaseUntil: null });
    return { granted: false, reason: done.count > 0 ? 'uncertain' : 'held' };
  }
  if (turn.state !== 'heard') return { granted: false, reason: turn.state as TurnState };
  const kept = turn.buffer && turn.bufferUntil && turn.bufferUntil > now ? openBuffer(turn.id, turn.buffer) : null;
  if (!kept) {
    await moveOn(turn, { state: 'failed', buffer: null, bufferUntil: null });
    return { granted: false, reason: 'expired' };
  }
  const done = await moveOn(turn, { state: 'answering', generation, leaseUntil });
  if (done.count === 0) return { granted: false, reason: 'held' };
  return { ...granted, transcript: kept.transcript };
}

// ---------------------------------------------------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the bot server holding a stage says happened, with the generation it was given (a late one is refused, 409):
 * - submitted { refs }: the provider took the note; its ids, so a lost hearing is looked up instead of sent again;
 * - heard { transcript, seconds?, costMicros? }: the words, kept encrypted for the answer stage;
 * - hearing-failed { charged: "no" | "yes" | "unknown" }: only "no" gives the reservation back. A timeout is "unknown", never "no";
 * - answered { answer }: kept encrypted until the device has it, 15 minutes at most;
 * - answer-failed: the words stay, so the answer can be tried again without hearing the note again;
 * - delivered (no generation): the device has the answer; it is deleted.
 */
export async function recordVoiceNote(id: string, input: Record<string, unknown>, now: Date = new Date()): Promise<{ id: string; state: TurnState }> {
  const turn = await findTurn(id);
  const event = input.event;
  const ok = (state: TurnState) => ({ id: turn.id, state });

  if (event === 'delivered') {
    if (turn.state === 'delivered') return ok('delivered');
    if (turn.state !== 'answered') throw new VoiceNoteError(`A ${turn.state} turn has no answer to deliver`, 409);
    await prisma.voiceNoteTurn.updateMany({ where: { id: turn.id, state: 'answered' }, data: { state: 'delivered', buffer: null, bufferUntil: null } });
    return ok('delivered');
  }

  const generation = wholeOf(input.generation, 'generation', 1, 1_000_000);
  const holding = (state: TurnState) => {
    if (turn.generation !== generation || turn.state !== state) throw new VoiceNoteError('Another bot server has this turn now', 409);
  };
  const fenced = (count: number) => {
    if (count === 0) throw new VoiceNoteError('Another bot server has this turn now', 409);
  };

  switch (event) {
    case 'submitted': {
      holding('hearing');
      const refs = input.refs;
      if (typeof refs !== 'object' || refs === null || JSON.stringify(refs).length > 2_000) throw new VoiceNoteError('refs must be an object of the provider\'s ids', 400);
      fenced((await moveOn(turn, { providerRefs: refs as Prisma.InputJsonValue, leaseUntil: new Date(now.getTime() + LEASE_MS) })).count);
      return ok('hearing');
    }
    case 'heard': {
      holding('hearing');
      if (typeof input.transcript !== 'string') throw new VoiceNoteError('transcript is required', 400);
      const heardSeconds = input.seconds === undefined ? turn.seconds : Math.min(turn.seconds, wholeOf(input.seconds, 'seconds', 0, LENGTH_CEILING));
      const costMicros = input.costMicros === undefined ? null : wholeOf(input.costMicros, 'costMicros', 0, 2_000_000_000);
      const buffer = sealBuffer(turn.id, { transcript: input.transcript.slice(0, 20_000) });
      fenced((await moveOn(turn, { state: 'heard', heardSeconds, costMicros, buffer, bufferUntil: new Date(now.getTime() + BUFFER_MS), leaseUntil: null })).count);
      return ok('heard');
    }
    case 'hearing-failed': {
      holding('hearing');
      const charged = input.charged;
      if (charged !== 'no' && charged !== 'yes' && charged !== 'unknown') throw new VoiceNoteError('charged must be no, yes or unknown', 400);
      if (charged === 'no') {
        await prisma.$transaction(async (tx) => {
          const done = await tx.voiceNoteTurn.updateMany({ where: { id: turn.id, state: 'hearing', generation, released: false }, data: { state: 'failed', released: true, leaseUntil: null } });
          fenced(done.count);
          await release(turn, tx);
        });
      } else {
        fenced((await moveOn(turn, { state: 'failed', leaseUntil: null })).count);
      }
      return ok('failed');
    }
    case 'answered': {
      holding('answering');
      if (typeof input.answer !== 'string') throw new VoiceNoteError('answer is required', 400);
      const kept = turn.buffer ? openBuffer(turn.id, turn.buffer) : null;
      const value = { transcript: kept?.transcript ?? '', answer: input.answer };
      if (Buffer.byteLength(JSON.stringify(value)) > BUFFER_MAX_BYTES) throw new VoiceNoteError(`The answer and its words are over ${BUFFER_MAX_BYTES / 1024} KB`, 400);
      const buffer = sealBuffer(turn.id, value);
      fenced((await moveOn(turn, { state: 'answered', buffer, bufferUntil: new Date(now.getTime() + BUFFER_MS), leaseUntil: null })).count);
      return ok('answered');
    }
    case 'answer-failed': {
      holding('answering');
      fenced((await moveOn(turn, { state: 'heard', leaseUntil: null })).count);
      return ok('heard');
    }
    default:
      throw new VoiceNoteError('event must be submitted, heard, hearing-failed, answered, answer-failed or delivered', 400);
  }
}

/** Deletes every kept answer whose 15 minutes are over. */
export async function sweepVoiceNoteBuffers(now: Date = new Date()): Promise<number> {
  const done = await prisma.voiceNoteTurn.updateMany({ where: { bufferUntil: { lt: now } }, data: { buffer: null, bufferUntil: null } });
  return done.count;
}

/**
 * Gives back reservations that were never started: a bot server that crashed or lost its connection between reserving and
 * leasing leaves a turn "reserved" that would keep counting on the person's minutes, the hour's minutes and the owner key's day
 * until midnight. Each is marked failed and given back once, guarded on its state, so a lease that comes in at the same moment
 * is never given back twice. The same turn asked again then answers as failed: a new send is a new turn.
 */
export async function sweepStaleReservations(now: Date = new Date(), limit = 200): Promise<number> {
  const stale = await prisma.voiceNoteTurn.findMany({
    where: { state: 'reserved', released: false, createdAt: { lt: new Date(now.getTime() - STARTING_MS) } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let released = 0;
  for (const turn of stale) {
    // One at a time, each in its own transaction: few, and each must be given back exactly once
    released += await prisma.$transaction(async (tx) => {
      const done = await tx.voiceNoteTurn.updateMany({ where: { id: turn.id, state: 'reserved', released: false }, data: { state: 'failed', released: true, leaseUntil: null } });
      if (done.count !== 1) return 0;
      await release(turn, tx);
      return 1;
    });
  }
  return released;
}
