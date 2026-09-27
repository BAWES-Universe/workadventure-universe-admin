'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  LoadError,
  LoadingRows,
  PageHeader,
  RolePills,
  SectionHeader,
  StatLine,
  StatusPill,
  VisitLine,
  count,
} from '../components/ds';
import { activityStats } from '@/lib/analytics-peak';
import { useEntitySummaries } from '../hooks/use-entity-summaries';

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

type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: T[] };

/** Deduplicate memberships by worldId (in case user is both owner and member). */
function uniqueByWorld(list: Membership[]): Membership[] {
  const seenWorlds = new Set<string>();
  return list.filter((m) => {
    if (seenWorlds.has(m.world.id)) {
      return false;
    }
    seenWorlds.add(m.world.id);
    return true;
  });
}

async function readList<T>(url: string, key: string): Promise<T[]> {
  const { authenticatedFetch } = await import('@/lib/client-auth');
  const response = await authenticatedFetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${key}`);
  const data = await response.json();
  if (!data || !Array.isArray(data[key])) throw new Error(`Invalid ${key}`);
  return data[key] as T[];
}

export default function MyMembershipsPage() {
  const router = useRouter();
  const [invitationList, setInvitationList] = useState<Loaded<Invitation>>({ status: 'loading' });
  const [membershipList, setMembershipList] = useState<Loaded<Membership>>({ status: 'loading' });
  // What went wrong with the last Accept, Decline or Leave (a failed list load shows its own retry instead).
  const [error, setError] = useState<string | null>(null);
  // Every invitation with an Accept or Decline on its way: each locks only its own row.
  const [pendingInvitations, setPendingInvitations] = useState<ReadonlySet<string>>(() => new Set());
  const [leavingWorld, setLeavingWorld] = useState<string | null>(null);

  const invitations = invitationList.status === 'ready' ? invitationList.items : [];
  const memberships = membershipList.status === 'ready' ? membershipList.items : [];
  const worldIds = useMemo(() => memberships.map((membership) => membership.world.id), [memberships]);
  const worldSummaries = useEntitySummaries('worlds', worldIds);

  // A reload keeps what is shown until the answer arrives; only a failure replaces it (with a retry).
  // Answers can overlap (two invitations accepted at once): only the latest request of each list paints.
  const invitationRequest = useRef(0);
  const membershipRequest = useRef(0);

  const loadInvitations = useCallback(async () => {
    const request = ++invitationRequest.current;
    let next: Loaded<Invitation>;
    try {
      next = { status: 'ready', items: await readList<Invitation>('/api/memberships/invitations', 'invitations') };
    } catch {
      next = { status: 'error' };
    }
    if (request === invitationRequest.current) setInvitationList(next);
  }, []);

  const loadMemberships = useCallback(async () => {
    const request = ++membershipRequest.current;
    let next: Loaded<Membership>;
    try {
      next = { status: 'ready', items: uniqueByWorld(await readList<Membership>('/api/memberships/my', 'memberships')) };
    } catch {
      next = { status: 'error' };
    }
    if (request === membershipRequest.current) setMembershipList(next);
  }, []);

  const fetchData = useCallback(async () => {
    await Promise.all([loadInvitations(), loadMemberships()]);
  }, [loadInvitations, loadMemberships]);

  useEffect(() => {
    void (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');
        if (!response.ok) {
          router.push('/admin/login');
          return;
        }
        await fetchData();
      } catch {
        router.push('/admin/login');
      }
    })();
    // Once per visit: the router is only used to leave for sign-in, and fetchData never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setPending(invitationId: string, pending: boolean) {
    setPendingInvitations((current) => {
      const next = new Set(current);
      if (pending) next.add(invitationId);
      else next.delete(invitationId);
      return next;
    });
  }

  async function answerInvitation(invitationId: string, answer: 'accept' | 'reject') {
    if (pendingInvitations.has(invitationId)) return;
    setPending(invitationId, true);
    try {
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/memberships/invitations/${invitationId}/${answer}`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || (answer === 'accept' ? 'Failed to accept invitation' : 'Failed to reject invitation'));
      }

      // The row stays locked until the lists say what changed.
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : answer === 'accept' ? 'Failed to accept invitation' : 'Failed to reject invitation');
    } finally {
      setPending(invitationId, false);
    }
  }

  const handleAcceptInvitation = (invitationId: string) => answerInvitation(invitationId, 'accept');
  const handleRejectInvitation = (invitationId: string) => answerInvitation(invitationId, 'reject');

  async function handleLeaveWorld(worldId: string) {
    try {
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/memberships/my/world/${worldId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to leave world');
      }

      setLeavingWorld(null);
      await loadMemberships();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave world');
      setLeavingWorld(null);
    }
  }

  const loading = membershipList.status === 'loading' || invitationList.status === 'loading';

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
          {invitationList.status === 'error' && <LoadError label="your invitations" retry={() => void loadInvitations()} />}

          {invitations.length > 0 && (
            <section className="grid min-w-0 gap-2" aria-labelledby="invitations-heading" data-testid="invitations">
              <SectionHeader id="invitations-heading" title="Invitations" count={invitations.length} />
              <div className="grid min-w-0 gap-0.5">
                {invitations.map((invitation) => {
                  const from = invitation.invitedBy?.name || invitation.invitedBy?.email;
                  const busy = pendingInvitations.has(invitation.id);
                  return (
                    <EntityRow
                      key={invitation.id}
                      href={`/admin/worlds/${invitation.world.id}`}
                      kind="world"
                      tone="waiting"
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
            {invitations.length > 0 && <SectionHeader id="memberships-heading" title="Worlds" count={memberships.length} />}
            {membershipList.status === 'error' ? (
              <LoadError label="your memberships" retry={() => void loadMemberships()} />
            ) : memberships.length === 0 ? (
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
                  const analytics = worldSummaries.summary(membership.world.id);
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
                            ...activityStats(analytics),
                          ]}
                        />
                      }
                      meta={
                        <>
                          <RolePills roles={[...(membership.isUniverseOwner ? ['owner'] : []), ...membership.tags]} />
                          {analytics ? (
                            <VisitLine you={you} latest={latest} youWereLast={analytics.youWereLast} />
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
            {memberships.length > 0 && worldSummaries.failed.length > 0 && (
              <LoadError label="activity for some worlds" retry={() => worldSummaries.retry()} />
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

