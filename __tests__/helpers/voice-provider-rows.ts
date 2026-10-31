/**
 * A small in-memory stand-in for the `voiceProvider` rows the key-health code reads and writes (#749): it understands only
 * the `where` and `data` shapes lib/voice-key-health.ts uses, so a test shows what the rows end up as.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderRow = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = Record<string, any>;

const is = (value: unknown, test: unknown): boolean => {
  if (test !== null && typeof test === 'object' && !(test instanceof Date)) {
    const t = test as Record<string, unknown>;
    if ('not' in t) return !is(value, t.not);
    if ('gt' in t) return (value as number) > (t.gt as number);
    if ('lt' in t) return value !== null && value !== undefined && (value as Date).getTime() < (t.lt as Date).getTime();
  }
  return (value ?? null) === test;
};

export const matches = (row: ProviderRow, where: Where): boolean =>
  Object.entries(where).every(([field, test]) => (field === 'OR' ? (test as Where[]).some((branch) => matches(row, branch)) : is(row[field], test)));

export const applyData = (row: ProviderRow, data: ProviderRow) => {
  for (const [field, value] of Object.entries(data)) {
    row[field] = value !== null && typeof value === 'object' && !(value instanceof Date) && 'increment' in value ? (row[field] ?? 0) + (value as { increment: number }).increment : value;
  }
};

/** The `voiceProvider` delegate over `rows`. */
export const voiceProviderTable = (rows: () => ProviderRow[]) => ({
  findFirst: async ({ where }: { where: Where }) => rows().find((row) => matches(row, where)) ?? null,
  findUnique: async ({ where }: { where: Where }) => rows().find((row) => matches(row, where)) ?? null,
  updateMany: async ({ where, data }: { where: Where; data: ProviderRow }) => {
    const hit = rows().filter((row) => matches(row, where));
    for (const row of hit) applyData(row, data);
    return { count: hit.length };
  },
});
