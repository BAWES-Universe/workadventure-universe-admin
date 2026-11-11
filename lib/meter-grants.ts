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
export async function recordGrant(input: GrantInput): Promise<{ grant: Grant; recorded: boolean }> {
  if (!input.grantKey || input.grantKey.length > 255) throw new GrantRefused('grantKey is required (up to 255 characters)');
  if (!(GRANT_SETTLEMENTS as readonly string[]).includes(input.settlement)) throw new GrantRefused('settlement must be gift or to_bill');
  const noLimit = input.noLimit === true;
  const multiplier = noLimit ? null : (input.multiplier ?? null);
  if (noLimit && input.multiplier) throw new GrantRefused('A grant is a multiple or no limit, not both');
  if (!noLimit && (multiplier === null || !Number.isInteger(multiplier) || multiplier < 2)) throw new GrantRefused('multiplier must be a whole number, 2 or more (or no limit)');
  if (!(input.endsAt > input.startsAt)) throw new GrantRefused('Extra usage must end after it starts');
  if (input.note && input.note.length > 1000) throw new GrantRefused('note is too long (up to 1000 characters)');
  const person = await prisma.user.findUnique({ where: { id: input.personId }, select: { id: true } });
  if (!person) throw new GrantRefused('That person does not exist');

  const { count } = await prisma.meterGrant.createMany({
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
  const row = await prisma.meterGrant.findUniqueOrThrow({ where: { grantKey: input.grantKey } });
  if (count === 0) {
    const same =
      row.personId === input.personId &&
      row.settlement === input.settlement &&
      row.multiplier === multiplier &&
      row.noLimit === noLimit &&
      row.startsAt.getTime() === input.startsAt.getTime() &&
      row.endsAt.getTime() === input.endsAt.getTime();
    if (!same) throw new GrantRefused('That key was used for a different grant. The first one stands.');
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
