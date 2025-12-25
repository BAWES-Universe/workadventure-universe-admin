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
import { ChevronRight, AlertCircle, Loader2, Globe, Users, Star, Ban, UserPlus, Activity, Home, Calendar, MapPin, ChevronLeft, ExternalLink, User, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
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
  email: string | null;
  matrixChatId: string | null;
  lastIpAddress: string | null;
  isGuest: boolean;
  createdAt: string;
  updatedAt: string;
  visitCard: VisitCard | null;
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
  const [activeTab, setActiveTab] = useState<'details' | 'owned-universes' | 'world-memberships' | 'starred-rooms' | 'access-history'>('details');
  const [starredRooms, setStarredRooms] = useState<any[]>([]);
  const [starredRoomsLoading, setStarredRoomsLoading] = useState(false);

  useEffect(() => {
    checkAuth();
    fetchUser();
  }, [id]);

  useEffect(() => {
    if (user) {
      // Fetch access history on initial load to show total and last access (page 1)
      fetchAccessHistory(1);
      // Fetch starred rooms on initial load to show count
      fetchStarredRooms();
    }
  }, [user, id]);

  useEffect(() => {
    if (activeTab === 'access-history' && user) {
      // Refetch when switching to access history tab or changing page
      fetchAccessHistory(accessHistoryPage);
    }
  }, [accessHistoryPage, activeTab, user]);

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

  useEffect(() => {
    if (activeTab === 'starred-rooms' && user) {
      fetchStarredRooms();
    }
  }, [activeTab, user]);

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

  async function fetchAccessHistory(page: number = 1) {
    try {
      setAccessHistoryLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/users/${id}?page=${page}&limit=10`);

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

      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">{user.name || user.email || 'Unknown User'}</h1>
          {accessHistory && (
            <p className="text-muted-foreground flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-sm">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium text-foreground/80">
                  {accessHistory.total?.toLocaleString() || 0} {accessHistory.total === 1 ? 'access' : 'accesses'}
                </span>
              </span>
              {accessHistory.lastAccess && (
                <>
                  <span className="text-muted-foreground">•</span>
                  <span className="text-sm">
                    Last: {formatTimeAgo(new Date(accessHistory.lastAccess))}
                  </span>
                </>
              )}
            </p>
          )}
        </div>
        {currentUser && currentUser.id !== user.id && availableWorlds.length > 0 && (
          <div className="w-full lg:w-auto">
            <Button onClick={() => setInviteDialogOpen(true)} className="w-full lg:w-auto">
              <UserPlus className="mr-2 h-4 w-4" />
              Invite to World
            </Button>
          </div>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Tabs */}
      <div>
        <nav className="flex flex-wrap gap-x-4 sm:gap-x-8 gap-y-2">
          <button
            onClick={() => setActiveTab('details')}
            className={`py-3 sm:py-4 px-1 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-1.5 sm:gap-2 transition-colors ${
              activeTab === 'details'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
            }`}
          >
            <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4 flex-shrink-0" />
            <span>Details</span>
          </button>
          <button
            onClick={() => setActiveTab('owned-universes')}
            className={`py-3 sm:py-4 px-1 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-1.5 sm:gap-2 transition-colors ${
              activeTab === 'owned-universes'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
            }`}
          >
            <Globe className="h-3.5 w-3.5 sm:h-4 sm:w-4 flex-shrink-0" />
            <span>Universes</span>
            {user && (
              <Badge variant="secondary" className="ml-0.5 text-xs font-normal">
                {user.ownedUniverses.length}
              </Badge>
            )}
          </button>
          <button
            onClick={() => setActiveTab('world-memberships')}
            className={`py-3 sm:py-4 px-1 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-1.5 sm:gap-2 transition-colors ${
              activeTab === 'world-memberships'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
            }`}
          >
            <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4 flex-shrink-0" />
            <span>Memberships</span>
            {user && (
              <Badge variant="secondary" className="ml-0.5 text-xs font-normal">
                {user.worldMemberships.length}
              </Badge>
            )}
          </button>
          <button
            onClick={() => setActiveTab('starred-rooms')}
            className={`py-3 sm:py-4 px-1 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-1.5 sm:gap-2 transition-colors ${
              activeTab === 'starred-rooms'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
            }`}
          >
            <Star className="h-3.5 w-3.5 sm:h-4 sm:w-4 flex-shrink-0" />
            <span>Stars</span>
            {!starredRoomsLoading && (
              <Badge variant="secondary" className="ml-0.5 text-xs font-normal">
                {starredRooms.length}
              </Badge>
            )}
          </button>
          <button
            onClick={() => setActiveTab('access-history')}
            className={`py-3 sm:py-4 px-1 border-b-2 font-medium text-xs sm:text-sm flex items-center gap-1.5 sm:gap-2 transition-colors ${
              activeTab === 'access-history'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
            }`}
          >
            <Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4 flex-shrink-0" />
            <span>Access</span>
            {accessHistory && accessHistory.total !== undefined && (
              <Badge variant="secondary" className="ml-0.5 text-xs font-normal">
                {accessHistory.total.toLocaleString()}
              </Badge>
            )}
          </button>
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'details' && (
        <>
          <section className="space-y-6">
            {/* Visit Card */}
            {user.visitCard && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold tracking-tight">Visit Card</h2>
                {user.visitCard.bio && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">Bio</p>
                    <p className="text-sm whitespace-pre-line">{user.visitCard.bio}</p>
                  </div>
                )}
                {user.visitCard.links && user.visitCard.links.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">Links</p>
                    <div className="flex flex-wrap gap-2">
                      {user.visitCard.links.map((link, index) => (
                        <a
                          key={index}
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border/70 bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
                        >
                          <span>{link.label}</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {!user.visitCard.bio && (!user.visitCard.links || user.visitCard.links.length === 0) && (
                  <p className="text-sm text-muted-foreground">No visit card information available</p>
                )}
              </div>
            )}

            {/* User Information */}
            <div className="space-y-4">
              <h2 className="text-xl font-semibold tracking-tight">User Information</h2>
              <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Email</dt>
                  <dd className="mt-1 text-sm">
                    {user.email ? (
                      <a href={`mailto:${user.email}`} className="text-primary hover:underline">
                        {user.email}
                      </a>
                    ) : (
                      'N/A'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Matrix Chat ID</dt>
                  <dd className="mt-1 text-sm font-mono text-xs">{user.matrixChatId || 'N/A'}</dd>
                </div>
                {isSuperAdmin && (
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">Last IP Address</dt>
                    <dd className="mt-1 text-sm font-mono text-xs">{user.lastIpAddress || 'N/A'}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                  <dd className="mt-1 text-sm">{formatTimeAgo(new Date(user.createdAt))}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Last Updated</dt>
                  <dd className="mt-1 text-sm">{formatTimeAgo(new Date(user.updatedAt))}</dd>
                </div>
              </dl>
            </div>
          </section>
        </>
      )}

      {activeTab === 'owned-universes' && (
        <>
          {user.ownedUniverses.length > 0 ? (
            <section className="space-y-4">
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
          ) : (
            <section className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">Owned Universes</h2>
                <p className="text-sm text-muted-foreground">
                  Universes owned by this user
                </p>
              </div>
              <div className="rounded-lg border border-border/70 bg-gradient-to-br from-background via-background to-background py-12 text-center text-sm text-muted-foreground">
                This user doesn't own any universes.
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === 'world-memberships' && (
        <>
          {user.worldMemberships.length > 0 ? (
            <section className="space-y-4">
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
          ) : (
            <section className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">World Memberships</h2>
                <p className="text-sm text-muted-foreground">
                  Worlds this user is a member of
                </p>
              </div>
              <div className="rounded-lg border border-border/70 bg-gradient-to-br from-background via-background to-background py-12 text-center text-sm text-muted-foreground">
                This user doesn't have any world memberships.
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === 'starred-rooms' && (
        <>
          {starredRoomsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : starredRooms.length > 0 ? (
            <section className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">Starred Rooms</h2>
                <p className="text-sm text-muted-foreground">
                  Rooms this user has favorited
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {starredRooms.map((room: any) => (
                  <Link
                    key={room.id}
                    href={`/admin/rooms/${room.id}`}
                    className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Card
                      className={cn(
                        'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                        'hover:-translate-y-1 hover:shadow-lg',
                      )}
                    >
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-transparent to-sky-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                      <div className="relative flex h-full flex-col p-5">
                        <div className="mb-3 flex items-start gap-3">
                          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted">
                            <MapPin className="h-5 w-5 text-muted-foreground" />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <h3 className="truncate text-base font-semibold leading-tight">
                              {room.name}
                            </h3>
                            <p className="truncate text-xs text-muted-foreground">
                              {room.world.universe.name} · {room.world.name}
                            </p>
                          </div>
                        </div>
                        {room.description && (
                          <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                            {room.description}
                          </p>
                        )}
                        <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">
                              Starred {new Date(room.favoritedAt).toLocaleDateString()}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 text-primary self-end">
                            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" aria-hidden="true" />
                            <span className="text-xs font-medium">{room.starCount}</span>
                          </div>
                        </div>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ) : (
            <section className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">Starred Rooms</h2>
                <p className="text-sm text-muted-foreground">
                  Rooms this user has favorited
                </p>
              </div>
              <div className="rounded-lg border border-border/70 bg-gradient-to-br from-background via-background to-background py-12 text-center text-sm text-muted-foreground">
                This user hasn't starred any rooms.
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === 'access-history' && (
        <>
          {accessHistoryLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : accessHistory && accessHistory.accesses.length > 0 ? (
            <div className="space-y-6">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">Access History</h2>
                {accessHistory && (
                  <p className="text-sm text-muted-foreground">
                    {accessHistory.total} total accesses
                    {accessHistory.firstAccess && (
                      <> • First: {new Date(accessHistory.firstAccess).toLocaleDateString()}</>
                    )}
                    {accessHistory.lastAccess && (
                      <> • Last: {new Date(accessHistory.lastAccess).toLocaleDateString()}</>
                    )}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {accessHistory.accesses.map((access: any) => {
                  const accessDate = new Date(access.accessedAt);
                  
                  return (
                    <Card
                      key={access.id}
                      className={cn(
                        'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                        'hover:-translate-y-1 hover:shadow-lg',
                      )}
                    >
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-pink-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                      <CardContent className="relative flex h-full flex-col p-4">
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="min-w-0 flex-1 flex items-center gap-2">
                            {access.hasMembership && access.membershipTags.length > 0 ? (
                              <Badge variant="outline" className="text-xs flex-shrink-0">{access.membershipTags.join(', ')}</Badge>
                            ) : access.isAuthenticated ? (
                              <Badge className="text-xs flex-shrink-0">Authenticated</Badge>
                            ) : (
                              <Badge variant="secondary" className="text-xs flex-shrink-0">Guest</Badge>
                            )}
                          </div>
                          <div className="flex-shrink-0 text-xs text-muted-foreground">
                            {formatTimeAgo(accessDate)}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">Universe:</span>
                            <Link
                              href={`/admin/universes/${access.universe.id}`}
                              className="text-primary hover:underline truncate"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {access.universe.name}
                            </Link>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">World:</span>
                            <Link
                              href={`/admin/worlds/${access.world.id}`}
                              className="text-primary hover:underline truncate"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {access.world.name}
                            </Link>
                          </div>
                          <div className="flex items-center gap-2 col-span-2">
                            <span className="text-muted-foreground">Room:</span>
                            <Link
                              href={`/admin/rooms/${access.room.id}`}
                              className="text-primary hover:underline truncate"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {access.room.name}
                            </Link>
                          </div>
                        </div>

                        {isSuperAdmin && access.ipAddress && (
                          <div className="mt-2 text-xs text-muted-foreground font-mono">
                            {access.ipAddress}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              {accessHistory.totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">
                    Showing {(accessHistory.page - 1) * accessHistory.limit + 1} to {Math.min(accessHistory.page * accessHistory.limit, accessHistory.total)} of {accessHistory.total} accesses
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAccessHistoryPage(prev => Math.max(1, prev - 1))}
                      disabled={accessHistoryPage === 1}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAccessHistoryPage(prev => prev + 1)}
                      disabled={accessHistoryPage >= (accessHistory.totalPages || 1)}
                    >
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Empty className="border border-border/70">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Activity className="h-6 w-6 text-muted-foreground" />
                </EmptyMedia>
                <EmptyTitle>No access history</EmptyTitle>
                <EmptyDescription>
                  Access history will appear here once this user starts accessing rooms.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent />
            </Empty>
          )}
        </>
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
