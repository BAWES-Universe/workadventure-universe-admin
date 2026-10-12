/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A small in-memory stand-in for the parts of the database the Woka rules read and write: avatar sets (with layers,
 * companions, scopes and policies), direct grants, worlds, universes, memberships, users and each person's outfits.
 * It understands the query shapes the real code uses (equality, `in`, `lte`/`gte`/`lt`/`not`, `AND`/`OR`, `some`,
 * nested relations) so the tests run the real rules, not a copy of them.
 *
 * Use it from a test with: jest.mock('@/lib/db', () => ({ prisma: require('../helpers/fake-db').fakeDb }))
 */

type Row = Record<string, any>;

export interface FakeSet {
  id: string;
  name?: string;
  lifecycle?: string;
  visibility?: string;
  availableFrom?: Date | null;
  availableUntil?: Date | null;
  position?: number;
  layers?: { textureId: string; layer?: string; name?: string | null; url?: string; isActive?: boolean }[];
  companions?: { textureId: string; name?: string | null; url?: string; isActive?: boolean }[];
  scopes?: { scopeType: string; scopeId?: string }[];
  policies?: { subjectType: string; subjectValue?: string | null; action?: string; isActive?: boolean }[];
}

export const state = {
  sets: [] as Row[],
  grants: [] as Row[],
  worlds: [] as Row[],
  universes: [] as Row[],
  members: [] as Row[],
  users: [] as Row[],
  outfits: [] as Row[],
  avatars: [] as Row[],
  nextId: 1,
};

export function resetFakeDb() {
  state.sets = [];
  state.grants = [];
  state.worlds = [];
  state.universes = [];
  state.members = [];
  state.users = [];
  state.outfits = [];
  state.avatars = [];
  state.nextId = 1;
}

export function addSet(set: FakeSet) {
  const row: Row = {
    name: set.id,
    lifecycle: 'active',
    visibility: 'public',
    availableFrom: null,
    availableUntil: null,
    position: 0,
    ...set,
    layers: (set.layers ?? []).map((layer, index) => ({
      layer: 'woka',
      name: layer.textureId,
      url: `https://play.test/${layer.textureId}.png`,
      isActive: true,
      position: index,
      ...layer,
    })),
    companions: (set.companions ?? []).map((companion, index) => ({
      name: companion.textureId,
      url: `https://play.test/${companion.textureId}.png`,
      isActive: true,
      position: index,
      ...companion,
    })),
    scopes: (set.scopes ?? [{ scopeType: 'platform' }]).map((scope) => ({ scopeId: '', ...scope })),
    policies: (set.policies ?? []).map((policy) => ({ subjectValue: null, action: 'select', isActive: true, ...policy })),
  };
  state.sets.push(row);
  return row;
}

export function addOutfit(userId: string, textureIds: string[], lastWornAt: Date, firstWornAt: Date = lastWornAt) {
  const row = { id: `o${state.nextId++}`, userId, textureIds, outfitKey: textureIds.join('|'), firstWornAt, lastWornAt };
  state.outfits.push(row);
  return row;
}

function compare(value: any, condition: any): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date || typeof condition !== 'object') {
    return condition instanceof Date ? value instanceof Date && value.getTime() === condition.getTime() : value === condition;
  }
  if (Array.isArray(value)) {
    if ('isEmpty' in condition) return (value.length === 0) === condition.isEmpty;
  }
  const operators = ['in', 'lte', 'gte', 'lt', 'gt', 'not', 'some', 'isEmpty'];
  if (!Object.keys(condition).some((key) => operators.includes(key))) return matches(value ?? {}, condition);
  return Object.entries(condition).every(([operator, expected]: [string, any]) => {
    switch (operator) {
      case 'in':
        return expected.includes(value);
      case 'lte':
        return value <= expected;
      case 'gte':
        return value >= expected;
      case 'lt':
        return value < expected;
      case 'gt':
        return value > expected;
      case 'not':
        return !compare(value, expected);
      case 'some':
        return Array.isArray(value) && value.some((item) => matches(item, expected));
      default:
        return true;
    }
  });
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (Array.isArray(condition) ? condition : [condition]).every((part: Row) => matches(row, part));
    if (key === 'OR') return (condition as Row[]).some((part) => matches(row, part));
    if (key === 'NOT') return !matches(row, condition);
    return compare(row[key], condition);
  });
}

function orderRows<T extends Row>(rows: T[], orderBy: Row | Row[] | undefined): T[] {
  if (!orderBy) return rows;
  const [field, direction] = Object.entries(Array.isArray(orderBy) ? orderBy[0] : orderBy)[0] as [string, any];
  const sign = (typeof direction === 'string' ? direction : direction?.sort) === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[field] instanceof Date ? a[field].getTime() : a[field];
    const y = b[field] instanceof Date ? b[field].getTime() : b[field];
    return x === y ? 0 : x < y ? -sign : sign;
  });
}

