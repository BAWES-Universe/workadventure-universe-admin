'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
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
import { Check, Loader2, X } from 'lucide-react';
import {
  EmptyCard,
  EntityRow,
  LoadingRows,
  PageHeader,
  RolePills,
  SectionHeader,
  StatLine,
  StatusPill,
  VisitLine,
  count,
} from '../components/ds';

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
  const [worldAnalytics, setWorldAnalytics] = useState<Record<string, { totalAccesses: number; lastVisitedByUser: { accessedAt: string } | null; lastVisitedOverall: { accessedAt: string } | null }>>({});

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

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Memberships" />

      {error && (
        <p className="text-sm text-muted-foreground" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <LoadingRows label="your memberships" rows={3} />
      ) : (
        <>
          {invitations.length > 0 && (
            <section className="grid min-w-0 gap-2" aria-labelledby="invitations-heading" data-testid="invitations">
              <SectionHeader id="invitations-heading" title="Invitations" count={invitations.length} />
              <div className="grid min-w-0 gap-0.5">
                {invitations.map((invitation) => {
                  const from = invitation.invitedBy?.name || invitation.invitedBy?.email;
                  const busy = processingInvitation === invitation.id;
                  return (
                    <EntityRow
                      key={invitation.id}
                      href={`/admin/worlds/${invitation.world.id}`}
                      kind="world"
                      title={invitation.world.name}
                      context={
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <StatusPill status="waiting" />
                          {from ? `${from} invited you` : 'You’re invited'}
                          {invitation.tags.length ? ` as ${invitation.tags.join(', ')}` : ''} · {invitation.world.universe.name}
                        </span>
                      }
                      meta={
                        invitation.message ? (
                          <span className="text-xs italic text-muted-foreground [overflow-wrap:anywhere]">“{invitation.message}”</span>
                        ) : undefined
                      }
                      trailing={
                        <>
                          <Button
                            variant="outline"
                            className="h-9 w-9 p-0"
                            aria-label={`Decline the invitation to ${invitation.world.name}`}
                            disabled={busy}
                            onClick={() => handleRejectInvitation(invitation.id)}
                          >
                            <X size={16} aria-hidden="true" />
                          </Button>
                          <Button className="h-9 gap-1.5 px-4" disabled={busy} onClick={() => handleAcceptInvitation(invitation.id)}>
                            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                            Accept
                          </Button>
                        </>
                      }
                    />
                  );
                })}
              </div>
            </section>
          )}

          <section
            className="grid min-w-0 gap-2"
            {...(invitations.length > 0 ? { 'aria-labelledby': 'memberships-heading' } : { 'aria-label': 'Your worlds' })}
          >
            {invitations.length > 0 && <SectionHeader id="memberships-heading" title="Your worlds" count={memberships.length} />}
            {memberships.length === 0 ? (
              <EmptyCard
                kind="world"
                title="No memberships yet."
                text="You become a member when someone invites you to their world, or when you create a world of your own."
                href="/admin/you"
                action="Go to You"
              />
            ) : (
              <div className="grid min-w-0 gap-0.5">
                {memberships.map((membership) => {
                  const analytics = worldAnalytics[membership.world.id];
                  const you = analytics?.lastVisitedByUser?.accessedAt ?? null;
                  const latest = analytics?.lastVisitedOverall?.accessedAt ?? null;
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
                          <RolePills roles={[...(membership.isUniverseOwner ? ['owner'] : []), ...membership.tags]} />
                          {analytics ? (
                            <VisitLine you={you} latest={latest} youWereLast={Boolean(you && latest && you === latest)} />
                          ) : (
                            <StatLine
                              items={[
                                `Joined ${new Date(membership.joinedAt).toLocaleDateString()}`,
                                membership.lastVisited && `last visited ${new Date(membership.lastVisited).toLocaleDateString()}`,
                              ]}
                            />
                          )}
                        </>
                      }
                      aside={stars > 0 ? `★ ${stars}` : undefined}
                      trailing={
                        !membership.isUniverseOwner ? (
                          <Button
                            variant="outline"
                            className="h-9 px-4"
                            onClick={() => setLeavingWorld(membership.world.id)}
                            aria-label={`Leave ${membership.world.name}`}
                          >
                            Leave
                          </Button>
                        ) : undefined
                      }
                    />
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {/* Leave World Dialog */}
      <AlertDialog open={!!leavingWorld} onOpenChange={(open) => !open && setLeavingWorld(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this world?</AlertDialogTitle>
            <AlertDialogDescription>
              You lose access to it, and someone has to invite you again to come back.
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

