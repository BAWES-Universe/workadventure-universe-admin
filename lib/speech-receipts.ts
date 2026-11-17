import { prisma } from '@/lib/db';
import { recordMeterEvent, type RecordedEvent } from '@/lib/meter';
import type { MeterEventInput } from '@/lib/meter-values';
import { lockSpeech, SPEECH_LOCK } from '@/lib/speech-reserved';
import { getRateCardAt, priceSpeech } from '@/lib/speech-rates';
import { resolveCompany, setCompanyFunds } from '@/lib/speech-admission';

/**
 * The receipt of speech Universe AI paid for (docs/speech-admission-contract.md, sections 3 and 4): the `speech` event of a live call, as the game
 * sends it to POST /api/meter/events, with the id that links it to what was set aside for it.
 *
 *  - Speaking: the event carries the reply's `turnId`. It is counted under ONE canonical event id made from the bot and the turn id, so the same
 *    utterance is counted once however often, and under whatever event id, it is sent (a retry, a restart). The row that held the reply's money
 *    is settled in the same transaction that writes the event, under the speech lock: the money is counted as set aside, or as spent, never both
 *    and never neither. Release comes from this event, never from a timer.
 *  - Hearing: the event carries the `windowId` of the stretch it was heard in, and uses that window up.
 *  - Price: an event with no cost is priced at the rate card VERSION it was admitted under (an estimate, with the rate's basis written on it),
 *    never 0 and never left unknown while a rate exists. A cost the game did give stands.
 *  - A voice company that answered "no funds" says so (`providerStatus`): new funded speech on it is stopped with the reason `provider` until it is back.
 */
export type ReceiptLink = 'settled' | 'already_settled' | 'no_admission' | 'not_applicable';

