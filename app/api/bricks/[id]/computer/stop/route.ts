import { NextRequest } from 'next/server';
import { z } from 'zod';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { stopAll, STOP_CONFIRMED_MAX } from '@/lib/computer';
import { commandOf } from '@/lib/computer-commands';
import { COMMAND_MISSING } from '@/lib/computer-job-controls-api';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/stop
 * "Stop" (game #2000): the job that has the computer ends and the work so far is kept. Asked with nothing running it changes
 * nothing. Answers with the computer as the page shows it.
 * The 0.5 panel sends the tap's command id (header X-Computer-Command, finding 4): it ends only the jobs that were on the computer at the first request, and the same id again ends nothing more. The 0.4.3 game's Stop
 * has none and is answered as before. 400 `command_missing` for an id that is not a uuid, `command_reused` for one used for another control.
 * Round 8, D2: an optional body `{ confirmedJobIds: [ids] }` (the jobs the panel showed when the person confirmed) ends ONLY those that are live and answers `stopped` and `left` beside `computer` (`left` is the snapshot of the jobs live and outside the set when the command was first dispatched, never a live status); the same command id
 * with another set is 409. With no body, as before (today's snapshot).
 */
// Only the set is read: the bodies the panel sends today (none, `{}`, `{ confirmedJobIds }`) are answered as before; a body with any other key is 400
const confirmedSchema = z.array(z.string().uuid()).min(1).max(STOP_CONFIRMED_MAX);

export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const command = commandOf(request);
    if (command === 'invalid') return brickJson(request, { error: COMMAND_MISSING, reason: 'command_missing' }, 400);
    // No body and `{}` are today's Stop. A body that is there and is not a JSON object (malformed JSON, `null`, an array, a string or a number) is refused with a 400, never read as "stop everything", which would end jobs the person did not confirm (CodeRabbit on #1025, I2 and N3)
    const text = await request.text().catch(() => null);
    if (text === null) return brickJson(request, { error: 'Invalid input data' }, 400);
    let raw: unknown = null;
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return brickJson(request, { error: 'Invalid input data' }, 400);
      }
      // A JSON `null` is a body that is there and is not an object too: it would reach stopAll with no confirmed set and end every live job (CodeRabbit on #1025, N3)
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return brickJson(request, { error: 'Invalid input data' }, 400);
      // An object with a key this route does not read (a misspelt `confirmedJobId`, say) would otherwise fall through to the unrestricted Stop and end jobs the person did not confirm. Only `confirmedJobIds` is read; `{}` stays today's Stop
      if (Object.keys(raw).some((name) => name !== 'confirmedJobIds')) return brickJson(request, { error: 'Invalid input data' }, 400);
    }
    const sent = raw !== null && typeof raw === 'object' ? (raw as { confirmedJobIds?: unknown }).confirmedJobIds : undefined;
    let confirmed: string[] | null = null;
    if (sent !== undefined) {
      const parsed = confirmedSchema.safeParse(sent);
      if (!parsed.success) return brickJson(request, { error: 'Invalid input data' }, 400);
      confirmed = parsed.data;
    }
    // Without a set, the call is exactly today's
    const stopped = confirmed ? await stopAll(id, ownerId, new Date(), command ?? undefined, confirmed) : await stopAll(id, ownerId, new Date(), command ?? undefined);
    if (stopped.ok) return brickJson(request, { computer: stopped.view, ...(confirmed ? { stopped: stopped.stopped ?? [], left: stopped.left ?? [] } : {}) });
    if (stopped.reason === 'command_reused') return brickJson(request, { error: 'That control was already used for something else. Try again.', reason: 'command_reused' }, confirmed ? 409 : 400);
    // Some job the Stop captured is still live after the bounded retry: nothing is kept as done, and the same command asked again ends those (CodeRabbit on #1025, I10)
    if (stopped.reason === 'not_ended') return brickJson(request, { error: 'Some jobs are still ending. Ask again.', reason: 'not_ended', retry: true }, 503);
    return notFound(request);
  });
