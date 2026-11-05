'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Check, Crown, Loader2, X } from 'lucide-react';
import { whatMovesCount } from '@/lib/ownership-text';
import { FormSheet } from '../components/form-sheet';
import {
  EmptyCard,
  EntityRow,
  KIND_ICON,
  LoadError,
  LoadingRows,
  PageHeader,
  Place,
  SectionHeader,
  StatusPill,
} from '../components/ds';
import { RoleChip } from '../components/universe-people';
import { JoinedUniverseRow, OwnedUniverseRow, type UniverseMembership } from '../components/membership-rows';

const UniverseGlyph = KIND_ICON.universe;
/** A group of universe rows: one column on a phone, two on a wide screen. */
const GROUP = 'grid min-w-0 gap-2 md:grid-cols-2';

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
  /** A universe invitation (#314): the universe they join, the worlds they get and the roles that come with it. */
  universeId?: string | null;
  allWorlds?: boolean;
  worldIds?: string[];
  roles?: { id: string; name: string; color: string }[];
}

/** Where a universe invitation lets them in. Its world is the first one picked, so only one world can be named. */
function invitedWorlds(invitation: Invitation): string {
  if (invitation.allWorlds) return 'Every world';
  const worldIds = invitation.worldIds ?? [];
  if (worldIds.length <= 1) return `${invitation.world.name} only`;
  return `${worldIds.length} worlds`;
}

type Membership = UniverseMembership;

/** A universe offered to you (#820): the whole universe, once you accept. */
interface OwnershipOffer {
  id: string;
  createdAt: string;
  universe: { id: string; name: string; worldCount: number };
  owner: { id: string; name: string | null };
}

