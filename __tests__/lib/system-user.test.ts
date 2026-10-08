/**
 * System's spaces are hidden from lists only once START_ROOM_URL lands outside them; while the start room is still
 * System's (a fresh install), or there is no System account, nothing is hidden.
 */
jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    universe: { findUnique: jest.fn() },
  },
}));

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  andNotSystemOwnedSql,
  getSystemUserId,
  hiddenSystemOwnerId,
  isStartRoomInSystemSpaces,
  notSystemRoom,
  resetSystemSpacesCache,
  shouldHideSystemSpaces,
  startRoomPath,
} from '@/lib/system-user';

const db = prisma as unknown as { user: { findUnique: jest.Mock }; universe: { findUnique: jest.Mock } };
const ORIGINAL_START = process.env.START_ROOM_URL;

/** System exists as `sys`; universes by slug: `default` is System's, `mine` is someone else's. */
function seeded({ system = true } = {}) {
  db.user.findUnique.mockResolvedValue(system ? { id: 'sys' } : null);
  db.universe.findUnique.mockImplementation(async ({ where }: { where: { slug: string } }) =>
    ({ default: { ownerId: 'sys' }, mine: { ownerId: 'khalid' } } as Record<string, { ownerId: string }>)[where.slug] ?? null,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  resetSystemSpacesCache();
  delete process.env.START_ROOM_URL;
  seeded();
});
afterAll(() => {
  if (ORIGINAL_START === undefined) delete process.env.START_ROOM_URL;
  else process.env.START_ROOM_URL = ORIGINAL_START;
});

describe('startRoomPath', () => {
  it('reads START_ROOM_URL as @/universe/world/room, defaulting to the built-in room', () => {
    expect(startRoomPath()).toBe('@/default/default/default');
    process.env.START_ROOM_URL = '/@/mine/office/lobby';
    expect(startRoomPath()).toBe('@/mine/office/lobby');
    process.env.START_ROOM_URL = '@/mine/office/lobby';
    expect(startRoomPath()).toBe('@/mine/office/lobby');
    process.env.START_ROOM_URL = 'https://play.example.com/@/mine/office/lobby';
    expect(startRoomPath()).toBe('@/mine/office/lobby');
  });

  it('is null for a full map URL or anything that is not a room path', () => {
    process.env.START_ROOM_URL = 'https://example.com/start.tmj';
    expect(startRoomPath()).toBeNull();
    process.env.START_ROOM_URL = '/_/global/maps.workadventu.re/starter/map.json';
    expect(startRoomPath()).toBeNull();
  });
});

describe('hiding System spaces', () => {
  it('hides nothing while the start room is in System’s universe', async () => {
    expect(await isStartRoomInSystemSpaces()).toBe(true);
    expect(await hiddenSystemOwnerId()).toBeNull();
    expect(await shouldHideSystemSpaces()).toBe(false);
    expect(await getSystemUserId()).toBe('sys');
  });

  it('hides System’s spaces once the start room is in someone else’s universe', async () => {
    process.env.START_ROOM_URL = '@/mine/office/lobby';
    expect(await isStartRoomInSystemSpaces()).toBe(false);
    expect(await hiddenSystemOwnerId()).toBe('sys');
    expect(await shouldHideSystemSpaces()).toBe(true);
  });

  it('counts a full http(s) map URL as outside System’s spaces', async () => {
    process.env.START_ROOM_URL = 'https://example.com/start.tmj';
    expect(await hiddenSystemOwnerId()).toBe('sys');
    expect(db.universe.findUnique).not.toHaveBeenCalled();
  });

  it('hides nothing when there is no System account', async () => {
    seeded({ system: false });
    process.env.START_ROOM_URL = '@/mine/office/lobby';
    expect(await getSystemUserId()).toBeNull();
    expect(await hiddenSystemOwnerId()).toBeNull();
  });

  it('hides nothing when the lookup fails, and asks again next time', async () => {
    process.env.START_ROOM_URL = '@/mine/office/lobby';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.user.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await hiddenSystemOwnerId()).toBeNull();
    expect(await hiddenSystemOwnerId()).toBe('sys');
    warn.mockRestore();
  });

  it('caches the answer briefly', async () => {
    process.env.START_ROOM_URL = '@/mine/office/lobby';
    await hiddenSystemOwnerId();
    await hiddenSystemOwnerId();
    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('filters', () => {
  it('are empty when nothing is hidden', () => {
    expect(notSystemRoom(null)).toEqual({});
    expect(andNotSystemOwnedSql(null)).toBe(Prisma.empty);
  });

  it('leave out what System owns, keyed on its id', () => {
    expect(notSystemRoom('sys')).toEqual({ world: { universe: { ownerId: { not: 'sys' } } } });
    const sql = andNotSystemOwnedSql('sys');
    expect(sql.sql).toBe('AND u.owner_id <> ?');
    expect(sql.values).toEqual(['sys']);
  });
});
