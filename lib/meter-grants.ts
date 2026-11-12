import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { GRANT_SETTLEMENTS, type GrantSettlement } from '@/lib/meter-values';

/**
 * Extra usage given to a member (game #1998, Brick 7). Recorded once under its key: a retry, a double tap or a second super
 * admin giving the same thing again finds the first record and adds nothing. A gift and extra usage to be billed are two kinds
 * of record and never one:
 *
 *  - A gift is free to the person and is never owed, so it can never be "billed".
 *  - Extra usage to be billed records something agreed with the person before it was given, outside the product; its note holds
 *    what was agreed, and "billed" records that it was, and when.
 *  - A request for more is only a request and creates no record here at all; asking never creates a debt.
 *
 * The screens that give and list these are a later issue (game #1999). This is only the books they will write to.
 */

export interface GrantInput {
  /** Makes the grant once: the same key again gives nothing more. */
  grantKey: string;
  personId: string;
  settlement: GrantSettlement;
  /** 2 for double, 5 for five times, never a multiple of a multiple (the allowance takes the largest one running). Leave out for no limit. */
  multiplier?: number | null;
  /** Lifts the member's own limit while it lasts; our pool and capacity still hold. */
  noLimit?: boolean;
  startsAt: Date;
  /** Every grant ends. */
  endsAt: Date;
  givenById: string;
  /** What was agreed, for extra usage to be billed. */
  note?: string | null;
}

export interface Grant {
  id: string;
  grantKey: string;
  personId: string;
  settlement: GrantSettlement;
  multiplier: number | null;
  noLimit: boolean;
  startsAt: Date;
  endsAt: Date;
  givenById: string;
  note: string | null;
  billedAt: Date | null;
}

export class GrantRefused extends Error {}

/** The key was already used, for figures that are not these (most likely changed since by another admin): something is saved under it. */
export class GrantKeyUsed extends GrantRefused {}

const view = (row: { id: string; grantKey: string; personId: string; settlement: string; multiplier: number | null; noLimit: boolean; startsAt: Date; endsAt: Date; givenById: string; note: string | null; billedAt: Date | null }): Grant => ({
  id: row.id,
  grantKey: row.grantKey,
  personId: row.personId,
  settlement: row.settlement as GrantSettlement,
  multiplier: row.multiplier,
  noLimit: row.noLimit,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  givenById: row.givenById,
  note: row.note,
  billedAt: row.billedAt,
});

/**
 * Records a grant once. Returns it and whether this call wrote it. The same key with other figures is refused (GrantRefused):
 * the first record stands, and whoever asked twice for different things is told so instead of getting one of them quietly.
 */
export async function recordGrant(input: GrantInput, db: Pick<Prisma.TransactionClient, 'user' | 'meterGrant'> = prisma): Promise<{ grant: Grant; recorded: boolean }> {
  if (!input.grantKey || input.grantKey.length > 255) throw new GrantRefused('grantKey is required (up to 255 characters)');
  if (!(GRANT_SETTLEMENTS as readonly string[]).includes(input.settlement)) throw new GrantRefused('settlement must be gift or to_bill');
  const noLimit = input.noLimit === true;
  const multiplier = noLimit ? null : (input.multiplier ?? null);
  if (noLimit && input.multiplier) throw new GrantRefused('A grant is a multiple or no limit, not both');
  if (!noLimit && (multiplier === null || !Number.isInteger(multiplier) || multiplier < 2)) throw new GrantRefused('multiplier must be a whole number, 2 or more (or no limit)');
  if (!(input.endsAt > input.startsAt)) throw new GrantRefused('Extra usage must end after it starts');
  if (input.note && input.note.length > 1000) throw new GrantRefused('note is too long (up to 1000 characters)');
  const person = await db.user.findUnique({ where: { id: input.personId }, select: { id: true } });
  if (!person) throw new GrantRefused('That person does not exist');

  const { count } = await db.meterGrant.createMany({
    data: [
      {
        grantKey: input.grantKey,
        personId: input.personId,
        settlement: input.settlement,
        multiplier,
        noLimit,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        givenById: input.givenById,
        note: input.note?.trim() ? input.note.trim() : null,
      },
    ],
    skipDuplicates: true,
  });
  const row = await db.meterGrant.findUniqueOrThrow({ where: { grantKey: input.grantKey } });
  if (count === 0) {
    const same =
      row.personId === input.personId &&
      row.settlement === input.settlement &&
      row.multiplier === multiplier &&
      row.noLimit === noLimit;
    // The times are not compared: a retry of the same tap starts a moment later (and "30 days" ends a moment later), and it is
    // still the same grant. The first one stands.
    if (!same) throw new GrantKeyUsed('That key was used for a different grant. The first one stands.');
  }
  return { grant: view(row), recorded: count > 0 };
}

/**
 * "Mark as billed": says extra usage to be billed was billed, and when. Said once; saying it again keeps the first time. A gift
 * is never owed, so it cannot be marked: it says `not_billable`.
 */
export async function markGrantBilled(grantKey: string, now: Date = new Date()): Promise<'billed' | 'already_billed' | 'not_billable' | 'not_found'> {
  const { count } = await prisma.meterGrant.updateMany({ where: { grantKey, settlement: 'to_bill', billedAt: null }, data: { billedAt: now } });
  if (count > 0) return 'billed';
  const row = await prisma.meterGrant.findUnique({ where: { grantKey }, select: { settlement: true, billedAt: true } });
  if (!row) return 'not_found';
  return row.settlement === 'to_bill' ? 'already_billed' : 'not_billable';
}

