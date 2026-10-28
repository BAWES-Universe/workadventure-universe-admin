/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A small in-memory stand-in for the Prisma calls lib/bot-files.ts makes, so the tests run the real rules. Use it with:
 *   jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/bot-files-db').fakePrisma }))
 * The tables themselves, their keys and the word index are checked on a real Postgres in __tests__/migrations/bot-files.
 */
type Row = Record<string, any>;

export const db = {
  users: [] as Row[],
  files: [] as Row[],
  parts: [] as Row[],
  counters: new Map<string, number>(),
  /** Artifacts, for the search that also finds them (only read). */
  artifacts: [] as Row[],
  /** The super admin's saved limits ("bot-limits"), or null for the recommended ones. */
  limits: null as Row | null,
  reset() {
    this.limits = null;
    this.artifacts.length = 0;
    this.users.length = 0;
    this.files.length = 0;
    this.parts.length = 0;
    this.counters.clear();
  },
};

let ids = 0;

export function addUser(id: string, extra: Row = {}) {
  const user = { id, uuid: `uuid-${id}`, email: `${id}@example.com`, name: id, isGuest: false, ...extra };
  db.users.push(user);
  return user;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return (expected as Row[]).some((cond) => matches(row, cond));
    if (key === 'AND') return (expected as Row[]).every((cond) => matches(row, cond));
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const value = row[key];
      const checks: Record<string, (operand: any) => boolean> = {
        lte: (operand) => value !== null && value <= operand,
        lt: (operand) => value !== null && value < operand,
        gt: (operand) => value !== null && value > operand,
        gte: (operand) => value !== null && value >= operand,
        in: (operand) => operand.includes(value),
        contains: (operand) => typeof value === 'string' && value.toLowerCase().includes(String(operand).toLowerCase()),
        mode: () => true,
      };
      return Object.entries(expected).every(([op, operand]) => checks[op]?.(operand) ?? false);
    }
    return row[key] === expected;
  });
}

function removeFiles(where: Row): number {
  const gone = db.files.filter((file) => matches(file, where)).map((file) => file.id);
  db.files = db.files.filter((file) => !gone.includes(file.id)) as typeof db.files;
  // The parts go with their file, as the foreign key does
  db.parts = db.parts.filter((part) => !gone.includes(part.botFileId)) as typeof db.parts;
  return gone.length;
}

const client: Row = {
  appSetting: {
    findUnique: async ({ where }: Row) => (where.key === 'bot-limits' && db.limits ? { key: 'bot-limits', value: db.limits } : null),
  },
  user: {
    findFirst: async ({ where }: Row) => db.users.find((user) => where.OR.some((cond: Row) => cond.uuid === user.uuid || cond.email === user.email)) ?? null,
  },
  botFileCounter: {
    upsert: async ({ where, create, update }: Row) => {
      const last = db.counters.has(where.botId) ? (db.counters.get(where.botId) as number) + update.last.increment : create.last;
      db.counters.set(where.botId, last);
      return { botId: where.botId, last };
    },
  },
  botFile: {
    create: async ({ data }: Row) => {
      if (db.files.some((file) => file.botId === data.botId && file.number === data.number)) throw new Error('unique violation');
      const row = { id: `file-${++ids}`, ownerId: null, personRef: null, mimeType: null, sizeBytes: null, bucket: null, fileId: null, url: null, line: null, madeWith: null, madePrompt: null, lengthSeconds: null, pages: null, textState: 'none', textChars: 0, expiresAt: null, createdAt: new Date(), ...data };
      db.files.push(row);
      return { ...row };
    },
    findUnique: async ({ where }: Row) => {
      const key = where.botId_number;
      const row = db.files.find((file) => file.botId === key.botId && file.number === key.number);
      return row ? { ...row } : null;
    },
    findMany: async ({ where, take }: Row) => db.files.filter((file) => matches(file, where)).slice(0, take ?? undefined).map((file) => ({ id: file.id })),
    update: async ({ where, data }: Row) => {
      const row = db.files.find((file) => file.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return { ...row };
    },
    deleteMany: async ({ where }: Row) => ({ count: removeFiles(where) }),
  },
  artifact: {
    count: async ({ where }: Row) => db.artifacts.filter((row) => matches(row, where)).length,
    findMany: async ({ where, take, select }: Row) =>
      db.artifacts
        .filter((row) => matches(row, where))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, take ?? undefined)
        .map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))),
  },
  botFilePart: {
    findMany: async ({ where, orderBy }: Row) => {
      const rows = db.parts.filter((part) => matches(part, where));
      return orderBy?.number === 'asc' ? [...rows].sort((a, b) => a.number - b.number) : rows;
    },
    deleteMany: async ({ where }: Row) => {
      const before = db.parts.length;
      db.parts = db.parts.filter((part) => !matches(part, where)) as typeof db.parts;
      return { count: before - db.parts.length };
    },
    createMany: async ({ data }: Row) => {
      db.parts.push(...data.map((part: Row) => ({ ...part })));
      return { count: data.length };
    },
  },
  $transaction: async (steps: Promise<unknown>[]) => Promise.all(steps),
};

export const fakePrisma = client;
