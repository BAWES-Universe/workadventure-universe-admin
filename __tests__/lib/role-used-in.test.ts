const roomFindMany = jest.fn();
const worldFindMany = jest.fn();
const worldMemberFindMany = jest.fn();
const memberFindMany = jest.fn();
const memberRoleFindMany = jest.fn();

jest.mock('@/lib/db', () => ({
  prisma: {
    world: { findMany: (...args: unknown[]) => worldFindMany(...args) },
    room: { findMany: (...args: unknown[]) => roomFindMany(...args) },
    worldMember: { findMany: (...args: unknown[]) => worldMemberFindMany(...args) },
    universeMember: { findMany: (...args: unknown[]) => memberFindMany(...args) },
    universeMemberRole: { findMany: (...args: unknown[]) => memberRoleFindMany(...args) },
  },
}));

import { areasLockedTo, computeUsedIn } from '@/lib/role-used-in';
import { fromKeys } from '@/lib/permissions';

const wam = (properties: unknown[], name: string | null = 'Finance desk') => ({ areas: [{ name, properties }] });
const locked = (readTags: string[], writeTags: string[], extra: object = {}) => ({ type: 'restrictedRightsPropertyData', readTags, writeTags, ...extra });

describe('areasLockedTo', () => {
  it('finds the areas whose read or write tags name the role', () => {
    expect(areasLockedTo(wam([locked(['accountant'], [])]), 'accountant')).toEqual([{ areaName: 'Finance desk', level: 'enter' }]);
    expect(areasLockedTo(wam([locked([], ['accountant'])]), 'accountant')).toEqual([{ areaName: 'Finance desk', level: 'edit' }]);
    expect(areasLockedTo(wam([locked(['accountant'], ['accountant'])]), 'accountant')).toHaveLength(2);
  });

  it('ignores other roles, other properties and properties switched off, as the game does', () => {
    expect(areasLockedTo(wam([locked(['moderator'], [])]), 'accountant')).toEqual([]);
    expect(areasLockedTo(wam([{ type: 'openWebsite', readTags: ['accountant'] }]), 'accountant')).toEqual([]);
    expect(areasLockedTo(wam([locked(['accountant'], [], { disabled: true })]), 'accountant')).toEqual([]);
  });

  it('names an area with no name, and survives anything that is not a map', () => {
    expect(areasLockedTo(wam([locked(['a'], [])], null), 'a')).toEqual([{ areaName: 'Unnamed area', level: 'enter' }]);
    for (const junk of [null, undefined, 3, 'x', {}, { areas: 'no' }, { areas: [null, { properties: 4 }] }]) {
      expect(areasLockedTo(junk, 'a')).toEqual([]);
    }
  });
});

const universe = { isPublic: true, ownerId: 'owner' };
const room = (id: string, name: string, worldId: string, isPublic: boolean, wamUrl: string | null) => ({
  id,
  name,
  isPublic,
  wamUrl,
  world: { id: worldId, name: worldId.toUpperCase(), isPublic: true, universe },
});

const ROLE = { id: 'role-1', key: 'accountant', permissions: fromKeys(['GO_LIVE']) };
const VIEWER = { id: 'viewer', isSuperAdmin: false };

beforeEach(() => {
  jest.resetAllMocks();
  process.env.PUBLIC_MAP_STORAGE_URL = 'https://maps.example.test';
  worldFindMany.mockResolvedValue([
    { id: 'hq', name: 'HQ', isPublic: true, universe },
    { id: 'campus', name: 'Campus', isPublic: true, universe },
  ]);
  worldMemberFindMany.mockResolvedValue([{ worldId: 'hq' }, { worldId: 'campus' }]);
  roomFindMany.mockResolvedValue([
    room('lobby', 'Lobby', 'hq', true, 'https://maps.example.test/d/u/hq/lobby/map.wam'),
    room('finance', 'Finance', 'hq', false, 'https://maps.example.test/d/u/hq/finance/map.wam'),
    room('library', 'Library', 'campus', true, null),
  ]);
  memberRoleFindMany.mockResolvedValue([{ allWorlds: false, worldIds: ['hq'] }]);
  memberFindMany.mockResolvedValue([{ allWorlds: true, worldIds: [] }]);
});

afterAll(() => {
  delete process.env.PUBLIC_MAP_STORAGE_URL;
});

const answers = (files: Record<string, unknown>) =>
  jest.fn(async (url: string) => {
    if (!(url in files)) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => files[url] };
  });

