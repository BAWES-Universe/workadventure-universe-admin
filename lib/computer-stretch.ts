import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Which of a job's charges a give-back may touch, once the job was paused and carried on (Opus rule 7, piece 3 of the computer job controls).
 *
 * A job is charged a stretch at a time: each pause writes the stretch before it under its own event (`computer:<job>:time:<n>`), and the job's ending writes only the stretch since it
 * last started (`computer:<job>:time`). A pause is never a fault (the person's own, their month, or a limit they set), so a fault of OURS found later gives back only the stretch it
 * happened in, the LAST one: its own time event, the model calls authorized after the last pause, and the credit those drew. Every earlier stretch stays charged, with its model calls and
 * the credit it drew. A job that was never paused is exactly as before: everything of it.
 *
 * A model call belongs to the stretch it was ADMITTED in: the admission writes the job's number of pauses on the call's room (`meter_reservations.job_stretch`) under the job's cutoff lock, the lock a pause takes, so the
 * order of the two is exact and never read from two clocks (a pause's own time may be earlier than the time of a call it waited for). Every key of the job ends at a pause, so no call of an earlier stretch can be
 * admitted after it, and a call that only REPORTS after the pause (its figures arrive late) still belongs to the stretch that admitted it. The credit a charge drew carries the same number
 * (`credit_holds.job_stretch`, from the call's room for a model call, its own number for a pause's time, the job's number now for the job's ending), so every charge says which stretch it is of and nothing is
 * classified by comparing two timestamps (GPT round 6, finding 8).
 *
 * The same rule is written once here, for SQL (the give-back itself, the sweep that looks for give-backs that did not go through, the Brick's purge, the late follow-up, the refund state and the report all read it) and for
 * code (a call that reports after its job was given back).
 */

/**
 * For SQL whose job row is `j` and call room is `r`: the stretch the call was admitted in. Written when the call was admitted, under the job's cutoff lock (the lock a pause takes), as the job's number of pauses
 * then (`meter_reservations.job_stretch`): an admission and a pause are ordered exactly, a late report keeps the stretch that admitted it, and a call admitted after a resume belongs to the new one. A room with
 * none (of before the column, which only an unpaused job can have: no job of 0.4.3 was ever paused) counts as the first stretch, 0.
 */
const STRETCH_OF_ROOM = Prisma.sql`COALESCE(r."job_stretch", 0)`;

/** For SQL whose job row is `j` and credit hold is `h`: the stretch the charge the credit was drawn for belongs to. A hold with none (of before the column) counts as the first stretch, 0. */
const STRETCH_OF_HOLD = Prisma.sql`COALESCE(h."job_stretch", 0)`;

/** For SQL whose job row is `j` and model-call event is `e`: the event is of the job's last stretch. */
export const CALL_IN_LAST_STRETCH = Prisma.sql`(j."pauses" = 0 OR EXISTS (
  SELECT 1 FROM "meter_reservations" r
  WHERE r."reservation_key" = 'computer:call:' || j."id" || ':' || substr(e."event_id", length('computer:' || j."id" || ':call:') + 1)
    AND ${STRETCH_OF_ROOM} = j."pauses"))`;

/** For SQL whose job row is `j` and credit hold is `h`: the hold is of the job's last stretch, by the stretch written on it when it was drawn (a pause's own draw never is: its own stretch is an earlier one, and its key says so too). */
export const HOLD_IN_LAST_STRETCH = Prisma.sql`(
  left(h."hold_key", length('computer:credit:computer:' || j."id" || ':time:')) <> 'computer:credit:computer:' || j."id" || ':time:'
  AND ${STRETCH_OF_HOLD} = j."pauses")`;

/**
 * For code: the stretch a charge of this job belongs to, by its event id, so the credit it draws carries the same number the charge itself does (`credit_holds.job_stretch`).
 * A pause's own time is its own stretch (`computer:<job>:time:<n>` is stretch n), a model call is the stretch its room was stamped with when the call was admitted (never read from a clock), and the job's
 * own time is the stretch it is in now. Null when there is nothing to read it from (a call on the owner's own key takes no room, and draws nothing from the platform): the charge counts as the first stretch, 0.
 */
export async function stretchOfCharge(
  jobId: string,
  eventId: string,
  db: Pick<Prisma.TransactionClient, 'meterReservation' | 'computerJob'> = prisma,
): Promise<number | null> {
  const pausePrefix = `computer:${jobId}:time:`;
  if (eventId.startsWith(pausePrefix)) {
    const n = Number(eventId.slice(pausePrefix.length));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  const callPrefix = `computer:${jobId}:call:`;
  if (eventId.startsWith(callPrefix)) {
    const room = await db.meterReservation.findUnique({ where: { reservationKey: `computer:call:${jobId}:${eventId.slice(callPrefix.length)}` }, select: { jobStretch: true } });
    return room?.jobStretch ?? null;
  }
  if (eventId === `computer:${jobId}:time`) {
    const job = await db.computerJob.findUnique({ where: { id: jobId }, select: { pauses: true } });
    return job?.pauses ?? null;
  }
  return null;
}

/** For code: whether this model call (by its call id) is of the job's last stretch. */
export async function callInLastStretch(jobId: string, callId: string, db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ yes: boolean }>>(Prisma.sql`
    SELECT ${CALL_IN_LAST_STRETCH} AS "yes"
    FROM "computer_jobs" j, (SELECT ${`computer:${jobId}:call:${callId}`}::text AS "event_id") e
    WHERE j."id" = ${jobId}`);
  return rows[0]?.yes ?? true;
}
