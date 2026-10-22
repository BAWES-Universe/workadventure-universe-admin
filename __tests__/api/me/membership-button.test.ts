/**
 * GET /api/me/membership-button: what the membership button on a player's card in the game says for you, in the
 * universe of the room you are in. null whenever you may do none of it.
 */
import { NextRequest } from 'next/server';
import { fromKeys } from '@/lib/permissions';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    universeMember: { findUnique: jest.fn() },
    membershipInvitation: { findFirst: jest.fn() },
    role: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/role-access', () => ({ ...jest.requireActual('@/lib/role-access'), accessFor: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { accessFor, computeAccess } from '@/lib/role-access';
import { GET } from '@/app/api/me/membership-button/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const ROOM = 'https://play.example.test/@/bawes/hq/lobby';

/** What you hold in the universe: nothing, an inviting role, a role that gives roles, or both. */
const holding = (kind: 'none' | 'invite' | 'give' | 'both' | 'owner', position = 20) => {
  const keys = kind === 'invite' ? ['INVITE_AND_REMOVE'] : kind === 'give' ? ['GIVE_ROLES'] : kind === 'both' ? ['INVITE_AND_REMOVE', 'GIVE_ROLES'] : [];
  return computeAccess({
    universeId: 'u1', worldIds: ['hq'], full: kind === 'owner', isOwner: kind === 'owner', everyone: BigInt(0), member: BigInt(0),
    membership: { allWorlds: true, worldIds: [] },
    roles: keys.length ? [{ key: 'helper', position, permissions: fromKeys(keys as Parameters<typeof fromKeys>[0]), allWorlds: true, worldIds: [] }] : [],
  });
};

const call = (query: Record<string, string> = { roomId: ROOM, userUuid: 'uuid-ali' }, headers: Record<string, string> = {}) =>
  GET(new NextRequest(`http://localhost/api/me/membership-button?${new URLSearchParams(query)}`, { headers }));
const answer = async (query?: Record<string, string>) => (await (await call(query)).json()).button;

const memberRow = (position?: number) => ({
  allWorlds: true, worldIds: [], roles: position ? [{ roleId: 'x', allWorlds: true, worldIds: [], role: { position, showBadge: true } }] : [],
});

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue({ id: 'me', uuid: 'uuid-me', email: null, name: 'Me', tags: [], isSuperAdmin: false });
  db.universe.findUnique.mockResolvedValue({ id: 'u1', ownerId: 'owner', isPublic: true });
  db.user.findUnique.mockResolvedValue({ id: 'ali', isGuest: false, email: 'ali@example.test' });
  db.universeMember.findUnique.mockResolvedValue(null);
  db.membershipInvitation.findFirst.mockResolvedValue(null);
  db.role.findMany.mockResolvedValue([{ id: 'low', position: 5 }, { id: 'mid', position: 12 }]);
  (accessFor as jest.Mock).mockResolvedValue(holding('invite'));
});

describe('the label', () => {
  it('is Give membership for someone not in the universe when you may invite', async () => {
    expect(await answer()).toEqual({ kind: 'membership', label: 'Give membership' });
    expect(db.universe.findUnique).toHaveBeenCalledWith({ where: { slug: 'bawes' }, select: { id: true, ownerId: true, isPublic: true } });
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { uuid: 'uuid-ali' }, select: { id: true, isGuest: true, email: true } });
  });

  it('is Pending invite when an invitation (to the universe or one of its worlds) is waiting', async () => {
    db.membershipInvitation.findFirst.mockResolvedValue({ id: 'i1' });
    expect(await answer()).toEqual({ kind: 'pending', label: 'Pending invite' });
    expect(db.membershipInvitation.findFirst.mock.calls[0][0].where).toEqual({
      invitedUserId: 'ali', status: 'pending', OR: [{ universeId: 'u1' }, { world: { universeId: 'u1' } }],
    });
  });

  it('is Roles for a member you may give roles to', async () => {
    (accessFor as jest.Mock).mockResolvedValue(holding('give'));
    db.universeMember.findUnique.mockResolvedValue(memberRow());
    expect(await answer()).toEqual({ kind: 'roles', label: 'Roles' });
  });

  it('is Membership for a member you may only remove', async () => {
    db.universeMember.findUnique.mockResolvedValue(memberRow());
    expect(await answer()).toEqual({ kind: 'membership', label: 'Membership' });
  });

  it('lets the owner of the universe do all of it', async () => {
    (accessFor as jest.Mock).mockResolvedValue(holding('owner'));
    expect(await answer()).toEqual({ kind: 'membership', label: 'Give membership' });
    db.universeMember.findUnique.mockResolvedValue(memberRow(30));
    expect(await answer()).toEqual({ kind: 'roles', label: 'Roles' });
  });
});

