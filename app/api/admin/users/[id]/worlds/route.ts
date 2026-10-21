import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { hiddenSystemOwnerId, notSystemWorld } from '@/lib/system-user';
import { accessForMany, worldsAllowing } from '@/lib/role-access';
import { orderedPair } from '@/lib/friends';

// GET /api/admin/users/[id]/worlds - Get list of worlds current user can invite this user to, and the universes they can
// invite this user to (the invite sheet's): Invite and remove people somewhere in it, and the person is not in it yet
// and has no invitation waiting.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: userId } = await params;

    // Get all worlds where user is universe owner or world admin, never System's once they are hidden
    const hidden = await hiddenSystemOwnerId();
    const worlds = await prisma.world.findMany({
      where: {
        ...notSystemWorld(hidden),
        OR: [
          {
            universe: {
              ownerId: sessionUser.id,
            },
          },
          {
            members: {
              some: {
                userId: sessionUser.id,
                tags: { has: 'admin' },
              },
            },
          },
        ],
      },
      include: {
        universe: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        members: {
          where: {
            userId: userId,
          },
        },
      },
    });

    // Filter out worlds where user is already a member
    const availableWorlds = worlds
      .filter(world => world.members.length === 0)
      .map(world => ({
        id: world.id,
        name: world.name,
        slug: world.slug,
        universe: world.universe,
      }));

    const { universes, taken, friend } = await invitableUniverses(sessionUser, userId, hidden);

    return NextResponse.json({ worlds: availableWorlds, universes, taken, friend });
  } catch (error) {
    console.error('Error fetching worlds:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worlds' },
      { status: 500 }
    );
  }
}


// What the sheet says about an invitation still waiting: who sent it, when, and what it would give.
const waiting = { id: true, invitedAt: true, roleIds: true, allWorlds: true, worldIds: true, invitedBy: { select: { id: true, name: true } } } as const;

async function invitableUniverses(viewer: { id: string }, personId: string, hidden: string | null) {
  if (viewer.id === personId) return { universes: [], taken: [], friend: false };
  const candidates = await prisma.universe.findMany({
    where: {
      ...(hidden ? { ownerId: { not: hidden } } : {}),
      // Yours only: a Super admin gets no universe of someone else's here, just for being one.
      OR: [{ ownerId: viewer.id }, { members: { some: { userId: viewer.id } } }],
    },
    select: {
      id: true,
      name: true,
      ownerId: true,
      members: { where: { userId: personId }, select: { id: true } },
      membershipInvitations: { where: { invitedUserId: personId, status: 'pending' }, select: waiting },
      // A pending invitation counts whether it names the universe or was sent the old way to one of its worlds
      worlds: {
        where: { membershipInvitations: { some: { invitedUserId: personId, status: 'pending' } } },
        select: { membershipInvitations: { where: { invitedUserId: personId, status: 'pending' }, select: waiting, take: 1 } },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
  });
  // What the sheet says under their name, as the invite lists do: whether they are your friend, and when they last came
  // into this universe and where. Access to every candidate comes in one go, and so do the visits of the ones that pass.
  const [friendship, accesses] = await Promise.all([
    prisma.friendship.findUnique({ where: { user1Id_user2Id: orderedPair(viewer.id, personId) }, select: { status: true } }),
    // Your own roles, never the Super admin's reach into every universe
    accessForMany(prisma, candidates.map((universe) => universe.id), { id: viewer.id }),
  ]);
  const yours = candidates.filter((universe) => {
    const access = accesses.get(universe.id);
    if (!access) return false;
    // Inviting is what Give membership and Pending invite need; giving roles is what Roles needs
    const some = (worlds: ReturnType<typeof worldsAllowing>) => worlds === 'all' || worlds.length > 0;
    return some(worldsAllowing(access, 'INVITE_AND_REMOVE')) || some(worldsAllowing(access, 'GIVE_ROLES'));
  });
  const mayInvite = (universe: (typeof yours)[number]) => {
    const worlds = worldsAllowing(accesses.get(universe.id)!, 'INVITE_AND_REMOVE');
    return worlds === 'all' || worlds.length > 0;
  };
  // The sheet shows the ones they already belong to or are invited to, so it is clear where they stand.
  const invitation = (universe: (typeof yours)[number]) => universe.membershipInvitations[0] ?? universe.worlds[0]?.membershipInvitations[0] ?? null;
  const status = (universe: (typeof yours)[number]) =>
    universe.ownerId === personId || universe.members.length > 0 ? 'member' : invitation(universe) ? 'invited' : null;
  // Not in it, or waiting: you need to be able to invite. A member: inviting or giving roles is enough to look further.
  const invitable = yours.filter((universe) => !status(universe) && mayInvite(universe)).map((universe) => ({ id: universe.id, name: universe.name }));
  const taken = yours.flatMap((universe) => {
    const value = status(universe);
    if (value === 'invited' && !mayInvite(universe)) return [];
    const sent = value === 'invited' ? invitation(universe) : null;
    return value
      ? [{
          id: universe.id,
          name: universe.name,
          status: value,
          invitation: sent
            ? { id: sent.id, at: sent.invitedAt.toISOString(), by: { name: sent.invitedBy.name, you: sent.invitedBy.id === viewer.id }, roleIds: sent.roleIds, worlds: { allWorlds: sent.allWorlds, worldIds: sent.worldIds } }
            : null,
        }]
      : [];
  });
  // Their latest visit in each of these universes: the newest row of each
  const visits = invitable.length
    ? await prisma.roomAccess.findMany({
        where: { universeId: { in: invitable.map((universe) => universe.id) }, userId: personId },
        orderBy: { accessedAt: 'desc' },
        distinct: ['universeId'],
        select: { universeId: true, accessedAt: true, room: { select: { name: true } }, world: { select: { name: true } } },
      })
    : [];
  const universes = invitable.map((universe) => {
    const visit = visits.find((row) => row.universeId === universe.id);
    return { ...universe, visit: visit ? { at: visit.accessedAt.toISOString(), room: visit.room, world: visit.world } : null };
  });
  return { universes, taken, friend: friendship?.status === 'accepted' };
}
