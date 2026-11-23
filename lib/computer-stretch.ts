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
 * A model call belongs to the stretch it was ADMITTED in: the admission writes the job's number of pauses on the call's room (`meter_reservations.stretch`) under the job's cutoff lock, the lock a pause takes, so the
 * order of the two is exact and never read from two clocks (a pause's own time may be earlier than the time of a call it waited for). Every key of the job ends at a pause, so no call of an earlier stretch can be
 * admitted after it, and a call that only REPORTS after the pause (its figures arrive late) still belongs to the stretch that admitted it.
 *
 * The same rule is written once here, for SQL (the give-back itself, the sweep that looks for give-backs that did not go through, the Brick's purge and the late follow-up all read it) and for
 * code (a call that reports after its job was given back).
 */

/**
 * For SQL whose job row is `j` and call room is `r`: the stretch the call was admitted in. Written when the call was admitted, under the job's cutoff lock (the lock a pause takes), as the job's number of pauses
 * then (`meter_reservations.stretch`): an admission and a pause are ordered exactly, a late report keeps the stretch that admitted it, and a call admitted after a resume belongs to the new one. A room with none
 * (of before the column) is read by time as it was: after the job's last pause it is the last stretch, otherwise an earlier one.
 */
const STRETCH_OF_ROOM = Prisma.sql`COALESCE(r."stretch", CASE WHEN r."created_at" > (SELECT MAX(p."at") FROM "computer_job_pauses" p WHERE p."job_id" = j."id") THEN j."pauses" ELSE -1 END)`;

/** For SQL whose job row is `j` and model-call event is `e`: the event is of the job's last stretch. */
export const CALL_IN_LAST_STRETCH = Prisma.sql`(j."pauses" = 0 OR EXISTS (
  SELECT 1 FROM "meter_reservations" r
  WHERE r."reservation_key" = 'computer:call:' || j."id" || ':' || substr(e."event_id", length('computer:' || j."id" || ':call:') + 1)
    AND ${STRETCH_OF_ROOM} = j."pauses"))`;

/** For SQL whose job row is `j` and credit hold is `h`: the hold is of the job's last stretch (a pause's own draw never is). */
export const HOLD_IN_LAST_STRETCH = Prisma.sql`(
  left(h."hold_key", length('computer:credit:computer:' || j."id" || ':time:')) <> 'computer:credit:computer:' || j."id" || ':time:'
  AND (
    j."pauses" = 0
    OR h."hold_key" = 'computer:credit:computer:' || j."id" || ':time'
    OR (left(h."hold_key", length('computer:credit:computer:' || j."id" || ':call:')) = 'computer:credit:computer:' || j."id" || ':call:'
      AND EXISTS (
        SELECT 1 FROM "meter_reservations" r
        WHERE r."reservation_key" = 'computer:call:' || j."id" || ':' || substr(h."hold_key", length('computer:credit:computer:' || j."id" || ':call:') + 1)
          AND ${STRETCH_OF_ROOM} = j."pauses"))
  ))`;

/** For code: whether this model call (by its call id) is of the job's last stretch. */
export async function callInLastStretch(jobId: string, callId: string, db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ yes: boolean }>>(Prisma.sql`
    SELECT ${CALL_IN_LAST_STRETCH} AS "yes"
    FROM "computer_jobs" j, (SELECT ${`computer:${jobId}:call:${callId}`}::text AS "event_id") e
    WHERE j."id" = ${jobId}`);
  return rows[0]?.yes ?? true;
}