describe('no button', () => {
  it.each([
    ['you have no rights here', () => (accessFor as jest.Mock).mockResolvedValue(holding('none'))],
    ['you may only give roles and they are not in the universe', () => (accessFor as jest.Mock).mockResolvedValue(holding('give'))],
    ['you may only give roles and an invitation is waiting', () => {
      (accessFor as jest.Mock).mockResolvedValue(holding('give'));
      db.membershipInvitation.findFirst.mockResolvedValue({ id: 'i1' });
    }],
    ['they are a member above your rank', () => {
      (accessFor as jest.Mock).mockResolvedValue(holding('both', 20));
      db.universeMember.findUnique.mockResolvedValue(memberRow(30));
    }],
    ['they are a member at your rank', () => {
      (accessFor as jest.Mock).mockResolvedValue(holding('both', 20));
      db.universeMember.findUnique.mockResolvedValue(memberRow(20));
    }],
    ['they are a member and you may only invite', () => {
      (accessFor as jest.Mock).mockResolvedValue(holding('invite', 20));
      db.universeMember.findUnique.mockResolvedValue(memberRow(30));
    }],
    ['they are a guest', () => db.user.findUnique.mockResolvedValue({ id: 'ali', isGuest: true, email: null })],
    ['it is your own card', () => db.user.findUnique.mockResolvedValue({ id: 'me', isGuest: false, email: 'me@example.test' })],
    ['they own the universe', () => db.universe.findUnique.mockResolvedValue({ id: 'u1', ownerId: 'ali', isPublic: true })],
    ['the universe is not known', () => db.universe.findUnique.mockResolvedValue(null)],
    ['the player is not known', () => db.user.findUnique.mockResolvedValue(null)],
  ])('when %s', async (_name, arrange) => {
    arrange();
    expect(await answer()).toBeNull();
  });

  it.each([
    ['no room', { userUuid: 'uuid-ali' }],
    ['no player', { roomId: ROOM }],
    ['a room address that is not a room', { roomId: 'https://play.example.test/somewhere', userUuid: 'uuid-ali' }],
    ['a room address that is not an address', { roomId: 'nonsense', userUuid: 'uuid-ali' }],
    ['a very long player id', { roomId: ROOM, userUuid: 'x'.repeat(300) }],
  ])('for %s, without asking the database', async (_name, query) => {
    expect(await answer(query)).toBeNull();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('never gives the system account a button', async () => {
    const { SYSTEM_USER_EMAIL } = jest.requireActual('@/lib/system-user');
    db.user.findUnique.mockResolvedValue({ id: 'sys', isGuest: false, email: SYSTEM_USER_EMAIL });
    expect(await answer()).toBeNull();
  });
});

describe('who may ask', () => {
  it('needs a signed-in player', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it('refuses a page that is not Orbit or the game', async () => {
    expect((await call(undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('answers 500 without detail when something breaks', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    db.universe.findUnique.mockRejectedValue(new Error('db down'));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('is never cached', async () => {
    expect((await call()).headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('a waiting invitation and the worlds you may invite in', () => {
  const inviteIn = (worldIds: string[]) =>
    (accessFor as jest.Mock).mockResolvedValue(
      computeAccess({
        universeId: 'u1', worldIds: ['hq', 'campus'], full: false, isOwner: false, everyone: BigInt(0), member: BigInt(0),
        membership: { allWorlds: true, worldIds: [] },
        roles: [{ key: 'greeter', position: 10, permissions: fromKeys(['INVITE_AND_REMOVE']), allWorlds: false, worldIds }],
      }),
    );
  const sent = (reach: { allWorlds: boolean; worldIds: string[] }) =>
    db.membershipInvitation.findFirst.mockResolvedValue({ id: 'i1', universeId: 'u1', worldId: 'hq', ...reach });

  it('is Pending invite when you may invite in every world it names', async () => {
    inviteIn(['hq']);
    sent({ allWorlds: false, worldIds: ['hq'] });
    expect(await answer()).toEqual({ kind: 'pending', label: 'Pending invite' });
  });

  it('has no button when it names a world, or every world, where you may not invite', async () => {
    inviteIn(['hq']);
    sent({ allWorlds: false, worldIds: ['hq', 'campus'] });
    expect(await answer()).toBeNull();
    sent({ allWorlds: true, worldIds: [] });
    expect(await answer()).toBeNull();
  });

  it('still offers Give membership to someone with no invitation', async () => {
    inviteIn(['hq']);
    expect(await answer()).toEqual({ kind: 'membership', label: 'Give membership' });
  });
});

describe('a private universe', () => {
  const privateUniverse = () => db.universe.findUnique.mockResolvedValue({ id: 'u1', ownerId: 'owner', isPublic: false });
  const outsider = () => (accessFor as jest.Mock).mockResolvedValue({ ...holding('invite'), inUniverse: false });

  it('has no button for someone who cannot see it, even when Everyone may invite', async () => {
    privateUniverse();
    outsider();
    expect(await answer()).toBeNull();
    expect(db.membershipInvitation.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the button for a member of it', async () => {
    privateUniverse();
    expect(await answer()).toEqual({ kind: 'membership', label: 'Give membership' });
  });

  it('keeps the button for a super admin who may invite there', async () => {
    privateUniverse();
    outsider();
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'root', uuid: 'uuid-root', email: null, name: 'Root', tags: [], isSuperAdmin: true });
    expect(await answer()).toEqual({ kind: 'membership', label: 'Give membership' });
  });

  it('shows the button in a public universe to someone who has not joined', async () => {
    outsider();
    expect(await answer()).toEqual({ kind: 'membership', label: 'Give membership' });
  });
});

describe('a super admin', () => {
  it('has no button in a universe they have no rights in, like anyone else', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'root', uuid: 'uuid-root', email: null, name: 'Root', tags: [], isSuperAdmin: true });
    (accessFor as jest.Mock).mockResolvedValue(holding('none'));
    expect(await answer()).toBeNull();
    expect(accessFor).toHaveBeenCalledWith(expect.anything(), 'u1', expect.objectContaining({ id: 'root' }));
  });
});
