/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ArtifactFiles } from '@/lib/artifact-storage';

/**
 * A small in-memory stand-in for the Prisma calls lib/artifact-service.ts makes, and for the artifacts bucket, so the
 * tests run the real rules. Use it with:
 *   jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../helpers/artifacts-db').fakePrisma }))
 */
type Row = Record<string, any>;

export const db = {
  users: [] as Row[],
  bots: [] as Row[],
  artifacts: [] as Row[],
  versions: [] as Row[],
  /** The bucket: key to text (or bytes, for media). */
  files: new Map<string, string | Uint8Array>(),
  /** One opening of a private artifact each (game #1994). */
  passes: [] as Row[],
  /** Files listed to be removed from the bucket. */
  retired: [] as Row[],
  /** Make the next version insert fail, to see that its file does not stay behind. */
  failNextVersionCreate: false,
  /** Make a copy inside the bucket fail when the file it copies from has this in its key. */
  failCopyOf: null as string | null,
  /** Make the bucket refuse to remove anything. */
  failRemove: false,
  /**
   * What the next steps do, in order, in place of running as usual. 'lost': the step lands, but its answer never comes
   * (the call throws). 'undone': every line runs, then the step is taken back and the call throws. 'down': the database
   * cannot be reached, so nothing runs.
   */
  nextSteps: [] as ('lost' | 'undone' | 'down')[],
  /** app_settings rows (#666): the super admin's limits, saved under "bot-limits". */
  settings: new Map<string, unknown>(),
  reset() {
    this.settings.clear();
    this.users.length = 0;
    this.bots.length = 0;
    this.artifacts.length = 0;
    this.versions.length = 0;
    this.files.clear();
    this.passes.length = 0;
    this.retired.length = 0;
    this.failNextVersionCreate = false;
    this.failCopyOf = null;
    this.failRemove = false;
    this.nextSteps.length = 0;
  },
};

let counter = 0;
const nextId = () => `row-${++counter}`;

export function addUser(id: string, extra: Row = {}) {
  const user = { id, uuid: `uuid-${id}`, email: `${id}@example.com`, name: id[0].toUpperCase() + id.slice(1), isGuest: false, ...extra };
  db.users.push(user);
  return user;
}

export function addBot(id: string, name = 'Scout') {
  db.bots.push({ id, name });
}

export const fakeFiles: ArtifactFiles = {
  async put(key, body) {
    db.files.set(key, body);
  },
  async get(key) {
    const body = db.files.get(key);
    if (body === undefined) throw new Error(`no file ${key}`);
    return typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  },
  async read(key, range) {
    const body = db.files.get(key);
    if (body === undefined) throw new Error(`no file ${key}`);
    const bytes = typeof body === 'string' ? new Uint8Array(Buffer.from(body, 'utf8')) : body;
    return range ? bytes.slice(range.start, range.end + 1) : bytes;
  },
  async copy(fromKey, toKey) {
    if (db.failCopyOf !== null && fromKey.includes(db.failCopyOf)) throw new Error('the bucket is down');
    const body = db.files.get(fromKey);
    if (body === undefined) throw new Error(`no file ${fromKey}`);
    db.files.set(toKey, body);
  },
  async remove(keys) {
    if (db.failRemove) throw new Error('the bucket would not remove them');
    keys.forEach((key) => db.files.delete(key));
  },
  urlFor: (key) => `https://files.example.test/${key}`,
};

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return (expected as Row[]).some((cond) => matches(row, cond));
    if (key === 'AND') return (expected as Row[]).every((cond) => matches(row, cond));
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('lte' in expected) return row[key] !== null && row[key] <= expected.lte;
      if ('gt' in expected) return row[key] !== null && row[key] > expected.gt;
      if ('not' in expected) return row[key] !== expected.not;
      if ('in' in expected) return expected.in.includes(row[key]);
      if ('startsWith' in expected) return typeof row[key] === 'string' && row[key].startsWith(expected.startsWith);
    }
    // A moment is the same moment, as in the real database, whichever object holds it
    if (expected instanceof Date) return row[key] instanceof Date && row[key].getTime() === expected.getTime();
    return row[key] === expected;
  });
}

function withOwner(artifact: Row, include?: Row) {
  const out: Row = { ...artifact };
  if (include?.owner) out.owner = artifact.ownerId ? { name: db.users.find((u) => u.id === artifact.ownerId)?.name ?? null } : null;
  if (include?.versions) out.versions = db.versions.filter((v) => v.artifactId === artifact.id).sort((a, b) => a.number - b.number);
  return out;
}

function createVersion(data: Row) {
  if (db.versions.some((v) => v.artifactId === data.artifactId && v.number === data.number)) throw new Error('unique violation');
  const row = { id: nextId(), summary: null, askedById: null, askedByName: null, media: [], createdAt: new Date(), ...data };
  db.versions.push(row);
  return row;
}