describe('computeUsedIn', () => {
  it('lists the map areas locked to the role, read from the map files, and the worlds and rooms it reaches', async () => {
    const fetcher = answers({
      'https://maps.example.test/d/u/hq/lobby/map.wam': wam([locked([], ['accountant'])], 'Reception'),
      'https://maps.example.test/d/u/hq/finance/map.wam': wam([locked(['accountant', 'lead'], [])]),
    });
    const used = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: VIEWER, fetcher });
    expect(used.reach.worlds).toEqual([{ id: 'hq', name: 'HQ' }]);
    expect(used.reach.allWorlds).toBe(false);
    expect(used.reach.rooms.map((r) => r.name)).toEqual(['Lobby', 'Finance']);
    expect(used.reach.mapAreas.status).toBe('read');
    expect(used.reach.mapAreas.read).toBe(2);
    expect(used.reach.mapAreas.areas.map((a) => `${a.areaName}:${a.level}:${a.roomName}`)).toEqual([
      'Reception:edit:Lobby',
      'Finance desk:enter:Finance',
    ]);
    expect(used.reach.permissions).toEqual(['GO_LIVE']);
  });

  it('has no rooms set to a role, since Orbit has no such setting: the list is empty, not invented', async () => {
    const used = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: VIEWER, fetcher: answers({}) });
    expect(used.doors).toEqual({ basis: 'none', rooms: [], roomsTotal: 0 });
  });

  it('says a map it could not read was not read, rather than saying nothing is locked', async () => {
    const fetcher = answers({ 'https://maps.example.test/d/u/hq/lobby/map.wam': wam([locked(['accountant'], [])]) });
    const used = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: VIEWER, fetcher });
    expect(used.reach.mapAreas.status).toBe('partial');
    expect(used.reach.mapAreas.unread).toBe(1);
    expect(used.reach.mapAreas.areas).toHaveLength(1);
  });

  it('says it cannot read maps when map-storage has no address here', async () => {
    delete process.env.PUBLIC_MAP_STORAGE_URL;
    const fetcher = jest.fn();
    const used = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: VIEWER, fetcher });
    expect(used.reach.mapAreas).toEqual({ status: 'not_configured', areas: [], unread: 0, read: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('only reads files from map-storage itself', async () => {
    roomFindMany.mockResolvedValue([room('lobby', 'Lobby', 'hq', true, 'https://elsewhere.example.test/map.wam')]);
    const fetcher = jest.fn();
    const used = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: VIEWER, fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(used.reach.mapAreas.status).toBe('partial');
  });

  it('treats a map that fails to download as unread', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('down');
    });
    const used = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: VIEWER, fetcher });
    expect(used.reach.mapAreas.status).toBe('partial');
    expect(used.reach.mapAreas.unread).toBe(2);
  });

  it('shows Member the rooms only a world’s people can enter, and the worlds everyone who joined is in', async () => {
    const used = await computeUsedIn({ universeId: 'u', role: { id: 'm', key: 'member', permissions: BigInt(0) }, viewer: VIEWER, fetcher: answers({}) });
    expect(used.doors.basis).toBe('members');
    expect(used.doors.rooms.map((r) => r.name)).toEqual(['Finance']);
    expect(used.reach.allWorlds).toBe(true);
  });

  it('shows Everyone the rooms open to everyone', async () => {
    const used = await computeUsedIn({ universeId: 'u', role: { id: 'e', key: 'everyone', permissions: BigInt(0) }, viewer: VIEWER, fetcher: answers({}) });
    expect(used.doors.basis).toBe('everyone');
    expect(used.doors.rooms.map((r) => r.name)).toEqual(['Lobby', 'Library']);
  });

  it('names only the rooms the viewer can see', async () => {
    worldMemberFindMany.mockResolvedValue([]);
    const used = await computeUsedIn({ universeId: 'u', role: { id: 'm', key: 'member', permissions: BigInt(0) }, viewer: VIEWER, fetcher: answers({}) });
    expect(used.doors.rooms).toEqual([]);
    expect(used.reach.rooms.map((r) => r.name)).toEqual(['Lobby', 'Library']);
  });

  it('never names a private world the viewer cannot see, and still counts that it is reached', async () => {
    worldFindMany.mockResolvedValue([
      { id: 'hq', name: 'HQ', isPublic: true, universe },
      { id: 'secret', name: 'Secret plans', isPublic: false, universe },
    ]);
    roomFindMany.mockResolvedValue([room('lobby', 'Lobby', 'hq', true, null)]);
    worldMemberFindMany.mockResolvedValue([]);
    memberRoleFindMany.mockResolvedValue([{ allWorlds: true, worldIds: [] }]);
    const used = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: VIEWER, fetcher: answers({}) });
    expect(used.reach.worlds).toEqual([{ id: 'hq', name: 'HQ' }]);
    expect(JSON.stringify(used)).not.toContain('Secret plans');
    expect(used.reach.allWorlds).toBe(true);

    // Their own world, the owner and a super admin do see it
    worldMemberFindMany.mockResolvedValue([{ worldId: 'secret' }]);
    const asMember = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: VIEWER, fetcher: answers({}) });
    expect(asMember.reach.worlds.map((world) => world.name)).toEqual(['HQ', 'Secret plans']);
    worldMemberFindMany.mockResolvedValue([]);
    const asAdmin = await computeUsedIn({ universeId: 'u', role: ROLE, viewer: { id: 'root', isSuperAdmin: true }, fetcher: answers({}) });
    expect(asAdmin.reach.worlds.map((world) => world.name)).toEqual(['HQ', 'Secret plans']);
  });

  it('lists every permission for a role with Administrator', async () => {
    const used = await computeUsedIn({ universeId: 'u', role: { ...ROLE, permissions: fromKeys(['ADMINISTRATOR']) }, viewer: VIEWER, fetcher: answers({}) });
    expect(used.reach.permissions).toHaveLength(15);
  });
});
