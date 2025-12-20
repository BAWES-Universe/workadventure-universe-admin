'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, AlertCircle, Loader2, Globe, Users, Star, Ban, UserPlus, Activity, Home, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
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

interface User {
  id: string;
  uuid: string;
  name: string | null;
  email: string | null;
  matrixChatId: string | null;
  lastIpAddress: string | null;
  isGuest: boolean;
  createdAt: string;
  updatedAt: string;
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

export default function UserDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessHistory, setAccessHistory] = useState<any>(null);
  const [accessHistoryLoading, setAccessHistoryLoading] = useState(true);
  const [accessHistoryPage, setAccessHistoryPage] = useState(1);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [availableWorlds, setAvailableWorlds] = useState<any[]>([]);
  const [worldsLoading, setWorldsLoading] = useState(false);
  const [universeAnalytics, setUniverseAnalytics] = useState<Record<string, { totalAccesses: number; lastVisitedByUser: any; lastVisitedOverall: any }>>({});
  const [worldAnalytics, setWorldAnalytics] = useState<Record<string, { totalAccesses: number; lastVisitedByUser: any; lastVisitedOverall: any }>>({});

  useEffect(() => {
    checkAuth();
    fetchUser();
    fetchAccessHistory();
  }, [id, accessHistoryPage]);

  useEffect(() => {
    if (currentUser && user && currentUser.id !== user.id) {
      fetchAvailableWorlds();
    }
  }, [currentUser, user]);

  useEffect(() => {
    if (user) {
      fetchUniverseAnalytics();
      fetchWorldAnalytics();
    }
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
    } catch (err) {
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

  async function fetchAccessHistory() {
    try {
      setAccessHistoryLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/users/${id}?page=${accessHistoryPage}&limit=20`);

      if (!response.ok) {
        throw new Error('Failed to fetch access history');
      }

      const data = await response.json();
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

  function formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
    if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
    if (diffDays < 7) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
    if (diffWeeks < 4) return `${diffWeeks} ${diffWeeks === 1 ? 'week' : 'weeks'} ago`;
    if (diffMonths < 12) return `${diffMonths} ${diffMonths === 1 ? 'month' : 'months'} ago`;
    return `${diffYears} ${diffYears === 1 ? 'year' : 'years'} ago`;
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Not Found</AlertTitle>
          <AlertDescription>User not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <nav className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Link href="/admin" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href="/admin/users" className="hover:text-foreground">
          Users
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{user.name || user.email || 'User'}</span>
      </nav>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">{user.name || user.email || 'Unknown User'}</h1>
        </div>
        {currentUser && currentUser.id !== user.id && availableWorlds.length > 0 && (
          <Button onClick={() => setInviteDialogOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Invite to World
          </Button>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>User Information</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Name</dt>
              <dd className="mt-1 text-sm">{user.name || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Email</dt>
              <dd className="mt-1 text-sm">{user.email || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Matrix Chat ID</dt>
              <dd className="mt-1 text-sm font-mono text-xs">{user.matrixChatId || 'N/A'}</dd>
            </div>
            {isSuperAdmin && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Last IP Address</dt>
                <dd className="mt-1 text-sm font-mono text-xs">{user.lastIpAddress || 'N/A'}</dd>
              </div>
            )}
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Created</dt>
              <dd className="mt-1 text-sm">{new Date(user.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Last Updated</dt>
              <dd className="mt-1 text-sm">{new Date(user.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Star className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="ml-4 flex-1">
                <p className="text-sm font-medium text-muted-foreground">Favorites</p>
                <p className="text-2xl font-semibold">{user._count.favorites}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Ban className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="ml-4 flex-1">
                <p className="text-sm font-medium text-muted-foreground">Bans</p>
                <p className="text-2xl font-semibold">{user._count.bans}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {user.ownedUniverses.length > 0 && (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">Owned Universes</h2>
            <p className="text-sm text-muted-foreground">
              Universes owned by this user
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {user.ownedUniverses.map((universe) => {
              return (
                <Link
                  key={universe.id}
                  href={`/admin/universes/${universe.id}`}
                  className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Card
                    className={cn(
                      'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                      'hover:-translate-y-1 hover:shadow-lg',
                    )}
                  >
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-indigo-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

                    <div className="relative flex h-full flex-col p-5">
                      <div className="mb-4 flex items-start gap-3">
                        {universe.thumbnailUrl ? (
                          <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border bg-muted">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={universe.thumbnailUrl}
                              alt={universe.name}
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : (
                          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border bg-muted text-lg font-semibold">
                            {universe.name?.charAt(0)?.toUpperCase() || '?'}
                          </div>
                        )}

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="truncate text-base font-semibold leading-tight">
                              {universe.name}
                            </h3>
                          </div>
                          <p className="truncate text-xs font-mono text-muted-foreground">
                            {universe.slug}
                          </p>
                        </div>
                      </div>

                      {universe.description && (
                        <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                          {universe.description}
                        </p>
                      )}

                      <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
                        <div className="flex flex-col gap-1.5 min-h-[3rem]">
                          {universeAnalytics[universe.id] ? (
                            <>
                              <div className="flex items-center gap-1.5">
                                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="font-medium text-foreground/80">
                                  {universeAnalytics[universe.id].totalAccesses.toLocaleString()} accesses
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                  {(universe._count?.worlds ?? 0)} {(universe._count?.worlds ?? 0) === 1 ? 'world' : 'worlds'} · {(universe._count?.rooms ?? 0)} {(universe._count?.rooms ?? 0) === 1 ? 'room' : 'rooms'} · {(universe._count?.members ?? 0)}{' '}
                                  {(universe._count?.members ?? 0) === 1 ? 'member' : 'members'}
                                </span>
                              </div>
                              {(universeAnalytics[universe.id].lastVisitedByUser || universeAnalytics[universe.id].lastVisitedOverall) && (
                                <div className="flex flex-col gap-0.5 mt-0.5">
                                  {universeAnalytics[universe.id].lastVisitedByUser && (
                                    <div className="text-[11px]">
                                      <span className="text-muted-foreground/70">Last visited by you: </span>
                                      <span className="font-medium text-foreground/80">
                                        {formatTimeAgo(new Date(universeAnalytics[universe.id].lastVisitedByUser.accessedAt))}
                                      </span>
                                    </div>
                                  )}
                                  {universeAnalytics[universe.id].lastVisitedOverall && (
                                    <div className="text-[11px]">
                                      {universeAnalytics[universe.id].lastVisitedByUser && 
                                       universeAnalytics[universe.id].lastVisitedByUser.accessedAt === universeAnalytics[universe.id].lastVisitedOverall.accessedAt ? (
                                        <span className="text-muted-foreground/70 italic">
                                          You were the last visitor
                                        </span>
                                      ) : (
                                        <>
                                          <span className="text-muted-foreground/70">Most recent visitor: </span>
                                          <span className="font-medium text-foreground/80">
                                            {formatTimeAgo(new Date(universeAnalytics[universe.id].lastVisitedOverall.accessedAt))}
                                          </span>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-muted-foreground">
                                {(universe._count?.worlds ?? 0)} {(universe._count?.worlds ?? 0) === 1 ? 'world' : 'worlds'} · {(universe._count?.rooms ?? 0)} {(universe._count?.rooms ?? 0) === 1 ? 'room' : 'rooms'} · {(universe._count?.members ?? 0)}{' '}
                                {(universe._count?.members ?? 0) === 1 ? 'member' : 'members'}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-primary self-end">
                          <Star className="h-4 w-4" aria-hidden="true" />
                          <span className="text-xs font-medium">{universe._count?.favorites ?? 0}</span>
                        </div>
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {user.worldMemberships.length > 0 && (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">World Memberships</h2>
            <p className="text-sm text-muted-foreground">
              Worlds this user is a member of
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {user.worldMemberships.map((membership) => {
              const roomsCount = membership.world._count?.rooms ?? 0;
              const membersCount = membership.world._count?.members ?? 0;
              const joinedDate = new Date(membership.joinedAt).toLocaleDateString();
              return (
                <Link
                  key={membership.id}
                  href={`/admin/worlds/${membership.world.id}`}
                  className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Card
                    className={cn(
                      'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                      'hover:-translate-y-1 hover:shadow-lg',
                    )}
                  >
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-purple-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

                    <div className="relative flex h-full flex-col p-5">
                      <div className="mb-4 flex items-start gap-3">
                        {membership.world.thumbnailUrl ? (
                          <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border bg-muted">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={membership.world.thumbnailUrl}
                              alt={membership.world.name}
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : (
                          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border bg-muted text-lg font-semibold">
                            {membership.world.name?.charAt(0)?.toUpperCase() || '?'}
                          </div>
                        )}

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="truncate text-base font-semibold leading-tight">
                              {membership.world.name}
                            </h3>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {membership.world.universe.name} · {membership.world.slug}
                          </p>

                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                            {membership.tags.length > 0
                              ? membership.tags.map((tag) => (
                                  <Badge
                                    key={tag}
                                    variant={
                                      tag === 'admin'
                                        ? 'destructive'
                                        : tag === 'editor'
                                          ? 'default'
                                          : 'secondary'
                                    }
                                    className="capitalize"
                                  >
                                    {tag}
                                  </Badge>
                                ))
                              : (
                                  <Badge variant="secondary">Member</Badge>
                                )}
                          </div>
                        </div>
                      </div>

                      {membership.world.description && (
                        <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                          {membership.world.description}
                        </p>
                      )}

                      <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
                        <div className="flex flex-col gap-1.5 min-h-[3rem]">
                          {worldAnalytics[membership.world.id] ? (
                            <>
                              <div className="flex items-center gap-1.5">
                                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="font-medium text-foreground/80">
                                  {worldAnalytics[membership.world.id].totalAccesses.toLocaleString()} accesses
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                  {roomsCount} {roomsCount === 1 ? 'room' : 'rooms'} · {membersCount}{' '}
                                  {membersCount === 1 ? 'member' : 'members'}
                                </span>
                              </div>
                              {(worldAnalytics[membership.world.id].lastVisitedByUser || worldAnalytics[membership.world.id].lastVisitedOverall) && (
                                <div className="flex flex-col gap-0.5 mt-0.5">
                                  {worldAnalytics[membership.world.id].lastVisitedByUser && (
                                    <div className="text-[11px]">
                                      <span className="text-muted-foreground/70">Last visited by you: </span>
                                      <span className="font-medium text-foreground/80">
                                        {formatTimeAgo(new Date(worldAnalytics[membership.world.id].lastVisitedByUser.accessedAt))}
                                      </span>
                                    </div>
                                  )}
                                  {worldAnalytics[membership.world.id].lastVisitedOverall && (
                                    <div className="text-[11px]">
                                      {worldAnalytics[membership.world.id].lastVisitedByUser && 
                                       worldAnalytics[membership.world.id].lastVisitedByUser.accessedAt === worldAnalytics[membership.world.id].lastVisitedOverall.accessedAt ? (
                                        <span className="text-muted-foreground/70 italic">
                                          You were the last visitor
                                        </span>
                                      ) : (
                                        <>
                                          <span className="text-muted-foreground/70">Most recent visitor: </span>
                                          <span className="font-medium text-foreground/80">
                                            {formatTimeAgo(new Date(worldAnalytics[membership.world.id].lastVisitedOverall.accessedAt))}
                                          </span>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="flex items-center gap-1.5">
                                <Home className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="font-medium text-foreground/80">
                                  {roomsCount} {roomsCount === 1 ? 'room' : 'rooms'} · {membersCount}{' '}
                                  {membersCount === 1 ? 'member' : 'members'}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                  Joined {joinedDate}
                                </span>
                              </div>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-primary self-end">
                          <Star className="h-4 w-4" aria-hidden="true" />
                          <span className="text-xs font-medium">{membership.world._count?.favorites ?? 0}</span>
                        </div>
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {user.ownedUniverses.length === 0 && user.worldMemberships.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            This user doesn't own any universes or have any world memberships.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Access History</CardTitle>
          {accessHistory && (
            <CardDescription>
              {accessHistory.total} total accesses
              {accessHistory.firstAccess && (
                <> • First: {new Date(accessHistory.firstAccess).toLocaleDateString()}</>
              )}
              {accessHistory.lastAccess && (
                <> • Last: {new Date(accessHistory.lastAccess).toLocaleDateString()}</>
              )}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {accessHistoryLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : accessHistory && accessHistory.accesses.length > 0 ? (
            <div className="space-y-4">
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Universe / World / Room</TableHead>
                      {isSuperAdmin && <TableHead>IP Address</TableHead>}
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accessHistory.accesses.map((access: any) => (
                      <TableRow key={access.id}>
                        <TableCell className="text-sm">
                          {new Date(access.accessedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex flex-wrap items-center gap-1">
                            <Link
                              href={`/admin/universes/${access.universe.id}`}
                              className="text-primary hover:underline"
                            >
                              {access.universe.name}
                            </Link>
                            <span className="text-muted-foreground">/</span>
                            <Link
                              href={`/admin/worlds/${access.world.id}`}
                              className="text-primary hover:underline"
                            >
                              {access.world.name}
                            </Link>
                            <span className="text-muted-foreground">/</span>
                            <Link
                              href={`/admin/rooms/${access.room.id}`}
                              className="text-primary hover:underline"
                            >
                              {access.room.name}
                            </Link>
                          </div>
                        </TableCell>
                        {isSuperAdmin && (
                          <TableCell className="text-sm font-mono text-muted-foreground">
                            {access.ipAddress}
                          </TableCell>
                        )}
                        <TableCell>
                          {access.hasMembership && access.membershipTags.length > 0 ? (
                            <Badge variant="outline">{access.membershipTags.join(', ')}</Badge>
                          ) : access.isAuthenticated ? (
                            <Badge>Authenticated</Badge>
                          ) : (
                            <Badge variant="secondary">Guest</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {accessHistory.totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <Button
                    variant="outline"
                    onClick={() => setAccessHistoryPage(p => Math.max(1, p - 1))}
                    disabled={accessHistoryPage === 1}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {accessHistoryPage} of {accessHistory.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => setAccessHistoryPage(p => Math.min(accessHistory.totalPages, p + 1))}
                    disabled={accessHistoryPage >= accessHistory.totalPages}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-12">No access history found.</p>
          )}
        </CardContent>
      </Card>

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
