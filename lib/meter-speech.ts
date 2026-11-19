import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';

type Db = Pick<typeof prisma, 'meterEvent' | 'bot'>;

/**
 * A voice note that was heard goes into the books (audit F4): the `speech` kind had no writer, so the Voice row of the Costs page was
 * always empty. Written once for each note (its id is the turn's), with the seconds that were heard. Whoever's key heard it pays: a note
 * the owner's own key heard is theirs to pay (never a cost to Universe), one Universe AI heard is ours. A cost the provider did not give is
 * written as not known, never as 0. It throws when the books can't be written, and the caller writes it in the same transaction that
 * marks the note heard (lib/voice-note-turns.ts): a note is never heard without its event, and never counted twice in between, so a
 * failure leaves the note as it was and the same `heard` report is simply sent again.
 */
export async function recordSpeechHeard(turn: { id: string; scope: string; personKey: string; botId: string | null; payer: string }, seconds: number, costMicros: number | null, now: Date = new Date(), db: Db = prisma): Promise<void> {
  const bot = turn.botId ? await db.bot.findUnique({ where: { id: turn.botId }, select: { roomId: true, ownerId: true } }) : null;
  const personId = turn.personKey.startsWith('person:') ? turn.personKey.slice('person:'.length) : null;
  const paidByOwner = turn.payer === 'owner';
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
      costMicros,
      basis: paidByOwner ? 'paid_by_other' : costMicros === null ? 'unknown' : 'estimated',
      sourceRef: `voice_note_turns:${turn.id}`,
      detail: { part: 'hearing', scope: turn.scope },
    },
    db,
  );
}
