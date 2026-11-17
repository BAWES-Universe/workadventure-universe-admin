import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { getRateCardAt, priceSpeech } from '@/lib/speech-rates';
import { resolveCompany } from '@/lib/speech-admission';

type Db = Pick<typeof prisma, 'meterEvent' | 'bot' | 'appSetting' | 'voiceProvider'>;

/**
 * A voice note that was heard goes into the books (audit F4): the `speech` kind had no writer, so the Voice row of the Costs page was
 * always empty. Written once for each note (its id is the turn's), with the seconds that were heard. Whoever's key heard it pays: a note
 * the owner's own key heard is theirs to pay (never a cost to Universe), one Universe AI heard is ours. A cost the provider did not give is
 * priced at the rate version the note was admitted under (basis estimated, never 0; lib/speech-rates.ts). It throws when the books can't be written, and the caller writes it in the same transaction that
 * marks the note heard (lib/voice-note-turns.ts): a note is never heard without its event, and never counted twice in between, so a
 * failure leaves the note as it was and the same `heard` report is simply sent again.
 */
export async function recordSpeechHeard(
  turn: { id: string; scope: string; personKey: string; botId: string | null; payer: string; providerId?: string | null; rateVersion?: number | null },
  seconds: number,
  costMicros: number | null,
  now: Date = new Date(),
  db: Db = prisma,
): Promise<void> {
  const bot = turn.botId ? await db.bot.findUnique({ where: { id: turn.botId }, select: { roomId: true, ownerId: true } }) : null;
  const personId = turn.personKey.startsWith('person:') ? turn.personKey.slice('person:'.length) : null;
  const paidByOwner = turn.payer === 'owner';
  // A note Universe AI heard gets a price when the provider gave none: its seconds at the rate card it was admitted under (an estimate, with the
  // rate's basis written on it), never 0 and never "not known" for audio that was certainly heard
  let priced: { micros: number; detail: Record<string, unknown> } | null = null;
  if (!paidByOwner && costMicros === null) {
    const card = await getRateCardAt(turn.rateVersion ?? null, db);
    const row = turn.providerId ? await db.voiceProvider.findUnique({ where: { id: turn.providerId }, select: { adapter: true } }) : null;
    const company = await resolveCompany(db, 'hearing', { provider: row?.adapter });
    const price = card ? priceSpeech(card, { adapter: company.adapter, part: 'hearing', seconds: Math.max(0, Math.trunc(seconds)), talk: company.talk }) : null;
    if (price) priced = { micros: price.micros, detail: { rateVersion: price.rateVersion, rateBasis: price.basis, rateBasisNote: price.basisNote, provider: price.adapter } };
  }
  await recordMeterEvent(
    {
      eventId: `speech:note:${turn.id}`,
      kind: 'speech',
      pool: 'chat',
      occurredAt: now,
      personKey: turn.personKey,
      personId,
      botId: turn.botId,
      brick: bot ? bot.roomId === null : null,
      payerKind: paidByOwner ? 'person' : 'universe',
      payerPersonId: paidByOwner ? (bot?.ownerId ?? null) : null,
      route: paidByOwner ? 'own-key' : 'universe-ai',
      jobId: null,
      quantity: Math.max(0, Math.trunc(seconds)),
      unit: 'second',
      costMicros: priced ? priced.micros : costMicros,
      basis: paidByOwner ? 'paid_by_other' : costMicros === null && !priced ? 'unknown' : 'estimated',
      sourceRef: `voice_note_turns:${turn.id}`,
      detail: { part: 'hearing', scope: turn.scope, ...(priced ? priced.detail : {}) },
    },
    db,
  );
}
