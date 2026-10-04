import { Prisma } from '@prisma/client';

/** A small in-memory stand-in for the Prisma calls lib/friends.ts makes. */

export type FakeUser = { id: string; uuid: string; name: string | null; matrixChatId: string | null; isGuest: boolean };
export type FakeFriendship = {
  id: string;
  user1Id: string;
  user2Id: string;
  status: string;
  requestedById: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
};

export const db = {
  users: [] as FakeUser[],
  friendships: [] as FakeFriendship[],
  preferences: [] as { userId: string; key: string; value: unknown }[],
  members: [] as { userId: string; worldId: string; worldName: string; universeName: string }[],
  visits: [] as { userId: string; worldId: string; worldName: string; accessedAt: Date }[],
  reset() {
    this.users.length = 0;
    this.friendships.length = 0;
    this.preferences.length = 0;
    this.members.length = 0;
    this.visits.length = 0;
  },
};

let nextId = 0;

type Where = Record<string, unknown>;

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
    const e = expected as Record<string, unknown>;
    if ('in' in e) return (e.in as unknown[]).includes(actual);
    if ('not' in e) return actual !== e.not;
    if ('gte' in e) return (actual as Date) >= (e.gte as Date);
  }
  return actual === expected;
}

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return (expected as Where[]).some((w) => matches(row, w));
    return matchValue(row[key], expected);
  });
}

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>) {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

export const fakePrisma = {
  user: {
    findUnique: jest.fn(async ({ where, select }: { where: { uuid: string }; select?: Record<string, unknown> }) => {
      const user = db.users.find((u) => u.uuid === where.uuid);
      return user ? pick(user, select) : null;
    }),
    findMany: jest.fn(async ({ where, take }: { where: Where; take?: number }) => {
      const { preferences, name, ...rest } = where as Where & {
        preferences?: { some: { key: string; value: { equals: unknown } } };
        name?: { contains: string };
      };
      let users = db.users.filter((u) => matches(u, rest));
      if (name) users = users.filter((u) => (u.name ?? '').toLowerCase().includes(name.contains.toLowerCase()));
      if (preferences) {
        const { key, value } = preferences.some;
        users = users.filter((u) => db.preferences.some((p) => p.userId === u.id && p.key === key && p.value === value.equals));
      }
      users = [...users].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
      return users.slice(0, take ?? users.length).map((u) => ({
        ...u,
        worldMemberships: db.members
          .filter((m) => m.userId === u.id)
          .map((m) => ({ world: { universe: { name: m.universeName } } })),
      }));
    }),
  },
  userPreference: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      db.preferences.filter((p) => matches(p, where)).map((p) => ({ ...p }))),
    upsert: jest.fn(async ({ where, create, update }: {
      where: { userId_key: { userId: string; key: string } };
      create: { userId: string; key: string; value: unknown };
      update: { value: unknown };
    }) => {
      const existing = db.preferences.find((p) => p.userId === where.userId_key.userId && p.key === where.userId_key.key);
      if (existing) existing.value = update.value;
      else db.preferences.push({ ...create });
      return existing ?? create;
    }),
  },
  worldMember: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      db.members.filter((m) => matches(m, where)).map((m) => ({ userId: m.userId, worldId: m.worldId, world: { name: m.worldName } }))),
  },
  roomAccess: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      db.visits.filter((v) => matches(v, where)).map((v) => ({ userId: v.userId, worldId: v.worldId, world: { name: v.worldName } }))),
  },
  friendship: {
    findUnique: jest.fn(async ({ where }: { where: { user1Id_user2Id: { user1Id: string; user2Id: string } } }) => {
      const row = db.friendships.find((f) => matches(f, where.user1Id_user2Id));
      return row ? { ...row } : null;
    }),
    findMany: jest.fn(async ({ where }: { where: Where }) => db.friendships.filter((f) => matches(f, where)).map((f) => ({ ...f }))),
    count: jest.fn(async ({ where }: { where: Where }) => db.friendships.filter((f) => matches(f, where)).length),
    create: jest.fn(async ({ data }: { data: Omit<FakeFriendship, 'id' | 'createdAt' | 'acceptedAt'> }) => {
      if (db.friendships.some((f) => f.user1Id === data.user1Id && f.user2Id === data.user2Id)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      }
      const row = { id: `f${++nextId}`, createdAt: new Date(Date.now() + nextId), acceptedAt: null, ...data };
      db.friendships.push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeFriendship> }) => {
      const row = db.friendships.find((f) => f.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<FakeFriendship> }) => {
      const rows = db.friendships.filter((f) => matches(f, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    }),
    deleteMany: jest.fn(async ({ where }: { where: Where }) => {
      const before = db.friendships.length;
      const keep = db.friendships.filter((f) => !matches(f, where));
      db.friendships.length = 0;
      db.friendships.push(...keep);
      return { count: before - keep.length };
    }),
  },
  $transaction: jest.fn(async (writes: Promise<unknown>[]) => Promise.all(writes)),
};

export function addUser(id: string, name: string, extra: Partial<FakeUser> = {}): FakeUser {
  const user = { id, uuid: `uuid-${id}`, name, matrixChatId: `@${id}:chat`, isGuest: false, ...extra };
  db.users.push(user);
  return user;
}
