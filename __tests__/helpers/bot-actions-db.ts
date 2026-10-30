/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A small in-memory stand-in for the Prisma calls lib/bot-actions.ts makes, so the tests run the real rules. Use it with:
 *   jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../helpers/bot-actions-db').fakePrisma }))
 *
 * Each call checks and changes its rows in one synchronous step, as one SQL statement does, so two calls started together
 * interleave only between statements, and a conditional update (`updateMany`) has exactly one winner. It also keeps the two
 * rules the database itself enforces: one row per (bot, proposal key), and one claimed attempt per request. The tables,
 * their checks and those keys are tested on a real Postgres in __tests__/migrations/bot-action-requests.test.ts, and the
 * same scenarios run on one with BOT_ACTIONS_REAL_DB=1.
 */
type Row = Record<string, any>;

export const db = {
  bots: [] as Row[],
  requests: [] as Row[],
  decisions: [] as Row[],
  attempts: [] as Row[],
  grants: [] as Row[],
  reset() {
    this.bots.length = 0;
    this.requests.length = 0;
    this.decisions.length = 0;
    this.attempts.length = 0;
    this.grants.length = 0;
    ids = 0;
  },
};

let ids = 0;
const nextId = (prefix: string) => `${prefix}-${++ids}`;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === 'attempts') {
      const children = db.attempts.filter((attempt) => attempt.requestId === row.id);
      return children.some((child) => matches(child, expected.some));
    }
    const value = row[key];
    if (expected === null) return value === null || value === undefined;
    if (expected instanceof Date) return value instanceof Date && value.getTime() === expected.getTime();
    if (typeof expected === 'object') {
      return Object.entries(expected as Row).every(([op, operand]) => {
        if (op === 'in') return (operand as any[]).includes(value);
        if (op === 'gt') return value != null && value > operand;
        if (op === 'gte') return value != null && value >= operand;
        if (op === 'lt') return value != null && value < operand;
        if (op === 'lte') return value != null && value <= operand;
        throw new Error(`fake database: unsupported ${op}`);
      });
    }
    return value === expected;
  });
}

function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) row[key] = row[key] + value.increment;
    else row[key] = value;
  }
  row.updatedAt = new Date();
}

function table(rows: Row[], prefix: string, defaults: () => Row, unique?: (row: Row, rows: Row[]) => void) {
  return {
    create: async ({ data, include }: { data: Row; include?: Row }) => {
      const row = { id: nextId(prefix), createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...stripUndefined(data) };
      unique?.(row, rows);
      rows.push(row);
      return withInclude(row, include);
    },
    findMany: async ({ where, include, orderBy }: { where?: Row; include?: Row; orderBy?: Row } = {}) => {
      const found = rows.filter((row) => matches(row, where));
      if (orderBy?.createdAt === 'desc') found.reverse();
      return found.map((row) => withInclude(row, include));
    },
    findFirst: async ({ where, include }: { where?: Row; include?: Row } = {}) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? withInclude(row, include) : null;
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const found = rows.filter((row) => matches(row, where));
      for (const row of found) apply(row, data);
      return { count: found.length };
    },
  };
}

const stripUndefined = (data: Row) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));

function withInclude(row: Row, include?: Row): Row {
  const copy = { ...row };
  if (include?.attempts) copy.attempts = db.attempts.filter((attempt) => attempt.requestId === row.id).map((attempt) => ({ ...attempt }));
  return copy;
}

const requests = table(
  db.requests,
  'req',
  () => ({ status: 'waiting', closedReason: null, revision: 1, approvedAt: null, startBy: null, finishedAt: null, connectionRef: null, rememberScope: null }),
  (row, rows) => {
    if (rows.some((other) => other.botId === row.botId && other.proposalKey === row.proposalKey)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
  },
);

const attempts = table(
  db.attempts,
  'att',
  () => ({ state: 'claimed', providerRequestId: null, outcomeClass: null, finishedAt: null, claimedAt: new Date() }),
  (row, rows) => {
    if (rows.some((other) => other.requestId === row.requestId && other.attemptNo === row.attemptNo)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    if (row.state === 'claimed' && rows.some((other) => other.requestId === row.requestId && other.state === 'claimed')) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
  },
);

const grants = table(db.grants, 'grant', () => ({ revokedAt: null, revokedReason: null, connectionRef: null }));
const decisions = table(db.decisions, 'dec', () => ({}));

export const fakePrisma: any = {
  bot: {
    findUnique: async ({ where }: { where: { id: string } }) => db.bots.find((bot) => bot.id === where.id) ?? null,
  },
  botActionRequest: {
    ...requests,
    findUnique: async ({ where, include }: { where: { botId_proposalKey: { botId: string; proposalKey: string } }; include?: Row }) => {
      const key = where.botId_proposalKey;
      const row = db.requests.find((candidate) => candidate.botId === key.botId && candidate.proposalKey === key.proposalKey);
      return row ? withInclude(row, include) : null;
    },
  },
  botActionDecision: decisions,
  botActionAttempt: attempts,
  botActionGrant: grants,
  // No rollback here: each rule under test is one conditional update, which is what the tests check.
  $transaction: async (run: (tx: any) => Promise<unknown>) => run(fakePrisma),
};
