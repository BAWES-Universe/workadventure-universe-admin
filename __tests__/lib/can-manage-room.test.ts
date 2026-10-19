/**
 * Who sees a room's visitor details (canManageRoom) stays on the owner and the admin and editor tags: it is not the
 * Manage bots permission (#423), so turning that off for Editors or giving it to a custom role changes nothing here.
 */
const rooms = new Map<string, { worldId: string; ownerId: string }>([['room-hq', { worldId: 'hq', ownerId: 'owner' }]]);
let worldMembers: { worldId: string; userId: string; tags: string[] }[] = [];

jest.mock('@/lib/db', () => ({
  prisma: {
    room: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const room = rooms.get(where.id);
        return room ? { worldId: room.worldId, world: { universe: { ownerId: room.ownerId } } } : null;
      }),
    },
    worldMember: {
      findFirst: jest.fn(async ({ where }: { where: { worldId: string; userId: string; tags: { hasSome: string[] } } }) =>
        worldMembers.find(
          (row) =>
            row.worldId === where.worldId &&
            row.userId === where.userId &&
            row.tags.some((tag) => where.tags.hasSome.includes(tag)),
        ) ?? null,
      ),
    },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn(async () => true) }));

import { canManageRoom } from '@/lib/access-scope';

describe('canManageRoom', () => {
  beforeEach(() => {
    worldMembers = [
      { worldId: 'hq', userId: 'admin', tags: ['admin', 'member'] },
      { worldId: 'hq', userId: 'editor', tags: ['editor', 'member'] },
      { worldId: 'hq', userId: 'keeper', tags: ['bot-keeper', 'member'] },
    ];
  });

  it('passes the owner, admins and editors', async () => {
    expect(await canManageRoom('owner', 'room-hq')).toBe(true);
    expect(await canManageRoom('admin', 'room-hq')).toBe(true);
    expect(await canManageRoom('editor', 'room-hq')).toBe(true);
  });

  it('refuses a custom role (even one with Manage bots), a stranger and a missing room', async () => {
    expect(await canManageRoom('keeper', 'room-hq')).toBe(false);
    expect(await canManageRoom('stranger', 'room-hq')).toBe(false);
    expect(await canManageRoom('owner', 'room-missing')).toBe(false);
  });
});
