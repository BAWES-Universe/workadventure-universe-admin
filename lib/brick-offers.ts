import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { ownerAskingThrough } from '@/lib/brick-make';

/**
 * The gentle offer (game #1996). A person's Brick does the job itself first. When the same kind of job keeps coming
 * back, it may suggest a Brick just for it: once per topic, never in the middle of a job, and "Not now" holds in every
 * chat and on every device.
 *
 * The Brick decides when a job has come back often enough (how often is a number a super admin can change) and waits
 * until its answer is done. Orbit keeps the part that must hold everywhere: one row per person and topic. A topic that
 * has a row is never suggested to that person again, whatever they answered and wherever they are, because the row is
 * on their account. So the bot server asks here before it shows the card, and shows it only on a yes.
 */

export const OFFER_ANSWERS = ['made', 'not_now'] as const;
export type OfferAnswer = (typeof OFFER_ANSWERS)[number];

const TOPIC_MAX = 60;

/**
 * A topic as it is kept and compared: lower case, one space between words, nothing but letters, digits and spaces, so
 * "Recipes", "recipes!" and " recipes " are one topic. Null when nothing is left to name it by.
 */
export function topicKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw
    .normalize('NFKC')
    .toLowerCase()
    // Marks stay with their letters (\p{M}): Arabic vowel signs, Devanagari and Thai vowels are part of the word
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, TOPIC_MAX)
    .trim();
  return key || null;
}

const person = z.string().trim().min(1).max(320);
export const offerSchema = z.object({ userId: person, topic: z.string().max(200) }).strict();
export const offerAnswerSchema = z.object({ userId: person, topic: z.string().max(200), answer: z.enum(OFFER_ANSWERS) }).strict();

export interface OffersSoFar {
  /** How often the same kind of job has to come back before a Brick is suggested for it. */
  after: number;
  /** Every topic already suggested to this person, with their answer when they gave one. None of them is suggested again. */
  topics: { topic: string; answer: OfferAnswer | null }[];
}

type Refused = { ok: false; status: 400 | 404; error: string };

/** What a Brick needs to know before it suggests anything to its owner. Only for the owner of the Brick that asks. */
export async function offersSoFar(viaBrickId: string, userId: string): Promise<({ ok: true } & OffersSoFar) | Refused> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const [{ offerAfter }, rows] = await Promise.all([
    getBrickLimits(),
    prisma.brickOffer.findMany({ where: { userId: ownerId }, select: { topic: true, answer: true }, orderBy: { offeredAt: 'asc' } }),
  ]);
  return {
    ok: true,
    after: offerAfter,
    topics: rows.map((row) => ({ topic: row.topic, answer: OFFER_ANSWERS.find((answer) => answer === row.answer) ?? null })),
  };
}

/**
 * May the card for this topic be shown now? Yes exactly once per person and topic: the first ask writes the row and
 * every later one, from any chat or device and however many come at the same moment, finds it and is told no.
 */
export async function claimOffer(viaBrickId: string, input: z.infer<typeof offerSchema>): Promise<{ ok: true; show: boolean; topic: string } | Refused> {
  const topic = topicKey(input.topic);
  if (!topic) return { ok: false, status: 400, error: 'topic must name the kind of job in a few words' };
  const ownerId = await ownerAskingThrough(viaBrickId, input.userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const claimed = await prisma.$queryRaw<{ topic: string }[]>(Prisma.sql`
    INSERT INTO "brick_offers" ("user_id", "topic") VALUES (${ownerId}, ${topic})
    ON CONFLICT ("user_id", "topic") DO NOTHING
    RETURNING "topic"`);
  return { ok: true, show: claimed.length > 0, topic };
}

/**
 * What the person tapped on the card: they made the Brick, or "Not now". Kept for the record and for the Brick's own
 * words later; the topic is closed either way, from the moment the card was shown. The first answer stands.
 */
export async function answerOffer(viaBrickId: string, input: z.infer<typeof offerAnswerSchema>, now: Date = new Date()): Promise<{ ok: true; kept: boolean } | Refused> {
  const topic = topicKey(input.topic);
  if (!topic) return { ok: false, status: 400, error: 'topic must name the kind of job in a few words' };
  const ownerId = await ownerAskingThrough(viaBrickId, input.userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  const kept = await prisma.brickOffer.updateMany({ where: { userId: ownerId, topic, answer: null }, data: { answer: input.answer, answeredAt: now } });
  return { ok: true, kept: kept.count > 0 };
}