type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: T[] };

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
  const [offerList, setOfferList] = useState<Loaded<OwnershipOffer>>({ status: 'loading' });
  // What went wrong with the last Accept, Decline or Leave (a failed list load shows its own retry instead).
  const [error, setError] = useState<string | null>(null);
  // What the last Accept gave differently from what the invitation said (an older one offering Admin in one world).
  const [notice, setNotice] = useState<string | null>(null);
  // Every invitation with an Accept or Decline on its way: each locks only its own row.
  const [pendingInvitations, setPendingInvitations] = useState<ReadonlySet<string>>(() => new Set());
  const [leaving, setLeaving] = useState<Membership | null>(null);
  const [me, setMe] = useState<string | null>(null);

  const invitations = invitationList.status === 'ready' ? invitationList.items : [];
  const offers = offerList.status === 'ready' ? offerList.items : [];
  const memberships = membershipList.status === 'ready' ? membershipList.items : [];
  // Universes you joined come first (the ones you can leave); the ones you own say so once, in their heading.
  const joined = memberships.filter((membership) => !membership.isOwner);
  const owned = memberships.filter((membership) => membership.isOwner);

  // A reload keeps what is shown until the answer arrives; only a failure replaces it (with a retry).
  // Answers can overlap (two invitations accepted at once): only the latest request of each list paints.
  const invitationRequest = useRef(0);
  const membershipRequest = useRef(0);
  const offerRequest = useRef(0);

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
      next = { status: 'ready', items: await readList<Membership>('/api/memberships/my/universes', 'universes') };
    } catch {
      next = { status: 'error' };
    }
    if (request === membershipRequest.current) setMembershipList(next);
  }, []);

  const loadOffers = useCallback(async () => {
    const request = ++offerRequest.current;
    let next: Loaded<OwnershipOffer>;
    try {
      next = { status: 'ready', items: await readList<OwnershipOffer>('/api/memberships/ownership-offers', 'offers') };
    } catch {
      next = { status: 'error' };
    }
    if (request === offerRequest.current) setOfferList(next);
  }, []);

  const fetchData = useCallback(async () => {
    await Promise.all([loadInvitations(), loadMemberships(), loadOffers()]);
  }, [loadInvitations, loadMemberships, loadOffers]);

  useEffect(() => {
    void (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');
        if (!response.ok) {
          router.push('/admin/login');
          return;
        }
        setMe((await response.json().catch(() => ({})))?.user?.id ?? null);
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
      setNotice(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/memberships/invitations/${invitationId}/${answer}`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || (answer === 'accept' ? 'Failed to accept invitation' : 'Failed to reject invitation'));
      }

      const notGiven: string[] = answer === 'accept' ? ((await response.json().catch(() => ({})))?.rolesNotGiven ?? []) : [];
      if (notGiven.length > 0) {
        const universe = invitations.find((invitation) => invitation.id === invitationId)?.world.universe.name ?? 'the universe';
        setNotice(
          `You joined without ${notGiven.join(', ')}. A role with Administrator works in every world, so it can’t come with an invitation to some worlds. Ask an Admin of ${universe} to give it to you.`,
        );
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
  // The invitation whose Decline is waiting for Keep or Decline.
  const [confirmingDecline, setConfirmingDecline] = useState<string | null>(null);

  // The universe offered to you whose Accept sheet is open, or whose Decline is waiting for Keep or Decline, and the ones with an answer on its way
  const [accepting, setAccepting] = useState<OwnershipOffer | null>(null);
  const [confirmingOfferDecline, setConfirmingOfferDecline] = useState<string | null>(null);
  const [answeringOffers, setAnsweringOffers] = useState<ReadonlySet<string>>(() => new Set());
  const [ownedNotice, setOwnedNotice] = useState<string | null>(null);

  async function answerOffer(offer: OwnershipOffer, answer: 'accept' | 'decline') {
    if (answeringOffers.has(offer.id)) return;
    setAnsweringOffers((current) => new Set(current).add(offer.id));
    try {
      setError(null);
      setNotice(null);
      setOwnedNotice(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/memberships/ownership-offers/${offer.id}/${answer}`, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || (answer === 'accept' ? 'Couldn’t accept. Try again.' : 'Couldn’t decline. Try again.'));
      }
      if (answer === 'accept') {
        const data = await response.json().catch(() => ({}));
        const from = typeof data.previousOwnerName === 'string' && data.previousOwnerName ? data.previousOwnerName : 'The previous owner';
        setOwnedNotice(`You own ${offer.universe.name} now, with every world and room in it. ${from} stays as Admin.`);
      }
      setAccepting(null);
      setConfirmingOfferDecline(null);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t answer the offer. Try again.');
      setAccepting(null);
      // The offer may be gone (taken back, or they left): what is shown follows the server
      await loadOffers();
    } finally {
      setAnsweringOffers((current) => {
        const next = new Set(current);
        next.delete(offer.id);
        return next;
      });
    }
  }

  async function handleLeave(membership: Membership) {
    try {
      setError(null);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${membership.universe.id}/members/${me}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Couldn’t leave. Try again.');
      }

      setLeaving(null);
      await loadMemberships();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t leave. Try again.');
      setLeaving(null);
    }
  }

  const loading = membershipList.status === 'loading' || invitationList.status === 'loading' || offerList.status === 'loading';

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title="Memberships" />

      {error && (
        <p className="text-sm text-muted-foreground" role="alert">
          {error}
        </p>
      )}

      {notice && (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      {ownedNotice && (
        <p className="text-sm text-muted-foreground" role="status" data-testid="own-done">
          {ownedNotice}
        </p>
      )}

      {loading ? (
        <LoadingRows label="your memberships" rows={3} />
      ) : (
        <>
          {invitationList.status === 'error' && <LoadError label="your invitations" retry={() => void loadInvitations()} />}

          {offerList.status === 'error' && <LoadError label="the universes offered to you" retry={() => void loadOffers()} />}

          {offers.length > 0 && (
            <section className="grid min-w-0 gap-2" aria-labelledby="offers-heading" data-testid="ownership-offers">
              <SectionHeader id="offers-heading" title="Offered to you" count={offers.length} />
              <div className={GROUP}>
                {offers.map((offer) => {
                  const busy = answeringOffers.has(offer.id);
                  const from = offer.owner.name || 'The owner';
                  return (
                    <EntityRow
                      key={offer.id}
                      href={`/admin/universes/${offer.universe.id}`}
                      kind="universe"
                      leading={<UniverseGlyph size={32} className="mx-1 shrink-0" aria-hidden="true" />}
                      tone="waiting"
                      title={offer.universe.name}
                      titleAside={<StatusPill status="waiting" />}
                      context={
                        <span className="text-xs text-muted-foreground">
                          {from} offered you the whole universe · {offer.universe.worldCount === 1 ? '1 world' : `${offer.universe.worldCount} worlds`}
                        </span>
                      }
                      meta={
                        <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Crown size={13} className="text-[#FACC15]" aria-hidden="true" /> Owner
                        </span>
                      }
                      trailing={
                        // Declining asks first, as invitations do
                        confirmingOfferDecline === offer.id ? (
                          <>
                            <Button variant="outline" className="h-11 px-4" disabled={busy} onClick={() => setConfirmingOfferDecline(null)}>
                              Keep
                            </Button>
                            <Button variant="destructive" className="h-11 px-4" disabled={busy} onClick={() => void answerOffer(offer, 'decline')}>
                              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                              Decline
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              className="h-11 w-11 p-0"
                              aria-label={`Decline ownership of ${offer.universe.name}`}
                              disabled={busy}
                              onClick={() => setConfirmingOfferDecline(offer.id)}
                            >
                              <X size={16} aria-hidden="true" />
                            </Button>
                            <Button className="h-11 gap-1.5 px-4" disabled={busy} onClick={() => setAccepting(offer)}>
                              <Check size={15} aria-hidden="true" />
                              Accept
                            </Button>
                          </>
                        )
                      }
                    />
                  );
                })}
              </div>
            </section>
          )}

          {invitations.length > 0 && (
            <section className="grid min-w-0 gap-2" aria-labelledby="invitations-heading" data-testid="invitations">
              <SectionHeader id="invitations-heading" title="Invitations" count={invitations.length} />
              <div className="grid min-w-0 gap-0.5">
                {invitations.map((invitation) => {
                  const from = invitation.invitedBy?.name || invitation.invitedBy?.email;
                  const busy = pendingInvitations.has(invitation.id);
                  // A universe invitation shows the universe, the worlds and the roles it gives; an older one its world
                  const toUniverse = !!invitation.universeId;
                  const title = toUniverse ? invitation.world.universe.name : invitation.world.name;
                  const message = invitation.message ? (
                    <span className="text-xs italic text-muted-foreground [overflow-wrap:anywhere]">“{invitation.message}”</span>
                  ) : null;
                  return (
                    <EntityRow
                      key={invitation.id}
                      href={`/admin/invitations/${invitation.id}`}
                      kind={toUniverse ? 'universe' : 'world'}
                      leading={toUniverse ? <UniverseGlyph size={32} className="mx-1 shrink-0" aria-hidden="true" /> : undefined}
                      tone="waiting"
                      title={title}
                      titleAside={<StatusPill status="waiting" />}
                      context={
                        toUniverse ? (
                          <span className="text-xs text-muted-foreground">
                            {from ? `${from} invited you` : 'You’re invited'} · {invitedWorlds(invitation)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {from ? `${from} invited you` : 'You’re invited'}
                            {invitation.tags.length ? ` as ${invitation.tags.join(', ')}` : ''} · <Place kind="universe" label={invitation.world.universe.name} />
                          </span>
                        )
                      }
                      meta={
                        toUniverse ? (
                          <span className="grid min-w-0 gap-1">
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              {(invitation.roles ?? []).length === 0 && <RoleChip name="Member" color="#A78BFA" />}
                              {(invitation.roles ?? []).map((role) => (
                                <RoleChip key={role.id} name={role.name} color={role.color} />
                              ))}
                            </span>
                            {message}
                          </span>
                        ) : (
                          message ?? undefined
                        )
                      }
                      trailing={
                        // Declining asks first, as on You and the invitation page: it can't be undone.
                        confirmingDecline === invitation.id ? (
                          <>
                            <Button variant="outline" className="h-11 px-4" disabled={busy} onClick={() => setConfirmingDecline(null)}>
                              Keep
                            </Button>
                            <Button
                              variant="destructive"
                              className="h-11 px-4"
                              disabled={busy}
                              onClick={() => void handleRejectInvitation(invitation.id).finally(() => setConfirmingDecline(null))}
                            >
                              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                              Decline
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              className="h-11 w-11 p-0"
                              aria-label={`Decline the invitation to ${title}`}
                              disabled={busy}
                              onClick={() => setConfirmingDecline(invitation.id)}
                            >
                              <X size={16} aria-hidden="true" />
                            </Button>
                            <Button className="h-11 gap-1.5 px-4" disabled={busy} onClick={() => handleAcceptInvitation(invitation.id)}>
                              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                              Accept
                            </Button>
                          </>
                        )
                      }
                    />
                  );
                })}
              </div>
            </section>
          )}

          <section className="grid min-w-0 gap-6" aria-label="Your universes">
            {membershipList.status === 'error' ? (
              <LoadError label="your memberships" retry={() => void loadMemberships()} />
            ) : memberships.length === 0 ? (
              <EmptyCard
                kind="universe"
                title="No memberships yet."
                text="You become a member when someone invites you to their universe, or when you create one of your own."
                href="/admin/you"
                action="Go to You"
              />
            ) : (
              <>
                {joined.length > 0 && (
                  <div className="grid min-w-0" data-testid="joined-universes">
                    <SectionHeader id="joined-heading" title="Member of" count={joined.length} />
                    <div className={GROUP} aria-labelledby="joined-heading" role="list">
                      {joined.map((membership) => (
                        <div key={membership.universe.id} role="listitem" className="min-w-0">
                          <JoinedUniverseRow membership={membership} onLeave={() => setLeaving(membership)} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {owned.length > 0 && (
                  <div className="grid min-w-0" data-testid="owned-universes">
                    <SectionHeader id="owned-heading" title="You own" count={owned.length} />
                    <div className={GROUP} aria-labelledby="owned-heading" role="list">
                      {owned.map((membership) => (
                        <div key={membership.universe.id} role="listitem" className="min-w-0">
                          <OwnedUniverseRow membership={membership} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            {memberships.length > 0 && (
              <p className="text-sm text-muted-foreground">
                You join a universe once. Your roles work in all of its worlds, unless someone who manages it limits a role to some worlds.
              </p>
            )}
          </section>
        </>
      )}

      <FormSheet open={!!accepting} onOpenChange={(open) => !open && setAccepting(null)} title={`Own ${accepting?.universe.name ?? 'this universe'}?`}>
        {accepting && (
          <>
            <ul className="grid gap-2.5 text-sm text-muted-foreground" data-testid="own-accept">
              <li><strong className="text-foreground">The whole universe becomes yours:</strong> {whatMovesCount(accepting.universe.worldCount)}. A world or room can’t be owned on its own.</li>
              <li><strong className="text-foreground">You get every permission</strong> in {accepting.universe.name}, and Admin in every world so the game gives the same.</li>
              <li><strong className="text-foreground">{accepting.owner.name || 'The owner'} stays as Admin.</strong> You rank above them and can change that.</li>
              <li><strong className="text-foreground">Bots, AI keys and artifacts stay with their people.</strong> Bots on {accepting.owner.name || 'the owner'}’s key keep running while they’re Admin.</li>
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="h-11 px-5" onClick={() => setAccepting(null)}>
                Cancel
              </Button>
              <Button className="h-11 px-5" disabled={answeringOffers.has(accepting.id)} onClick={() => void answerOffer(accepting, 'accept')}>
                {answeringOffers.has(accepting.id) ? 'Accepting…' : `Own ${accepting.universe.name}`}
              </Button>
            </div>
          </>
        )}
      </FormSheet>

      <AlertDialog open={!!leaving} onOpenChange={(open) => !open && setLeaving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {leaving?.universe.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You lose every role there and access to its member-only rooms. Someone has to invite you again to come back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => leaving && handleLeave(leaving)}>
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

