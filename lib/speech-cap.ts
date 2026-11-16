import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { monthOf } from '@/lib/meter-values';

/**
 * A spending stop on the speech Universe AI pays for (0.5.0 spend caps, gap F4). Speech has no price Universe could know (the providers bill
 * by their own measures), so the stop counts what is certain: seconds. Every heard second and every spoken second of a live call, and every
 * heard voice note, is a `speech` event written against whoever paid (lib/meter-speech.ts, POST /api/meter/events); this adds up the ones
 * Universe AI paid for this calendar month (UTC) and holds a new use back BEFORE it is made, when it would pass either Limit:
 *
 *  - `speechCeilingSeconds`: the most seconds, all people together.
 *  - `speechMemberCeilingSeconds`: the most of that for one person.
 *
 * What is asked for is the room the new use may take (the longest a reply may be, the exact length of a note), so the overshoot is never more
 * than one use. A person's own key never counts here (their bill, not ours). A Limit that is empty stops everything it covers: nothing is
 * assumed, and 0 pauses it. Nobody is told a number: the caller turns "stopped" into the kind line it already has for a used-up allowance.
 */
export type SpeechStop = { stopped: 'month' | 'person' | 'not_set'; resetsAt: string };

type Db = Pick<typeof prisma, 'meterEvent' | 'appSetting'>;

export async function checkSpeechCap(input: { personId: string | null; seconds: number }, now: Date = new Date(), db: Db = prisma): Promise<SpeechStop | null> {
  const month = monthOf(now);
  const resetsAt = month.end.toISOString();
  const settings = await getMeterSettings(db);
  if (settings.speechCeilingSeconds === null || settings.speechMemberCeilingSeconds === null) return { stopped: 'not_set', resetsAt };
  const where = { kind: 'speech', payerKind: 'universe', occurredAt: { gte: month.start, lt: month.end } };
  const [all, mine] = await Promise.all([
    db.meterEvent.aggregate({ where, _sum: { quantity: true } }),
    input.personId ? db.meterEvent.aggregate({ where: { ...where, personId: input.personId }, _sum: { quantity: true } }) : Promise.resolve(null),
  ]);
  if (Number(all._sum.quantity ?? 0) + input.seconds > settings.speechCeilingSeconds) return { stopped: 'month', resetsAt };
  if (mine && Number(mine._sum.quantity ?? 0) + input.seconds > settings.speechMemberCeilingSeconds) return { stopped: 'person', resetsAt };
  return null;
}