export interface SpeechReceiptFields {
  turnId: string | null;
  windowId: string | null;
  provider: string | null;
  model: string | null;
  characters: number | null;
  providerStatus: 'ok' | 'funds_unavailable' | null;
  /** What the game was told when it was admitted, echoed back. Orbit trusts its own record; a mismatch is written down, never refused. */
  echo: { rateVersion?: number; admittedSeconds?: number; admittedMicros?: number } | null;
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The contract's own fields of a speech event, read from what the game sent (top level). Anything that is not what it should be is left out, never fails the event. */
export function readSpeechFields(body: Record<string, unknown>): SpeechReceiptFields {
  const echo = isRecord(body.admission)
    ? {
        ...(whole(body.admission.rateVersion) ? { rateVersion: body.admission.rateVersion } : {}),
        ...(whole(body.admission.admittedSeconds) ? { admittedSeconds: body.admission.admittedSeconds } : {}),
        ...(whole(body.admission.admittedMicros) ? { admittedMicros: body.admission.admittedMicros } : {}),
      }
    : null;
  return {
    turnId: text(body.turnId, 255),
    windowId: text(body.windowId, 255),
    provider: text(body.provider, 64)?.toLowerCase() ?? null,
    model: text(body.model, 255),
    characters: whole(body.characters) ? body.characters : null,
    providerStatus: body.providerStatus === 'ok' || body.providerStatus === 'funds_unavailable' ? body.providerStatus : null,
    echo: echo && Object.keys(echo).length > 0 ? echo : null,
  };
}

/** The one event id a speaking event is counted under when it names its reply. */
export const replyEventId = (botId: string, turnId: string) => `speech:reply:${botId}:${turnId}`.slice(0, 255);

export type ReceiptOutcome = RecordedEvent & { admission: ReceiptLink; /** The id the event is counted under (the canonical one for a reply that names its turn). */ eventId: string };

/** Whether an event is speech Universe AI paid for, which is what admission and holds are about. */
export const isFundedSpeech = (event: Pick<MeterEventInput, 'kind' | 'payerKind'>) => event.kind === 'speech' && event.payerKind === 'universe';

export async function recordSpeechReceipt(event: MeterEventInput, fields: SpeechReceiptFields, now: Date = new Date()): Promise<ReceiptOutcome> {
  const part = event.detail && typeof event.detail.part === 'string' ? event.detail.part : null;
  const speaking = part === 'speaking';
  const hearing = !speaking;

  // A company that answered "no funds" stops new funded speech on it; one that works again is let back in. Said before the event is written:
  // the stop must hold even if the books are slow
  if (fields.providerStatus) {
    const company = await resolveCompany(prisma, speaking ? 'speaking' : 'hearing', { provider: fields.provider, model: fields.model });
    if (company.adapter) await setCompanyFunds(company.adapter, fields.providerStatus === 'funds_unavailable', now).catch((error) => console.error('[Speech] Could not record the provider funds:', error instanceof Error ? error.message : 'unknown'));
  }

  const botId = event.botId;
  const linkedReply = speaking && fields.turnId && botId ? { botId, turnId: fields.turnId } : null;
  const linkedWindow = hearing && fields.windowId && botId ? { botId, windowId: fields.windowId } : null;

  // What it was admitted under: the rate version and the company of the row that holds it
  const [reply, window] = await Promise.all([
    linkedReply ? prisma.voiceReplyUse.findUnique({ where: { botId_turnId: linkedReply }, select: { rateVersion: true, provider: true, settledAt: true, holdMicros: true, memberSeconds: true } }) : null,
    linkedWindow ? prisma.voiceHearingWindow.findUnique({ where: { botId_windowId: linkedWindow }, select: { rateVersion: true, provider: true, holdMicros: true, admittedSeconds: true } }) : null,
  ]);
  const admitted = reply ?? window;

  let priced: Record<string, unknown> = {};
  let costMicros = event.costMicros;
  let basis = event.basis;
  if (costMicros === null) {
    const company = await resolveCompany(prisma, speaking ? 'speaking' : 'hearing', { provider: fields.provider ?? admitted?.provider, model: fields.model });
    const card = await getRateCardAt(admitted?.rateVersion ?? null);
    const price = card ? priceSpeech(card, { adapter: company.adapter, part: speaking ? 'speaking' : 'hearing', seconds: event.quantity, characters: fields.characters, talk: company.talk }) : null;
    if (price) {
      costMicros = price.micros;
      basis = 'estimated';
      priced = {
        rateVersion: price.rateVersion,
        rateBasis: price.basis,
        rateBasisNote: price.basisNote,
        provider: price.adapter,
        ...(price.characters !== undefined ? { characters: price.characters, charactersEstimated: price.charactersEstimated === true } : {}),
      };
    }
  }

  const echoed = fields.echo;
  const mismatch =
    !!echoed && !!admitted && ((echoed.rateVersion !== undefined && echoed.rateVersion !== admitted.rateVersion) || (echoed.admittedMicros !== undefined && Number(admitted.holdMicros ?? echoed.admittedMicros) !== echoed.admittedMicros));
  const next: MeterEventInput = {
    ...event,
    eventId: linkedReply ? replyEventId(linkedReply.botId, linkedReply.turnId) : event.eventId,
    costMicros,
    basis,
    detail: {
      ...(event.detail ?? {}),
      ...priced,
      ...(fields.turnId ? { turnId: fields.turnId } : {}),
      ...(fields.windowId ? { windowId: fields.windowId } : {}),
      ...(linkedReply && event.eventId !== replyEventId(linkedReply.botId, linkedReply.turnId) ? { gameEventId: event.eventId.slice(0, 200) } : {}),
      ...(mismatch ? { admissionMismatch: echoed } : {}),
    },
  };

  if (!linkedReply && !linkedWindow) {
    // Nothing to release: an event of an older game, or hearing that no window covered. It is counted as it always was, with its price
    return { ...(await recordMeterEvent(next)), admission: 'not_applicable', eventId: next.eventId };
  }

  return prisma.$transaction(async (tx): Promise<ReceiptOutcome> => {
    // The speech lock: the event and the row that held its money change together, so a reservation sees one or the other
    await lockSpeech(tx);
    const recorded = await recordMeterEvent(next, tx);
    if (linkedReply) {
      if (recorded.recorded) {
        const done = await tx.voiceReplyUse.updateMany({
          where: { botId: linkedReply.botId, turnId: linkedReply.turnId, settledAt: null },
          data: { settledAt: now, settledSeconds: next.quantity, settledMicros: costMicros === null ? null : BigInt(costMicros) },
        });
        return { ...recorded, eventId: next.eventId, admission: done.count > 0 ? 'settled' : 'no_admission' };
      }
      // Counted before: a retry. If the row is settled the hold is already released
      const row = await tx.voiceReplyUse.findUnique({ where: { botId_turnId: linkedReply }, select: { settledAt: true } });
      return { ...recorded, eventId: next.eventId, admission: row?.settledAt ? 'already_settled' : 'no_admission' };
    }
    const window = linkedWindow!;
    if (recorded.recorded) {
      const done = await tx.voiceHearingWindow.updateMany({ where: { botId: window.botId, windowId: window.windowId }, data: { usedSeconds: { increment: next.quantity } } });
      return { ...recorded, eventId: next.eventId, admission: done.count > 0 ? 'settled' : 'no_admission' };
    }
    return { ...recorded, eventId: next.eventId, admission: 'already_settled' };
  }, SPEECH_LOCK);
}
