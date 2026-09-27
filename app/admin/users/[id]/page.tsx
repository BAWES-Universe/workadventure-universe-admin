'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { timeAgo } from '@/lib/time-ago';
import {
  EmptyCard,
  EntityRow,
  LoadingRows,
  RolePills,
  SectionHeader,
  StatLine,
  StatusPill,
  VisitLine,
  count,
} from '../../components/ds';
import { ProfileFrame, ProfileLinks, WokaAvatar } from '../../components/profile-card';
import InviteToWorldDialog from '../../components/invite-to-world-dialog';

interface WorldMembership {
  id: string;
  tags: string[];
  joinedAt: string;
  world: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    universe: {
      id: string;
      slug: string;
      name: string;
    };
    _count?: {
      rooms?: number;
      members?: number;
      favorites?: number;
    };
  };
}

interface Universe {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  isPublic: boolean;
  createdAt: string;
  _count?: {
    worlds?: number;
    rooms?: number;
    members?: number;
    favorites?: number;
  };
}

/** Their profile: a few words and links (stored as their visit card). */
interface VisitCard {
  id: string;
  bio: string | null;
  links: Array<{ label: string; url: string }>;
  createdAt: string;
  updatedAt: string;
}

interface User {
  id: string;
  uuid: string;
  name: string | null;
  // Contact fields are omitted unless the viewer may see them.
  email?: string | null;
  matrixChatId?: string | null;
  lastIpAddress?: string | null;
  isGuest: boolean;
  createdAt: string;
  updatedAt: string;
  visitCard: VisitCard | null;
  /** Their Woka's layers, bottom first. */
  woka?: string[];
  ownedUniverses: Universe[];
  worldMemberships: WorldMembership[];
  _count: {
    ownedUniverses: number;
    worldMemberships: number;
    bans: number;
    favorites: number;
    avatars: number;
  };
}

interface Visit {
  accessedAt: string;
}

interface Analytics {
  totalAccesses: number;
  lastVisitedByUser: Visit | null;
  lastVisitedOverall: Visit | null;
}

interface Access {
  id: string;
  accessedAt: string;
  ipAddress?: string | null;
  isAuthenticated: boolean;
  hasMembership: boolean;
  membershipTags: string[];
  universe: { id: string; name: string };
  world: { id: string; name: string };
  room: { id: string; name: string };
}

interface AccessHistory {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  firstAccess: string | null;
  lastAccess: string | null;
  accesses: Access[];
}

interface StarredRoom {
  id: string;
  name: string;
  favoritedAt: string;
  starCount: number;
  world: { name: string; universe: { name: string } };
}

interface CurrentUser {
  id: string;
  isSuperAdmin?: boolean;
}

/** When you and anyone were last somewhere, for VisitLine. */
function visits(analytics?: Analytics) {
  const you = analytics?.lastVisitedByUser?.accessedAt ?? null;
  const latest = analytics?.lastVisitedOverall?.accessedAt ?? null;
  return { you, latest, youWereLast: Boolean(you && latest && you === latest) };
}

const linkClass = 'underline-offset-2 hover:underline [overflow-wrap:anywhere]';

