'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, AlertCircle, CheckCircle2, XCircle, Users, Mail, Home, Globe, Calendar, Clock, ChevronRight, Activity, Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Invitation {
  id: string;
  world: {
    id: string;
    name: string;
    slug: string;
    universe: {
      id: string;
      name: string;
      slug: string;
    };
  };
  invitedBy: {
    id: string;
    name: string | null;
    email: string | null;
  };
  invitedAt: string;
  tags: string[];
  message: string | null;
}

interface Membership {
  id: string;
  tags: string[];
  joinedAt: string;
  lastVisited: string | null;
  isUniverseOwner: boolean;
  world: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    thumbnailUrl: string | null;
    universe: {
      id: string;
      name: string;
      slug: string;
      ownerId: string;
    };
    _count?: {
      rooms?: number;
      members?: number;
      favorites?: number;
    };
  };
}

export default function MyMembershipsPage() {
  const router = useRouter();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingInvitation, setProcessingInvitation] = useState<string | null>(null);
  const [leavingWorld, setLeavingWorld] = useState<string | null>(null);
  const [worldAnalytics, setWorldAnalytics] = useState<Record<string, { totalAccesses: number; lastVisitedByUser: any; lastVisitedOverall: any }>>({});

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (memberships.length > 0) {
      fetchWorldAnalytics();
    }
  }, [memberships]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      fetchData();
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchData() {
    try {
      setLoading(true);
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');

      const [invitationsRes, membershipsRes] = await Promise.all([
        authenticatedFetch('/api/memberships/invitations'),
        authenticatedFetch('/api/memberships/my'),
      ]);

      if (!invitationsRes.ok) {
        throw new Error('Failed to fetch invitations');
      }
      if (!membershipsRes.ok) {
        throw new Error('Failed to fetch memberships');
      }

      const invitationsData = await invitationsRes.json();
      const membershipsData = await membershipsRes.json();

      setInvitations(invitationsData.invitations || []);
      
      // Deduplicate memberships by worldId (in case user is both owner and member)
      const membershipsList = membershipsData.memberships || [];
      const seenWorlds = new Set<string>();
      const uniqueMemberships = membershipsList.filter((m: Membership) => {
        if (seenWorlds.has(m.world.id)) {
          return false;
        }
        seenWorlds.add(m.world.id);
        return true;
      });
      
      setMemberships(uniqueMemberships);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  async function handleAcceptInvitation(invitationId: string) {
    try {
      setProcessingInvitation(invitationId);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/memberships/invitations/${invitationId}/accept`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to accept invitation');
      }

      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
    } finally {
      setProcessingInvitation(null);
    }
  }

  async function handleRejectInvitation(invitationId: string) {
    try {
      setProcessingInvitation(invitationId);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/memberships/invitations/${invitationId}/reject`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reject invitation');
      }

      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject invitation');
    } finally {
      setProcessingInvitation(null);
    }
  }

  async function handleLeaveWorld(worldId: string) {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/memberships/my/world/${worldId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to leave world');
      }

      setLeavingWorld(null);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave world');
      setLeavingWorld(null);
    }
  }

  async function fetchWorldAnalytics() {
    if (!memberships.length) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const results = await Promise.all(
        memberships.map(async (membership) => {
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

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">My Memberships</h1>
        <p className="text-muted-foreground text-lg">
          Manage your world memberships and invitations.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Pending Invitations */}
      {invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Pending Invitations
            </CardTitle>
            <CardDescription>
              You have {invitations.length} pending invitation{invitations.length !== 1 ? 's' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {invitations.map((invitation) => (
                <Card key={invitation.id} className="border hover:bg-accent/50 transition-colors">
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between">
                      <div className="space-y-2 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link 
                            href={`/admin/worlds/${invitation.world.id}`}
                            className="font-semibold text-primary hover:underline"
                          >
                            {invitation.world.name}
                          </Link>
                          <span className="text-muted-foreground">/</span>
                          <Link 
                            href={`/admin/universes/${invitation.world.universe.id}`}
                            className="text-sm text-primary hover:underline"
                          >
                            {invitation.world.universe.name}
                          </Link>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Invited by{' '}
                          {invitation.invitedBy.name ||
                            invitation.invitedBy.email ||
                            'Unknown'}{' '}
                          on {new Date(invitation.invitedAt).toLocaleDateString()}
                        </p>
                        {invitation.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {invitation.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="capitalize">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {invitation.message && (
                          <p className="text-sm mt-2 italic text-muted-foreground">
                            "{invitation.message}"
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 ml-4">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRejectInvitation(invitation.id)}
                          disabled={processingInvitation === invitation.id}
                        >
                          {processingInvitation === invitation.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <XCircle className="h-4 w-4 mr-1" />
                              Reject
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleAcceptInvitation(invitation.id)}
                          disabled={processingInvitation === invitation.id}
                        >
                          {processingInvitation === invitation.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <CheckCircle2 className="h-4 w-4 mr-1" />
                              Accept
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* My Memberships */}
      {memberships.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              You are not a member of any worlds.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {memberships.map((membership) => {
              const roomsCount = membership.world._count?.rooms ?? 0;
              const membersCount = membership.world._count?.members ?? 0;
              const joinedDate = new Date(membership.joinedAt).toLocaleDateString();
              const lastVisitedDate = membership.lastVisited
                ? new Date(membership.lastVisited).toLocaleDateString()
                : null;

              return (
                <div key={membership.id} className="relative">
                  <Link
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
                              {membership.isUniverseOwner && (
                                <Badge variant="default">Owner</Badge>
                              )}
                              {membership.tags.length > 0 &&
                                membership.tags.map((tag) => (
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
                                ))}
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
                                {lastVisitedDate && (
                                  <div className="flex items-center gap-1.5">
                                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-muted-foreground">
                                      Last visited {lastVisitedDate}
                                    </span>
                                  </div>
                                )}
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
                  {!membership.isUniverseOwner && (
                    <Button
                      size="sm"
                      variant="destructive"
                      className="absolute top-2 right-2 z-10"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setLeavingWorld(membership.world.id);
                      }}
                    >
                      Leave
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

      {/* Leave World Dialog */}
      <AlertDialog open={!!leavingWorld} onOpenChange={(open) => !open && setLeavingWorld(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave World</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to leave this world? You will lose access and need to be
              invited again to rejoin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => leavingWorld && handleLeaveWorld(leavingWorld)}
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

