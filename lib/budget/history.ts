import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The change history of the Budget page's numbers: who, when, which number, the old value and the new one. A line is written in the same
 * transaction as the save (`recordChanges`), so a number never changes without it and a save that fails leaves no line. Every way of changing
 * a number goes through a function that calls this: `saveMeterSettings` (so the old PATCH /api/admin/meter-settings is recorded too),
 * `saveInstantLimits` and the page's own settings.
 */

export type BudgetStore = 'meter' | 'instant' | 'budget';

export interface BudgetChangeInput {
  store: BudgetStore;
  key: string;
  oldValue: number | null;
  newValue: number | null;
  note?: string | null;
}

type Tx = Pick<Prisma.TransactionClient, 'budgetChange'>;

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The numbers that really changed between what was saved and what is saved now, for the names a save carried: a save that changes nothing leaves nothing. */
export function changesBetween(store: BudgetStore, keys: string[], before: Record<string, unknown>, after: Record<string, unknown>, note?: string): BudgetChangeInput[] {
  const out: BudgetChangeInput[] = [];
  for (const key of keys) {
    const oldValue = asNumber(before[key]);
    const newValue = asNumber(after[key]);
    if (oldValue === newValue) continue;
    out.push({ store, key, oldValue, newValue, ...(note ? { note } : {}) });
  }
  return out;
}

/** Writes the lines of one save, in the transaction that saved the numbers. */
export async function recordChanges(tx: Tx, changes: BudgetChangeInput[], userId: string | null, at: Date = new Date()): Promise<void> {
  if (changes.length === 0) return;
  await tx.budgetChange.createMany({
    data: changes.map((change) => ({
      store: change.store,
      key: change.key,
      oldValue: change.oldValue === null ? null : BigInt(change.oldValue),
      newValue: change.newValue === null ? null : BigInt(change.newValue),
      changedById: userId,
      changedAt: at,
      note: change.note ?? null,
    })),
  });
}

export interface ChangeLine {
  id: string;
  store: string;
  key: string;
  oldValue: number | null;
  newValue: number | null;
  changedById: string | null;
  changedAt: string;
  note: string | null;
}

/** The newest lines first, optionally for one number, with the one who made each (their name is looked up by the caller). */
export async function listChanges(options: { take?: number; store?: string; key?: string } = {}, db: Pick<typeof prisma, 'budgetChange'> = prisma): Promise<ChangeLine[]> {
  const rows = await db.budgetChange.findMany({
    where: { ...(options.store ? { store: options.store } : {}), ...(options.key ? { key: options.key } : {}) },
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    take: options.take ?? 100,
  });
  return rows.map((row) => ({
    id: row.id,
    store: row.store,
    key: row.key,
    oldValue: row.oldValue === null ? null : Number(row.oldValue),
    newValue: row.newValue === null ? null : Number(row.newValue),
    changedById: row.changedById,
    changedAt: row.changedAt.toISOString(),
    note: row.note,
  }));
}

/** The last change of each number: "last changed by, when", for the row that shows it. */
export async function lastChanges(db: Pick<typeof prisma, 'budgetChange'> = prisma): Promise<Map<string, ChangeLine>> {
  const rows = await db.budgetChange.findMany({ orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], distinct: ['store', 'key'] });
  const out = new Map<string, ChangeLine>();
  for (const row of rows) {
    out.set(`${row.store}:${row.key}`, {
      id: row.id,
      store: row.store,
      key: row.key,
      oldValue: row.oldValue === null ? null : Number(row.oldValue),
      newValue: row.newValue === null ? null : Number(row.newValue),
      changedById: row.changedById,
      changedAt: row.changedAt.toISOString(),
      note: row.note,
    });
  }
  return out;
}
