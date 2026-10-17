import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { FriendsError, listFriends, searchPeople, SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from '@/lib/friends';
import { worldsAllowing } from '@/lib/role-access';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { failed, needs, universeContext } from '@/lib/universe-route';
import { withWokas } from '@/lib/woka-avatar';

/** "This week", for the people who visited. */
const VISITOR_DAYS = 7;
const VISITORS_SHOWN = 20;
const FRIENDS_SHOWN = 50;
/** Enough room visits to find that many different people. */
const LOOK_BACK = 400;

// GET /api/admin/universes/[id]/invite-candidates?q= - Who the invite sheet offers: people who visited this universe this
// week, your friends who didn't, and, once you type a name, people found by name. Members, the owner, people who
// already have an invitation and you are never listed.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe, user } = context;

    const inviteWorlds = worldsAllowing(access, 'INVITE_AND_REMOVE');
    if (inviteWorlds !== 'all' && inviteWorlds.length === 0) return needs('Invite and remove people');

    const query = request.nextUrl.searchParams.get('q')?.trim().slice(0, SEARCH_MAX_LENGTH) ?? '';
    const since = new Date(Date.now() - VISITOR_DAYS * 24 * 60 * 60 * 1000);

    const [visits, friendList, found] = await Promise.all([
      prisma.roomAccess.findMany({
        where: { universeId: id, userId: { not: null, notIn: [user.id, universe.ownerId] }, accessedAt: { gte: since }, user: { isGuest: false, AND: [NOT_SYSTEM_USER] } },
        orderBy: { accessedAt: 'desc' },
        take: LOOK_BACK,
        select: {
          userId: true,
          accessedAt: true,
          room: { select: { id: true, name: true } },
          world: { select: { id: true, name: true } },
          user: { select: { name: true } },
        },
      }),
      listFriends({ id: user.id, uuid: user.uuid, name: user.name, matrixChatId: null }),
      query.length >= SEARCH_MIN_LENGTH
        ? searchPeople({ id: user.id, uuid: user.uuid, name: user.name, matrixChatId: null }, query).catch((error) => {
            if (error instanceof FriendsError) return [];
            throw error;
          })
        : Promise.resolve([]),
    ]);

    // Each person once, by their latest visit
    const visitedBy = new Map<string, (typeof visits)[number]>();
    for (const visit of visits) {
      if (visit.userId && !visitedBy.has(visit.userId)) visitedBy.set(visit.userId, visit);
    }

    // Friends and search results come with the game's ids; the sheet needs account ids
    const uuids = [...new Set([...friendList.friends.map((friend) => friend.uuid), ...found.map((person) => person.uuid)])];
    const accounts = uuids.length
      ? await prisma.user.findMany({ where: { uuid: { in: uuids }, isGuest: false, AND: [NOT_SYSTEM_USER] }, select: { id: true, uuid: true, name: true } })
      : [];
    const accountOf = new Map(accounts.map((account) => [account.uuid, account]));

    const everyone = [...new Set([...visitedBy.keys(), ...accounts.map((account) => account.id)])];
    const [members, pending, friendVisits] = await Promise.all([
      prisma.universeMember.findMany({ where: { universeId: id, userId: { in: everyone } }, select: { userId: true } }),
      prisma.membershipInvitation.findMany({
        where: { invitedUserId: { in: everyone }, status: 'pending', OR: [{ universeId: id }, { world: { universeId: id } }] },
        select: { invitedUserId: true },
      }),
      prisma.roomAccess.groupBy({ by: ['userId'], where: { universeId: id, userId: { in: accounts.map((account) => account.id) } }, _max: { accessedAt: true } }),
    ]);
    const left = new Set([user.id, universe.ownerId, ...members.map((row) => row.userId), ...pending.map((row) => row.invitedUserId)]);
    const friendIds = new Set(friendList.friends.map((friend) => accountOf.get(friend.uuid)?.id).filter((value): value is string => !!value));
    const lastVisit = new Map(friendVisits.flatMap((row) => (row.userId && row._max.accessedAt ? [[row.userId, row._max.accessedAt] as const] : [])));

    const visitors = [...visitedBy.values()]
      .filter((visit) => visit.userId && !left.has(visit.userId))
      .slice(0, VISITORS_SHOWN)
      .map((visit) => ({
        userId: visit.userId as string,
        name: visit.user?.name ?? 'Someone',
        friend: friendIds.has(visit.userId as string),
        at: visit.accessedAt.toISOString(),
        room: visit.room,
        world: visit.world,
      }));
    const shownIds = new Set(visitors.map((visitor) => visitor.userId));

    const friends = friendList.friends
      .map((friend) => accountOf.get(friend.uuid))
      .filter((account): account is NonNullable<typeof account> => !!account && !left.has(account.id) && !shownIds.has(account.id))
      .slice(0, FRIENDS_SHOWN)
      .map((account) => ({ userId: account.id, name: account.name ?? 'Someone', lastVisitedAt: lastVisit.get(account.id)?.toISOString() ?? null }));

    const results = found
      .map((person) => accountOf.get(person.uuid))
      .filter((account): account is NonNullable<typeof account> => !!account && !left.has(account.id))
      .map((account) => ({
        userId: account.id,
        name: account.name ?? 'Someone',
        friend: friendIds.has(account.id),
        lastVisitedAt: lastVisit.get(account.id)?.toISOString() ?? visitedBy.get(account.id)?.accessedAt.toISOString() ?? null,
      }));

    const withFaces = await withWokas([...visitors, ...friends, ...results]);
    return NextResponse.json({
      visitors: withFaces.slice(0, visitors.length),
      friends: withFaces.slice(visitors.length, visitors.length + friends.length),
      results: withFaces.slice(visitors.length + friends.length),
    });
  } catch (error) {
    return failed(error, 'list people to invite');
  }
}