const client: Row = {
  user: {
    findFirst: async ({ where }: Row) => db.users.find((user) => where.OR.some((cond: Row) => cond.uuid === user.uuid || cond.email === user.email)) ?? null,
  },
  bot: { findUnique: async ({ where }: Row) => db.bots.find((bot) => bot.id === where.id) ?? null },
  appSetting: {
    findUnique: async ({ where }: Row) => (db.settings.has(where.key) ? { key: where.key, value: db.settings.get(where.key) } : null),
  },
  artifact: {
    create: async ({ data, include }: Row) => {
      const { versions, ...fields } = data;
      const now = new Date();
      const row = { ownerId: null, chatKind: null, chatRef: null, openScope: 'chat', changeScope: 'owner', latestVersion: 1, copiedFromId: null, expiresAt: null, createdAt: now, updatedAt: now, ...fields };
      db.artifacts.push(row);
      if (versions?.create) createVersion({ artifactId: row.id, ...versions.create });
      return withOwner(row, include);
    },
    findUnique: async ({ where, include }: Row) => {
      const row = db.artifacts.find((a) => a.id === where.id);
      return row ? withOwner(row, include) : null;
    },
    findMany: async ({ where = {}, include, orderBy, skip, take, select }: Row) => {
      let rows = db.artifacts.filter((a) => matches(a, where));
      const order: Row[] = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
      if (order.some((one) => one.updatedAt === 'desc')) {
        rows = [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (order.some((one) => one.id === 'desc') ? String(b.id).localeCompare(String(a.id)) : 0));
      }
      if (skip) rows = rows.slice(skip);
      if (take) rows = rows.slice(0, take);
      return rows.map((row) => {
        if (select) return { id: row.id, versions: db.versions.filter((v) => v.artifactId === row.id).map((v) => ({ fileKey: v.fileKey, media: v.media })) };
        return withOwner(row, include);
      });
    },
    count: async ({ where = {} }: Row) => db.artifacts.filter((a) => matches(a, where)).length,
    updateMany: async ({ where, data }: Row) => {
      const rows = db.artifacts.filter((a) => matches(a, where));
      rows.forEach((row) => Object.assign(row, data, { updatedAt: new Date() }));
      return { count: rows.length };
    },
    update: async ({ where, data, include }: Row) => {
      const row = db.artifacts.find((a) => a.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return withOwner(row, include);
    },
    deleteMany: async ({ where }: Row) => {
      const gone = db.artifacts.filter((a) => matches(a, where)).map((a) => a.id);
      db.artifacts = db.artifacts.filter((a) => !gone.includes(a.id)) as typeof db.artifacts;
      db.versions = db.versions.filter((v) => !gone.includes(v.artifactId)) as typeof db.versions;
      // As the database does: a pass goes with its artifact
      db.passes = db.passes.filter((pass) => !gone.includes(pass.artifactId)) as typeof db.passes;
      return { count: gone.length };
    },
  },
  artifactVersion: {
    findUnique: async ({ where }: Row) => {
      const key = where.artifactId_number;
      return db.versions.find((v) => v.artifactId === key.artifactId && v.number === key.number) ?? null;
    },
    findMany: async ({ where, orderBy }: Row) => {
      const rows = db.versions.filter((v) => matches(v, where));
      return orderBy?.number === 'desc' ? [...rows].sort((a, b) => b.number - a.number) : rows;
    },
    create: async ({ data }: Row) => {
      if (db.failNextVersionCreate) {
        db.failNextVersionCreate = false;
        throw new Error('database is down');
      }
      return createVersion(data);
    },
    update: async ({ where, data }: Row) => {
      const row = db.versions.find((v) => v.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = db.versions.filter((v) => matches(v, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
  },
  artifactPass: {
    create: async ({ data }: Row) => {
      if (db.passes.some((pass) => pass.tokenHash === data.tokenHash)) throw new Error('unique violation');
      const row = { id: nextId(), cookieHash: null, redeemedAt: null, createdAt: new Date(), ...data };
      db.passes.push(row);
      return row;
    },
    findUnique: async ({ where }: Row) => db.passes.find((pass) => pass.tokenHash === where.tokenHash) ?? null,
    updateMany: async ({ where, data }: Row) => {
      const rows = db.passes.filter((pass) => matches(pass, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Row) => {
      const before = db.passes.length;
      db.passes = db.passes.filter((pass) => !matches(pass, where)) as typeof db.passes;
      return { count: before - db.passes.length };
    },
  },
  artifactRetiredFile: {
    createMany: async ({ data }: Row) => {
      const fresh = (data as Row[]).filter((row) => !db.retired.some((kept) => kept.key === row.key));
      fresh.forEach((row) => db.retired.push({ createdAt: new Date(), ...row }));
      return { count: fresh.length };
    },
    findMany: async ({ where = {}, take }: Row) => db.retired.filter((row) => matches(row, where)).slice(0, take),
    deleteMany: async ({ where }: Row) => {
      const before = db.retired.length;
      db.retired = db.retired.filter((row) => !matches(row, where)) as typeof db.retired;
      return { count: before - db.retired.length };
    },
  },
  // Holding a row is all the service asks of a query written out by hand
  $queryRaw: async () => [],
  // As the database does: a step that fails leaves no row changed. (The bucket is no part of it, as in real life.)
  $transaction: async (fn: (tx: Row) => Promise<unknown>) => {
    const how = db.nextSteps.shift();
    if (how === 'down') throw new Error('the database cannot be reached');
    const copyOf = (rows: Row[]) => rows.map((row) => ({ ...row }));
    const before = { artifacts: copyOf(db.artifacts), versions: copyOf(db.versions), passes: copyOf(db.passes), retired: copyOf(db.retired) };
    try {
      const result = await fn(client);
      if (how === 'undone') throw new Error('the step ran out of time as it ended');
      if (how === 'lost') {
        // Landed: nothing is taken back, and the caller is told it failed
        Object.keys(before).forEach((table) => delete (before as Row)[table]);
        throw new Error('the connection dropped');
      }
      return result;
    } catch (error) {
      Object.assign(db, before);
      throw error;
    }
  },
};

export const fakePrisma = client;
