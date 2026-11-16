import { prisma } from '@/lib/db';

/**
 * Who pays, in words (paying spec 3, part O4): a small label on a task, in chat and in Activity, that names the real payer.
 * "Paid by you", "Paid by Universe" or "Paid by BAWES Universe". Chat never shows a price per step; this is the one place the
 * payer is named, and it never changes how anything is charged.
 */

export type Payer =
  /** A person's own credit or accounts. */
  | { kind: 'person'; personId: string; name: string | null }
  /** The platform: Universe itself. */
  | { kind: 'platform' }
  /** Somebody else who pays for the task: a universe, or another person, by name. */
  | { kind: 'sponsor'; name: string };

/** What the game reads: "you", "universe" or "sponsor" (with the sponsor's name). */
export type PayerWho = 'you' | 'universe' | 'sponsor';

export interface PaidBy {
  payer: PayerWho;
  /** The sponsor's name, for "sponsor". */
  payerName: string | null;
  /** The label, from the reader's side: "Paid by you". */
  label: string;
}

const clean = (name: string | null | undefined): string | null => {
  const trimmed = name?.trim();
  return trimmed ? trimmed.slice(0, 100) : null;
};

/** The label for a payer as one reader sees it: their own task says "you", someone else's names them. */
export function paidBy(payer: Payer, readerId: string | null): PaidBy {
  if (payer.kind === 'platform') return { payer: 'universe', payerName: null, label: 'Paid by Universe' };
  if (payer.kind === 'person') {
    if (readerId !== null && payer.personId === readerId) return { payer: 'you', payerName: null, label: 'Paid by you' };
    const name = clean(payer.name);
    return name ? { payer: 'sponsor', payerName: name, label: `Paid by ${name}` } : { payer: 'sponsor', payerName: null, label: 'Paid by someone else' };
  }
  const name = clean(payer.name);
  return name ? { payer: 'sponsor', payerName: name, label: `Paid by ${name}` } : { payer: 'universe', payerName: null, label: 'Paid by Universe' };
}

/** A payer as a receipt keeps it (kind, who, name), so it reads the same later whatever is renamed. */
export interface PayerRow {
  payerKind: string;
  payerPersonId: string | null;
  payerName: string | null;
}

export const payerToRow = (payer: Payer): PayerRow =>
  payer.kind === 'person'
    ? { payerKind: 'person', payerPersonId: payer.personId, payerName: clean(payer.name) }
    : payer.kind === 'sponsor'
      ? { payerKind: 'sponsor', payerPersonId: null, payerName: clean(payer.name) }
      : { payerKind: 'platform', payerPersonId: null, payerName: null };

export const payerFromRow = (row: PayerRow): Payer =>
  row.payerKind === 'person' && row.payerPersonId
    ? { kind: 'person', personId: row.payerPersonId, name: row.payerName }
    : row.payerKind === 'sponsor' && row.payerName
      ? { kind: 'sponsor', name: row.payerName }
      : { kind: 'platform' };

/**
 * Who pays for work a bot does, from what is known today (the label says "you" to the owner and names them to anyone else, see `paidBy`):
 *  - a Brick: its owner does, since nobody who visits is charged for a Brick's computer or Apps;
 *  - a room bot: Universe itself, until a universe's funding is named. A caller that knows a universe pays (a funding account) says so
 *    with `sponsor`, and the label names it ("BAWES Universe").
 */
export async function payerOf(botId: string, sponsor: { name: string } | null = null): Promise<Payer> {
  if (sponsor) return { kind: 'sponsor', name: sponsor.name };
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true, owner: { select: { name: true } } } });
  if (!bot || bot.deletedAt !== null) return { kind: 'platform' };
  if (bot.roomId === null && bot.ownerId) return { kind: 'person', personId: bot.ownerId, name: bot.owner?.name ?? null };
  return { kind: 'platform' };
}