function findMany(rows: Row[], args: Row = {}) {
  let found = orderRows(rows.filter((row) => matches(row, args.where)), args.orderBy);
  if (args.skip) found = found.slice(args.skip);
  if (args.take !== undefined) found = found.slice(0, args.take);
  return found;
}

const live = <T extends { isActive?: boolean }>(items: T[]) => items.filter((item) => item.isActive !== false);
const withParts = (set: Row) => ({ ...set, layers: live(set.layers), companions: live(set.companions), policies: live(set.policies) });

export const fakeDb: Record<string, any> = {
  avatarSet: {
    findMany: jest.fn(async (args: Row) => findMany(state.sets, args).map(withParts)),
    count: jest.fn(async (args: Row) => findMany(state.sets, args).length),
  },
  avatarLayer: {
    findMany: jest.fn(async (args: Row) =>
      findMany(
        state.sets.flatMap((set) => set.layers.map((layer: Row) => ({ ...layer, avatarSet: set }))),
        args,
      ),
    ),
  },
  avatarCompanion: {
    findMany: jest.fn(async (args: Row) =>
      findMany(
        state.sets.flatMap((set) => set.companions.map((companion: Row) => ({ ...companion, avatarSet: set }))),
        args,
      ),
    ),
    findFirst: jest.fn(async (args: Row) =>
      findMany(
        state.sets.flatMap((set) => set.companions.map((companion: Row) => ({ ...companion, avatarSet: set }))),
        args,
      )[0] ?? null,
    ),
  },
  userAvatarGrant: {
    findMany: jest.fn(async (args: Row) =>
      findMany(
        state.grants.map((grant) => ({ ...grant, avatarSet: withParts(state.sets.find((set) => set.id === grant.avatarSetId) as Row) })),
        args,
      ),
    ),
  },
  world: {
    findUnique: jest.fn(async ({ where }: Row) => state.worlds.find((world) => world.id === where.id) ?? null),
    findFirst: jest.fn(async ({ where }: Row) => state.worlds.find((world) => matches(world, where)) ?? null),
    findMany: jest.fn(async (args: Row) => findMany(state.worlds, args)),
  },
  universe: {
    findMany: jest.fn(async (args: Row) => findMany(state.universes, args)),
  },
  worldMember: {
    findUnique: jest.fn(async ({ where }: Row) => {
      const key = where.userId_worldId;
      return state.members.find((member) => member.userId === key.userId && member.worldId === key.worldId) ?? null;
    }),
  },
  user: {
    findUnique: jest.fn(async ({ where }: Row) => state.users.find((user) => matches(user, where)) ?? null),
    findFirst: jest.fn(async ({ where }: Row) => state.users.find((user) => matches(user, where)) ?? null),
    update: jest.fn(async ({ where, data }: Row) => {
      const user = state.users.find((candidate) => matches(candidate, where));
      if (!user) throw new Error('no such user');
      Object.assign(user, data);
      return user;
    }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const found = state.users.filter((candidate) => matches(candidate, where));
      for (const user of found) Object.assign(user, data);
      return { count: found.length };
    }),
  },
  userOutfit: {
    findFirst: jest.fn(async (args: Row) => findMany(state.outfits, args)[0] ?? null),
    findMany: jest.fn(async (args: Row) => findMany(state.outfits, args)),
    // Like Prisma's delete, it throws when there is no such row (P2025)
    delete: jest.fn(async ({ where }: Row) => {
      if (!state.outfits.some((row) => row.id === where.id)) throw new Error('P2025: record to delete does not exist');
      state.outfits = state.outfits.filter((row) => row.id !== where.id);
      return {};
    }),
    deleteMany: jest.fn(async ({ where }: Row) => {
      const doomed = findMany(state.outfits, { where });
      state.outfits = state.outfits.filter((row) => !doomed.includes(row));
      return { count: doomed.length };
    }),
    upsert: jest.fn(async ({ where, create, update }: Row) => {
      const key = where.userId_outfitKey;
      const existing = state.outfits.find((row) => row.userId === key.userId && row.outfitKey === key.outfitKey);
      if (existing) return Object.assign(existing, update);
      const row = { id: `o${state.nextId++}`, ...create };
      state.outfits.push(row);
      return row;
    }),
  },
  userAvatar: {
    findUnique: jest.fn(async ({ where }: Row) => {
      const key = where.userId_worldId;
      return state.avatars.find((row) => row.userId === key.userId && row.worldId === key.worldId) ?? null;
    }),
    findMany: jest.fn(async (args: Row) => findMany(state.avatars, args)),
    upsert: jest.fn(async ({ where, create, update }: Row) => {
      const key = where.userId_worldId;
      const existing = state.avatars.find((row) => row.userId === key.userId && row.worldId === key.worldId);
      if (existing) return Object.assign(existing, update);
      const row = { id: `a${state.nextId++}`, ...create };
      state.avatars.push(row);
      return row;
    }),
  },
  $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run(fakeDb)),
};
