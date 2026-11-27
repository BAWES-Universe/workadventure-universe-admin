/**
 * The take-over fence's starting mark, as Orbit keeps it (root-agent item 3A; the script side is lib/computer-fence-script.ts).
 *
 * The mark is taken when a computer is made ready and saved in the SAME write that sets the machine to `working` (and only while that
 * start still holds the wake ticket). On the same boot the first mark is kept: a later clock reading would take in what the agent has started
 * since. After each restart Orbit itself does (the browser, after a clean-up or a sign-ins command) the computer's own parts are read and
 * saved again, because a restarted browser is a new process the first list does not know.
 */
import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { markCommand, parseMark, validMark } from '@/lib/computer-fence-script';
import type { MachineMark, MarkPart } from '@/lib/computer-fence-script';
import type { ComputerProvider } from '@/lib/computer-provider';

export type { MachineMark };

/** The columns of a computer row that hold the mark. */
export interface MarkColumns {
  markBootId: string | null;
  markTicks: bigint | null;
  markParts: Prisma.JsonValue | null;
  markRunners: Prisma.JsonValue | null;
}

export const MARK_SELECT = { markBootId: true, markTicks: true, markParts: true, markRunners: true } as const;

const KINDS = ['screen', 'part', 'gateway'];

/** The mark a computer row holds, or null when it holds none (or one that is not a mark: it is never sent). */
export function savedMark(row: MarkColumns | null | undefined): MachineMark | null {
  if (!row || !row.markBootId || row.markTicks === null || row.markTicks === undefined) return null;
  const ticks = Number(row.markTicks);
  // A list that is not a list is a damaged row, not an empty one: no mark, so the machine is stopped without a fence (an empty list is a real answer: nothing but the computer's own was running)
  if (!Array.isArray(row.markParts) || !Array.isArray(row.markRunners)) return null;
  const parts = row.markParts as unknown[];
  const runners = row.markRunners as unknown[];
  const mark: MachineMark = {
    bootId: row.markBootId,
    ticks,
    parts: parts.filter((part): part is MarkPart => !!part && typeof part === 'object' && KINDS.includes((part as MarkPart).kind) && Number.isSafeInteger((part as MarkPart).pid) && Number.isSafeInteger((part as MarkPart).start)),
    runners: runners.filter((runner): runner is string => typeof runner === 'string'),
  };
  // A list with something in it that was not a part, or a runner that was not a fingerprint, is a damaged one: no mark, so no fence is proved on it
  if (mark.parts.length !== parts.length || mark.runners.length !== runners.length) return null;
  return validMark(mark) ? mark : null;
}

/**
 * What a ready computer writes to its row: the first mark of this boot stays whole (its clock reading and its fingerprints), a new boot gets
 * the new one, and the parts are always the freshest list (the ready step has just brought them up).
 */
export function markUpdate(held: { markBootId: string | null }, mark: MachineMark): Prisma.BrickComputerUpdateInput {
  const parts = mark.parts as unknown as Prisma.InputJsonValue;
  if (held.markBootId === mark.bootId) return { markParts: parts };
  return { markBootId: mark.bootId, markTicks: BigInt(mark.ticks), markParts: parts, markRunners: mark.runners as unknown as Prisma.InputJsonValue };
}

/**
 * Reads the computer's own parts again and saves them: called right after Orbit restarted the browser itself. Only for the same boot (a
 * restarted computer is marked again by the next wake), only while the machine is still `working`. Best effort and never throws: a list that
 * could not be saved is logged, and the fence then stops what it does not know (a browser the computer restarted) instead of trusting it.
 */
export async function refreshMarkParts(botId: string, ref: string, provider: ComputerProvider, /** A caller that holds the clean claim renews it here first and says whether it is still held: the parts are not read (and saved) under a claim that went stale or was taken by another (Sentry on #1033). */ held?: () => Promise<boolean>): Promise<boolean> {
  try {
    if (held && !(await held())) return false;
    const done = await provider.exec(ref, markCommand(), { timeoutMs: 30_000 });
    const mark = done.exitCode === 0 ? parseMark(done.stdout) : null;
    if (!mark) {
      console.error('[Computer] The computer’s parts could not be read after a restart');
      return false;
    }
    const saved = await prisma.brickComputer.updateMany({ where: { botId, providerRef: ref, machine: 'working', markBootId: mark.bootId }, data: { markParts: mark.parts as unknown as Prisma.InputJsonValue } });
    return saved.count === 1;
  } catch (error) {
    console.error('[Computer] The computer’s parts could not be saved after a restart:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}
