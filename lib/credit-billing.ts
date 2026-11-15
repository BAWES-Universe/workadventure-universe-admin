import { prisma } from '@/lib/db';

/**
 * "Mark as billed" for credit that was agreed to be billed (paying spec v3, section 3, kind 3). Credit to be billed records something agreed
 * with the person outside the product; marking it says it was billed, and when. It never means "paid", never refills a funding account as
 * if payment arrived, and free credit (a gift) can never be marked: it is never owed. Said once; saying it again keeps the first time.
 */
export async function markCreditBilled(input: { lotId?: string; programId?: string }, now: Date = new Date()): Promise<{ billed: number; result: 'billed' | 'already_billed' | 'not_billable' | 'not_found' }> {
  const where = input.lotId ? { id: input.lotId } : input.programId ? { programId: input.programId } : null;
  if (!where) throw new RangeError('lotId or programId is required');
  const { count } = await prisma.creditLot.updateMany({ where: { ...where, settlement: 'to_bill', billedAt: null }, data: { billedAt: now } });
  if (count > 0) return { billed: count, result: 'billed' };
  const rows = await prisma.creditLot.findMany({ where, select: { settlement: true, billedAt: true } });
  if (rows.length === 0) return { billed: 0, result: 'not_found' };
  return { billed: 0, result: rows.some((row) => row.settlement === 'to_bill') ? 'already_billed' : 'not_billable' };
}