/** What is running for a person at a moment: the largest extra usage (no limit beats any multiple); null when none runs. */
export interface RunningExtra {
  grantKey: string;
  /** Null for no limit. */
  multiplier: number | null;
  noLimit: boolean;
  endsAt: Date;
}

/**
 * Of the extra usage running for one person, the one to report: the largest (no limit beats any multiple, never a multiple of a
 * multiple); of two the same size, the one that ends later, since that is when the person's limit really goes back (and of two that
 * end together, the one with the smaller key, so it is never a matter of the order the rows came in). The usage page,
 * the replies' limit and the Costs page all pick through this, so they say the same thing.
 */
export function pickRunning<T extends { grantKey: string; multiplier: number | null; noLimit: boolean; endsAt: Date }>(rows: readonly T[]): T | null {
  const rank = (row: { multiplier: number | null; noLimit: boolean }) => (row.noLimit ? Infinity : (row.multiplier ?? 1));
  let best: T | null = null;
  for (const row of rows) {
    // Same size and same end: the smaller key, so the same one is picked whatever order the rows came in
    const better = !best || rank(row) > rank(best) || (rank(row) === rank(best) && (row.endsAt > best.endsAt || (row.endsAt.getTime() === best.endsAt.getTime() && row.grantKey < best.grantKey)));
    if (better) best = row;
  }
  return best;
}

/** The extra usage running for a person right now, for the replies' limit and the usage page (see `pickRunning`). */
export async function runningExtra(personId: string, now: Date = new Date(), db: Pick<typeof prisma, 'meterGrant'> = prisma): Promise<RunningExtra | null> {
  const rows = await db.meterGrant.findMany({ where: { personId, startsAt: { lte: now }, endsAt: { gt: now } }, select: { grantKey: true, multiplier: true, noLimit: true, endsAt: true } });
  const best = pickRunning(rows);
  return best ? { grantKey: best.grantKey, multiplier: best.noLimit ? null : best.multiplier, noLimit: best.noLimit, endsAt: best.endsAt } : null;
}

export interface GrantChange {
  multiplier?: number | null;
  noLimit?: boolean;
  endsAt?: Date;
  note?: string | null;
}

/**
 * "Change": a running extra usage's amount, end or note. What was agreed and billed is not rewritten: extra usage already marked
 * billed, one that ended, and the choice between a gift and extra usage to bill all stay as they were. Give a new one instead.
 */
export async function changeGrant(grantKey: string, change: GrantChange, now: Date = new Date()): Promise<Grant> {
  const row = await prisma.meterGrant.findUnique({ where: { grantKey } });
  if (!row) throw new GrantRefused('That extra usage does not exist');
  if (row.endsAt <= now) throw new GrantRefused('That extra usage has ended. Give a new one instead.');
  if (row.billedAt) throw new GrantRefused('That extra usage is marked billed. Give a new one instead.');
  const noLimit = change.noLimit ?? (change.multiplier === undefined ? row.noLimit : false);
  const multiplier = noLimit ? null : change.multiplier === undefined ? row.multiplier : change.multiplier;
  if (!noLimit && (multiplier === null || !Number.isInteger(multiplier) || multiplier < 2)) throw new GrantRefused('multiplier must be a whole number, 2 or more (or no limit)');
  const endsAt = change.endsAt ?? row.endsAt;
  if (!(endsAt > now)) throw new GrantRefused('Extra usage must end in the future. To stop it now, use End it now.');
  const note = change.note === undefined ? row.note : change.note?.trim() ? change.note.trim().slice(0, 1000) : null;
  // Only what was changed is written, and only while the grant is still running and not billed: two admins at the same moment
  // cannot reopen an ended grant, change a billed one, or undo each other's other fields.
  const data: Prisma.MeterGrantUpdateManyMutationInput = {};
  if (change.multiplier !== undefined || change.noLimit !== undefined) Object.assign(data, { multiplier, noLimit });
  if (change.endsAt !== undefined) data.endsAt = endsAt;
  if (change.note !== undefined) data.note = note;
  const { count } = await prisma.meterGrant.updateMany({ where: { grantKey, billedAt: null, endsAt: { gt: now } }, data });
  if (count === 0) {
    const now2 = await prisma.meterGrant.findUnique({ where: { grantKey } });
    if (!now2) throw new GrantRefused('That extra usage does not exist');
    if (now2.billedAt) throw new GrantRefused('That extra usage is marked billed. Give a new one instead.');
    throw new GrantRefused('That extra usage has ended. Give a new one instead.');
  }
  const updated = await prisma.meterGrant.findUniqueOrThrow({ where: { grantKey } });
  return view(updated);
}

/** "End it now": a running extra usage stops this moment. What it already covered stays covered; it is still listed, as ended. */
export async function endGrantNow(grantKey: string, now: Date = new Date()): Promise<'ended' | 'already_ended' | 'not_found'> {
  const row = await prisma.meterGrant.findUnique({ where: { grantKey }, select: { startsAt: true, endsAt: true } });
  if (!row) return 'not_found';
  if (row.endsAt <= now) return 'already_ended';
  // One that has not started yet never runs: it ends where it would have begun, and the database holds an end after a start.
  // Only a grant still running is written, so two admins ending it at the same moment (or one changing it) cannot reopen it.
  const never = row.startsAt >= now;
  const { count } = await prisma.meterGrant.updateMany({
    where: { grantKey, endsAt: { gt: now } },
    data: never ? { startsAt: new Date(now.getTime() - 1000), endsAt: now } : { endsAt: now },
  });
  return count > 0 ? 'ended' : 'already_ended';
}

/** A person's extra usage, newest first. */
export async function grantsFor(personId: string): Promise<Grant[]> {
  const rows = await prisma.meterGrant.findMany({ where: { personId }, orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map(view);
}