export default function UserDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessHistory, setAccessHistory] = useState<AccessHistory | null>(null);
  const [accessHistoryLoading, setAccessHistoryLoading] = useState(true);
  const [accessHistoryPage, setAccessHistoryPage] = useState(1);
  // Access history is only available to the person themselves and super admins.
  const [accessHistoryHidden, setAccessHistoryHidden] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [availableWorlds, setAvailableWorlds] = useState<unknown[]>([]);
  const [, setWorldsLoading] = useState(false);
  const [universeAnalytics, setUniverseAnalytics] = useState<Record<string, Analytics>>({});
  const [worldAnalytics, setWorldAnalytics] = useState<Record<string, Analytics>>({});
  const [starredRooms, setStarredRooms] = useState<StarredRoom[]>([]);
  const [starredRoomsLoading, setStarredRoomsLoading] = useState(false);

  useEffect(() => {
    checkAuth();
    fetchUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (user) {
      fetchStarredRooms();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  useEffect(() => {
    if (user) {
      fetchAccessHistory(accessHistoryPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessHistoryPage, user]);

  useEffect(() => {
    if (currentUser && user && currentUser.id !== user.id) {
      fetchAvailableWorlds();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, user]);

  useEffect(() => {
    if (user) {
      fetchUniverseAnalytics();
      fetchWorldAnalytics();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      const data = await response.json();
      setCurrentUser(data.user);
      setIsSuperAdmin(data.user?.isSuperAdmin || false);
    } catch {
      router.push('/admin/login');
    }
  }

  async function fetchUser() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${id}`);

      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/users');
          return;
        }
        throw new Error('Failed to fetch user');
      }

      const data = await response.json();
      setUser(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAccessHistory(page: number = 1) {
    try {
      setAccessHistoryLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/users/${id}?page=${page}&limit=10`);

      if (response.status === 403) {
        setAccessHistoryHidden(true);
        setAccessHistory(null);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch access history');
      }

      const data = await response.json();
      setAccessHistoryHidden(false);
      setAccessHistory(data);
    } catch (err) {
      console.error('Failed to fetch access history:', err);
    } finally {
      setAccessHistoryLoading(false);
    }
  }

  async function fetchAvailableWorlds() {
    if (!currentUser || !user || currentUser.id === user.id) {
      setAvailableWorlds([]);
      return;
    }

    try {
      setWorldsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${id}/worlds`);

      if (!response.ok) {
        throw new Error('Failed to fetch available worlds');
      }

      const data = await response.json();
      setAvailableWorlds(data.worlds || []);
    } catch (err) {
      console.error('Failed to fetch available worlds:', err);
      setAvailableWorlds([]);
    } finally {
      setWorldsLoading(false);
    }
  }

  async function fetchUniverseAnalytics() {
    if (!user || !user.ownedUniverses.length) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const results = await Promise.all(
        user.ownedUniverses.map(async (universe) => {
          try {
            const response = await authenticatedFetch(
              `/api/admin/analytics/universes/${universe.id}`,
            );
            if (!response.ok) return null;
            const data = await response.json();
            return {
              universeId: universe.id,
              totalAccesses: data.totalAccesses || 0,
              lastVisitedByUser: data.lastVisitedByUser || null,
              lastVisitedOverall: data.lastVisitedOverall || null,
            };
          } catch {
            return null;
          }
        }),
      );

      setUniverseAnalytics((prev) => {
        const updated = { ...prev };
        for (const result of results) {
          if (result) {
            updated[result.universeId] = {
              totalAccesses: result.totalAccesses,
              lastVisitedByUser: result.lastVisitedByUser,
              lastVisitedOverall: result.lastVisitedOverall,
            };
          }
        }
        return updated;
      });
    } catch {
      // Ignore errors
    }
  }

  async function fetchWorldAnalytics() {
    if (!user || !user.worldMemberships.length) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const results = await Promise.all(
        user.worldMemberships.map(async (membership) => {
          try {
            const response = await authenticatedFetch(
              `/api/admin/analytics/worlds/${membership.world.id}`,
            );
            if (!response.ok) return null;
            const data = await response.json();
            return {
              worldId: membership.world.id,
              totalAccesses: data.totalAccesses || 0,
              lastVisitedByUser: data.lastVisitedByUser || null,
              lastVisitedOverall: data.lastVisitedOverall || null,
            };
          } catch {
            return null;
          }
        }),
      );

      setWorldAnalytics((prev) => {
        const updated = { ...prev };
        for (const result of results) {
          if (result) {
            updated[result.worldId] = {
              totalAccesses: result.totalAccesses,
              lastVisitedByUser: result.lastVisitedByUser,
              lastVisitedOverall: result.lastVisitedOverall,
            };
          }
        }
        return updated;
      });
    } catch {
      // Ignore errors
    }
  }

  async function fetchStarredRooms() {
    if (!user) return;
    try {
      setStarredRoomsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${id}/starred-rooms`);
      if (response.ok) {
        const data = await response.json();
        setStarredRooms(data.rooms || []);
      }
    } catch (err) {
      console.error('Failed to fetch starred rooms:', err);
    } finally {
      setStarredRoomsLoading(false);
    }
  }

  if (loading) {
    return <LoadingRows label="this person" rows={4} />;
  }

  if (!user) {
    return (
      <div className="grid min-w-0 gap-4">
        {error && (
          <p className="text-sm text-muted-foreground" role="alert">
            {error}
          </p>
        )}
        <EmptyCard kind="people" title="We couldn’t find this person." text="They may have left, or the link is wrong." href="/admin/users" action="See everyone" />
      </div>
    );
  }

  const name = user.name || user.email || 'Someone';
  const isSelf = currentUser?.id === user.id;
  const canInvite = Boolean(currentUser && !isSelf && availableWorlds.length > 0);
  const showPrivate = isSuperAdmin || isSelf;
  const bio = user.visitCard?.bio?.trim();
  const links = user.visitCard?.links ?? [];

  return (
    <div className="grid min-w-0 gap-7">
      <ProfileFrame
        headingId="person-name"
        layers={user.woka ?? []}
        name={name}
        testId="person-card"
        stats={
          <StatLine
            items={[
              user.ownedUniverses.length ? `Owns ${count(user.ownedUniverses.length, 'universe')}` : null,
              user.worldMemberships.length ? `Member of ${count(user.worldMemberships.length, 'world')}` : null,
              user.isGuest && 'Guest',
            ]}
          />
        }
        action={
          canInvite ? (
            <Button onClick={() => setInviteDialogOpen(true)} className="h-10 shrink-0 gap-2 px-4">
              <UserPlus size={15} aria-hidden="true" />
              Invite to a world
            </Button>
          ) : undefined
        }
      >
        {bio || links.length > 0 ? (
          <div className="grid min-w-0 gap-3">
            {bio && <p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">{bio}</p>}
            <ProfileLinks links={links} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{isSelf ? 'You haven’t written a profile yet.' : `${name} hasn’t written a profile yet.`}</p>
        )}
      </ProfileFrame>

      {error && (
        <p className="text-sm text-muted-foreground" role="alert">
          {error}
        </p>
      )}

      <section className="grid min-w-0 gap-2" aria-labelledby="person-universes">
        <SectionHeader id="person-universes" title="Universes" count={user.ownedUniverses.length} />
        {user.ownedUniverses.length === 0 ? (
          <EmptyCard kind="universe" title="No universes yet." text={isSelf ? 'You don’t own a universe yet.' : `${name} doesn’t own a universe yet.`} />
        ) : (
          <div className="grid min-w-0 gap-0.5">
            {user.ownedUniverses.map((universe) => {
              const analytics = universeAnalytics[universe.id];
              const stars = universe._count?.favorites ?? 0;
              return (
                <EntityRow
                  key={universe.id}
                  href={`/admin/universes/${universe.id}`}
                  kind="universe"
                  universeId={universe.id}
                  title={universe.name}
                  context={
                    <StatLine
                      items={[
                        count(universe._count?.worlds ?? 0, 'world'),
                        count(universe._count?.rooms ?? 0, 'room'),
                        count(universe._count?.members ?? 0, 'member'),
                        analytics && count(analytics.totalAccesses, 'visit'),
                      ]}
                    />
                  }
                  meta={<VisitLine {...visits(analytics)} />}
                  aside={
                    <>
                      {stars > 0 && <span>★ {stars}</span>}
                      <StatusPill status={universe.isPublic ? 'public' : 'private'} />
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="grid min-w-0 gap-2" aria-labelledby="person-memberships">
        <SectionHeader id="person-memberships" title="Memberships" count={user.worldMemberships.length} />
        {user.worldMemberships.length === 0 ? (
          <EmptyCard kind="world" title="No memberships yet." text={isSelf ? 'You’re not a member of any world yet.' : `${name} isn’t a member of any world yet.`} />
        ) : (
          <div className="grid min-w-0 gap-0.5">
            {user.worldMemberships.map((membership) => {
              const analytics = worldAnalytics[membership.world.id];
              const stars = membership.world._count?.favorites ?? 0;
              return (
                <EntityRow
                  key={membership.id}
                  href={`/admin/worlds/${membership.world.id}`}
                  kind="world"
                  title={membership.world.name}
                  context={
                    <StatLine
                      items={[
                        membership.world.universe.name,
                        count(membership.world._count?.rooms ?? 0, 'room'),
                        count(membership.world._count?.members ?? 0, 'member'),
                        analytics && count(analytics.totalAccesses, 'visit'),
                      ]}
                    />
                  }
                  meta={
                    <>
                      <RolePills roles={membership.tags.length ? membership.tags : ['member']} />
                      {analytics ? (
                        <VisitLine {...visits(analytics)} />
                      ) : (
                        <StatLine items={[`Joined ${new Date(membership.joinedAt).toLocaleDateString()}`]} />
                      )}
                    </>
                  }
                  aside={stars > 0 ? `★ ${stars}` : undefined}
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="grid min-w-0 gap-2" aria-labelledby="person-stars">
        <SectionHeader id="person-stars" title="Stars" count={starredRooms.length} />
        {starredRoomsLoading && starredRooms.length === 0 ? (
          <LoadingRows label="starred rooms" />
        ) : starredRooms.length === 0 ? (
          <EmptyCard kind="star" title="No stars yet." text={isSelf ? 'You haven’t starred a room yet.' : `${name} hasn’t starred a room yet.`} />
        ) : (
          <div className="grid min-w-0 gap-0.5">
            {starredRooms.map((room) => (
              <EntityRow
                key={room.id}
                href={`/admin/rooms/${room.id}`}
                kind="star"
                title={room.name}
                context={
                  <StatLine
                    items={[`${room.world.universe.name} › ${room.world.name}`, room.favoritedAt && !Number.isNaN(Date.parse(room.favoritedAt)) && `starred ${timeAgo(new Date(room.favoritedAt))}`]}
                  />
                }
                aside={room.starCount > 0 ? `★ ${room.starCount}` : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {showPrivate && (
        <details className="group min-w-0 rounded-2xl border border-border bg-card" data-testid="admin-details">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <span>{isSuperAdmin ? 'Admin details' : 'Private details'}</span>
            <ChevronRight size={16} className="text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
          </summary>
          <div className="grid min-w-0 gap-5 border-t border-border px-4 py-4">
            {!isSuperAdmin && <p className="text-xs text-muted-foreground">Only you and Orbit’s admins see this.</p>}
            <dl className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Email</dt>
                <dd className="mt-0.5 [overflow-wrap:anywhere]">
                  {user.email ? (
                    <a href={`mailto:${user.email}`} className={linkClass}>
                      {user.email}
                    </a>
                  ) : (
                    'None'
                  )}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Matrix ID</dt>
                <dd className="mt-0.5 font-mono text-xs [overflow-wrap:anywhere]">{user.matrixChatId || 'None'}</dd>
              </div>
              {isSuperAdmin && (
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Last IP address</dt>
                  <dd className="mt-0.5 font-mono text-xs [overflow-wrap:anywhere]">{user.lastIpAddress || 'None'}</dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Joined</dt>
                <dd className="mt-0.5">{timeAgo(new Date(user.createdAt))}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Last updated</dt>
                <dd className="mt-0.5">{timeAgo(new Date(user.updatedAt))}</dd>
              </div>
            </dl>

            {!accessHistoryHidden && (
              <div className="grid min-w-0 gap-3" data-testid="access-history">
                <div className="grid gap-0.5">
                  <h2 className="text-sm font-semibold">Visits</h2>
                  {accessHistory && (
                    <StatLine
                      items={[
                        count(accessHistory.total ?? 0, 'visit'),
                        accessHistory.firstAccess && `first ${new Date(accessHistory.firstAccess).toLocaleDateString()}`,
                        accessHistory.lastAccess && `last ${timeAgo(new Date(accessHistory.lastAccess))}`,
                      ]}
                    />
                  )}
                </div>
                {accessHistoryLoading && !accessHistory ? (
                  <LoadingRows label="visits" />
                ) : accessHistory && accessHistory.accesses.length > 0 ? (
                  <>
                    <ul className="grid min-w-0 gap-1">
                      {accessHistory.accesses.map((access) => (
                        <li key={access.id} className="grid min-w-0 gap-1 rounded-xl px-3 py-2.5 text-xs hover:bg-foreground/[0.04]">
                          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <span className="min-w-0 text-sm">
                              <Link href={`/admin/universes/${access.universe.id}`} className={linkClass}>
                                {access.universe.name}
                              </Link>
                              <span className="text-muted-foreground" aria-hidden="true">
                                {' › '}
                              </span>
                              <Link href={`/admin/worlds/${access.world.id}`} className={linkClass}>
                                {access.world.name}
                              </Link>
                              <span className="text-muted-foreground" aria-hidden="true">
                                {' › '}
                              </span>
                              <Link href={`/admin/rooms/${access.room.id}`} className={linkClass}>
                                {access.room.name}
                              </Link>
                            </span>
                            <span className="shrink-0 text-muted-foreground">{timeAgo(new Date(access.accessedAt))}</span>
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
                            {access.hasMembership && access.membershipTags.length > 0 ? (
                              <RolePills roles={access.membershipTags} />
                            ) : (
                              <span>{access.isAuthenticated ? 'Signed in' : 'Guest'}</span>
                            )}
                            {isSuperAdmin && access.ipAddress && <span className="font-mono">{access.ipAddress}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {accessHistory.totalPages > 1 && (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground">
                          {(accessHistory.page - 1) * accessHistory.limit + 1}–{Math.min(accessHistory.page * accessHistory.limit, accessHistory.total)} of{' '}
                          {accessHistory.total.toLocaleString()}
                        </span>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            className="h-9 gap-1 px-3"
                            onClick={() => setAccessHistoryPage((prev) => Math.max(1, prev - 1))}
                            disabled={accessHistoryPage === 1}
                          >
                            <ChevronLeft aria-hidden="true" />
                            Previous
                          </Button>
                          <Button
                            variant="outline"
                            className="h-9 gap-1 px-3"
                            onClick={() => setAccessHistoryPage((prev) => prev + 1)}
                            disabled={accessHistoryPage >= (accessHistory.totalPages || 1)}
                          >
                            Next
                            <ChevronRight aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No visits yet.</p>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      <InviteToWorldDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        userId={id}
        onInviteSent={() => {
          fetchUser();
        }}
      />
    </div>
  );
}
