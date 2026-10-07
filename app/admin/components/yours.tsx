'use client';

import Link from 'next/link';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight, Check, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';
import { universeColour } from '@/lib/universe-colour';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { isNamed, isRecord, useCollection, type Collection } from '../hooks/use-collection';
import { useGuidanceDismissed } from '../hooks/use-guidance-dismissed';
import {
  EmptyCard,
  EntityRow,
  KindIcon,
  LoadError,
  LoadingRows,
  RolePills,
  SectionHeader,
  StatLine,
  StatusPill,
  count,
  hueStyle,
} from './ds';
import styles from './yours.module.css';

interface MyUniverse {
  id: string;
  name: string;
  description?: string | null;
  isPublic: boolean;
  featured?: boolean;
  _count?: { worlds?: number; rooms?: number };
}
interface MyMembership {
  id: string;
  tags: string[];
  isUniverseOwner?: boolean;
  world: { id: string; name: string; universe: { id?: string; name: string }; _count?: { rooms?: number; members?: number } };
}
interface Invitation {
  id: string;
  tags?: string[];
  world: { id: string; name: string; universe: { id?: string; name: string } };
  invitedBy?: { name: string | null; email: string | null } | null;
}
interface StarredRoom {
  id: string;
  name: string;
  world: { name: string; universe: { id?: string; name: string } };
}

const SHOWN = 4;

const isUniverse = (value: unknown): value is MyUniverse => isNamed(value) && typeof value.isPublic === 'boolean';
const isMembership = (value: unknown): value is MyMembership =>
  isRecord(value) && typeof value.id === 'string' && Array.isArray(value.tags) && isNamed(value.world) && isRecord(value.world.universe);
const isInvitation = (value: unknown): value is Invitation =>
  isRecord(value) && typeof value.id === 'string' && isNamed(value.world) && isRecord(value.world.universe);
const isStar = (value: unknown): value is StarredRoom =>
  isNamed(value) && isRecord(value.world) && typeof value.world.name === 'string' && isRecord(value.world.universe);

function List<T>({ collection, label, empty, children }: { collection: { result: Collection<T>; retry: () => void }; label: string; empty: ReactNode; children: (items: T[]) => ReactNode }) {
  const { result, retry } = collection;
  if (result.status === 'loading') return <LoadingRows label={label} />;
  if (result.status === 'error') return <LoadError label={label} retry={retry} />;
  return <>{result.items.length ? children(result.items) : empty}</>;
}

/**
 * What's yours, on You: a first-steps guide for someone new, your universes, the worlds you're a member of (with any
 * invitation to answer right here), and the rooms you starred. Finding new places is Space's job, not this page's.
 */
export default function Yours({ profileComplete }: { profileComplete: boolean | null }) {
  const { mine } = useAdminBootstrap();
  const universes = useCollection(`/api/admin/universes?scope=my&limit=${SHOWN}`, 'universes', isUniverse);
  const memberships = useCollection('/api/memberships/my', 'memberships', isMembership);
  const invitations = useCollection('/api/memberships/invitations', 'invitations', isInvitation);
  const stars = useCollection('/api/admin/stars/rooms', 'rooms', isStar);

  const ownsUniverse = universes.result.status === 'ready' ? universes.result.items.length > 0 : (mine?.universes ?? 0) > 0;
  const hasWorld = memberships.result.status === 'ready' ? memberships.result.items.length > 0 : (mine?.worlds ?? 0) > 0;
  const hasStar = stars.result.status === 'ready' ? stars.result.items.length > 0 : (mine?.stars ?? 0) > 0;
  const universeTotal = mine?.universes ?? (universes.result.status === 'ready' ? universes.result.items.length : 0);
  // A world you run (you own its universe, or you're its admin): where "Invite someone" leads.
  const runWorld =
    memberships.result.status === 'ready'
      ? memberships.result.items.find((membership) => membership.isUniverseOwner || membership.tags.includes('admin'))
      : undefined;
  const ownsWorld = (mine?.ownedWorlds ?? 0) > 0 || Boolean(runWorld?.isUniverseOwner);
  const sentInvitation = (mine?.invitationsSent ?? 0) > 0;
  // With one universe, "Create a world" goes straight to it; with several, the form asks which.
  const onlyUniverse =
    universes.result.status === 'ready' && universes.result.items.length === 1 && (mine?.universes ?? 1) === 1
      ? universes.result.items[0]
      : null;
  const newWorldHref = onlyUniverse ? `/admin/worlds/new?universeId=${encodeURIComponent(onlyUniverse.id)}` : '/admin/worlds/new';
  const [hidden, hide] = useGuidanceDismissed('getStarted');
  const allDone = profileComplete === true && ownsUniverse && ownsWorld && sentInvitation && hasStar;

  return (
    <div className={styles.yours} data-testid="yours">
      {!allDone && hidden === false && (
        <GetStarted
          profileComplete={profileComplete}
          ownsUniverse={ownsUniverse}
          ownsWorld={ownsWorld}
          sentInvitation={sentInvitation}
          hasStar={hasStar}
          inviteHref={runWorld ? `/admin/worlds/${runWorld.world.id}?tab=members` : null}
          newWorldHref={newWorldHref}
          onHide={hide}
        />
      )}

      <section aria-labelledby="universes-heading">
        <SectionHeader
          id="universes-heading"
          title="Your universes"
          count={universeTotal}
          action={ownsUniverse ? { href: '/admin/universes/new', label: 'New universe', icon: Plus } : null}
        />
        <List
          collection={universes}
          label="your universes"
          empty={
            <EmptyCard
              kind="universe"
              title="Every universe starts with an idea."
              text="A universe holds your worlds, and worlds hold rooms. It takes a minute, and you can shape it later."
              href="/admin/universes/new"
              action="Create your universe"
              testId="empty-universes"
            />
          }
        >
          {(items) => (
            <>
              <div className={styles.universes}>
                {items.slice(0, SHOWN).map((universe) => (
                  <UniverseCard key={universe.id} universe={universe} />
                ))}
              </div>
              {universeTotal > SHOWN && (
                <Link href="/admin/universes" className={styles.more}>
                  All {universeTotal} universes
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              )}
            </>
          )}
        </List>
      </section>

      <section aria-labelledby="memberships-heading">
        <SectionHeader
          id="memberships-heading"
          title="Memberships"
          count={memberships.result.status === 'ready' ? memberships.result.items.length : undefined}
          action={hasWorld ? { href: '/admin/memberships', label: 'Manage' } : null}
        />
        <Invitations collection={invitations} onAccepted={memberships.retry} />
        <List
          collection={memberships}
          label="your memberships"
          empty={
            <EmptyCard
              kind="world"
              title="No memberships yet."
              text={
                ownsUniverse
                  ? 'Create a world in your universe and you’re its admin. Then invite people as members, editors or admins.'
                  : 'You become a member when someone invites you to their world, or when you create a world of your own.'
              }
              href={ownsUniverse ? newWorldHref : '/admin/universes/new?next=world'}
              action={ownsUniverse ? 'Create a world' : 'Create a universe first'}
              testId="empty-memberships"
            />
          }
        >
          {(items) => (
            <div className={styles.rows}>
              {items.slice(0, SHOWN).map((membership) => (
                <EntityRow
                  key={membership.id}
                  href={`/admin/worlds/${membership.world.id}`}
                  kind="world"
                  title={membership.world.name}
                  context={
                    <StatLine
                      items={[
                        membership.world.universe.name,
                        count(membership.world._count?.rooms, 'room'),
                        count(membership.world._count?.members, 'member'),
                      ]}
                    />
                  }
                  titleAside={<RolePills roles={[...(membership.isUniverseOwner ? ['owner'] : []), ...membership.tags]} />}
                />
              ))}
            </div>
          )}
        </List>
      </section>

      <section aria-labelledby="stars-heading">
        <SectionHeader
          id="stars-heading"
          title="Stars"
          count={stars.result.status === 'ready' ? stars.result.items.length : undefined}
          action={hasStar ? { href: '/admin/stars', label: 'View all' } : null}
        />
        <List
          collection={stars}
          label="your starred rooms"
          empty={
            <EmptyCard
              kind="star"
              title="Keep a way back to rooms you like."
              text="Star a room from its page and it shows up here, one tap from a visit."
              href="/admin/discover/rooms"
              action="Find rooms"
              testId="empty-stars"
            />
          }
        >
          {(items) => (
            <div className={styles.rows}>
              {items.slice(0, SHOWN).map((room) => (
                <EntityRow
                  key={room.id}
                  href={`/admin/rooms/${room.id}`}
                  kind="star"
                  title={room.name}
                  context={<StatLine items={[`${room.world.universe.name} › ${room.world.name}`]} />}
                />
              ))}
            </div>
          )}
        </List>
      </section>
    </div>
  );
}

/** A universe as a planet in its own colour. The whole card opens it. */
function UniverseCard({ universe }: { universe: MyUniverse }) {
  return (
    <Link
      href={`/admin/universes/${universe.id}`}
      className={`${styles.universe} orbit-kind-wash`}
      data-kind="universe"
      style={{ ...hueStyle(universe.id), '--planet-color': universeColour(universe.id) } as CSSProperties}
    >
      <div className={styles.celestial} aria-hidden="true">
        <span className={styles.orbitRing} />
        <span className={styles.planet} />
        <span className={styles.moon} />
      </div>
      <div className={styles.universeTop}>
        <KindIcon kind="universe" universeId={universe.id} />
        <span className={styles.universePills}>
          <StatusPill status={universe.isPublic ? 'public' : 'private'} />
          {universe.featured && <StatusPill status="featured" />}
        </span>
      </div>
      <div className={styles.universeBottom}>
        <div>
          <h3 className="orbit-display">{universe.name}</h3>
          {universe.description && <p>{universe.description}</p>}
          <StatLine items={[count(universe._count?.worlds, 'world'), count(universe._count?.rooms, 'room')]} />
        </div>
        <ArrowUpRight className={styles.cardArrow} size={22} aria-hidden="true" />
      </div>
    </Link>
  );
}

/**
 * Invitations to answer, right here: accepting makes you a member at once; declining asks first. Each invitation
 * opens its own page, with who invited you, the world and the role, when you want more before deciding.
 */
function Invitations({
  collection,
  onAccepted,
}: {
  collection: { result: Collection<Invitation>; retry: () => void; update: (change: (items: Invitation[]) => Invitation[]) => void };
  onAccepted: () => void;
}) {
  // One lock per invitation, so answering one never unlocks or blocks another.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDecline, setConfirmingDecline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (collection.result.status === 'error') return <LoadError label="your invitations" retry={collection.retry} />;
  if (collection.result.status !== 'ready' || collection.result.items.length === 0) return null;

  async function answer(invitation: Invitation, choice: 'accept' | 'reject') {
    if (pending.has(invitation.id)) return;
    setPending((current) => new Set(current).add(invitation.id));
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/memberships/invitations/${invitation.id}/${choice}`, { method: 'POST' });
      if (!response.ok) throw new Error('answer failed');
      collection.update((items) => items.filter((item) => item.id !== invitation.id));
      if (choice === 'accept') onAccepted();
    } catch {
      setError(`Couldn’t ${choice === 'accept' ? 'accept' : 'decline'} the invitation to ${invitation.world.name}. Try again.`);
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(invitation.id);
        return next;
      });
      setConfirmingDecline((current) => (current === invitation.id ? null : current));
    }
  }

  return (
    <div className={styles.invitations} data-testid="invitations">
      {collection.result.items.map((invitation) => {
        const from = invitation.invitedBy?.name || invitation.invitedBy?.email;
        const busy = pending.has(invitation.id);
        const confirming = confirmingDecline === invitation.id;
        return (
          <EntityRow
            key={invitation.id}
            href={`/admin/invitations/${invitation.id}`}
            kind="world"
            tone="waiting"
            title={invitation.world.name}
            context={
              <span className={styles.invitationLine}>
                <StatusPill status="waiting" />
                {from ? `${from} invited you` : 'You’re invited'}
                {invitation.tags?.length ? ` as ${invitation.tags.join(', ')}` : ''} · {invitation.world.universe.name}
              </span>
            }
            trailing={
              confirming ? (
                <>
                  <Button variant="outline" className="h-11 px-4" disabled={busy} onClick={() => setConfirmingDecline(null)}>
                    Keep
                  </Button>
                  <Button variant="destructive" className="h-11 px-4" disabled={busy} onClick={() => void answer(invitation, 'reject')}>
                    Decline
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    className="h-11 w-11 p-0"
                    aria-label={`Decline the invitation to ${invitation.world.name}`}
                    disabled={busy}
                    onClick={() => setConfirmingDecline(invitation.id)}
                  >
                    <X size={16} aria-hidden="true" />
                  </Button>
                  <Button className="h-11 gap-1.5 px-4" disabled={busy} onClick={() => void answer(invitation, 'accept')}>
                    <Check size={15} aria-hidden="true" />
                    Accept
                  </Button>
                </>
              )
            }
          />
        );
      })}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * For someone new: five steps, each one tap, each ticked by the real thing (your profile, a universe you own, a world
 * in it, an invitation you sent, a star), never by just being a member of someone else's world. It stays until every
 * step is done or you hide it.
 */
function GetStarted({
  profileComplete,
  ownsUniverse,
  ownsWorld,
  sentInvitation,
  hasStar,
  inviteHref,
  newWorldHref,
  onHide,
}: {
  profileComplete: boolean | null;
  ownsUniverse: boolean;
  ownsWorld: boolean;
  sentInvitation: boolean;
  hasStar: boolean;
  /** Where to invite people: the members of a world you run, when there is one. */
  inviteHref: string | null;
  /** Where "Create a world" leads: straight to your universe when you have one. */
  newWorldHref: string;
  onHide: () => void;
}) {
  const steps = [
    { done: profileComplete === true, title: 'Set up your profile', text: 'A few words and your links, so people know who they’re meeting.', href: '/admin/you?edit=profile' },
    { done: ownsUniverse, title: 'Create your universe', text: 'Your own corner of the Universe, to hold your worlds.', href: '/admin/universes/new?next=world' },
    {
      done: ownsWorld,
      title: 'Create a world',
      text: ownsUniverse ? 'A world in your universe. You’re its admin.' : 'After your universe.',
      href: ownsUniverse ? newWorldHref : undefined,
    },
    {
      done: sentInvitation,
      title: 'Invite someone',
      text: inviteHref ? 'As a member, editor or admin of your world.' : 'After your world.',
      href: inviteHref ?? undefined,
    },
    { done: hasStar, title: 'Star a room you like', text: 'Keep a way back to it, one tap from a visit.', href: '/admin/discover/rooms' },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  return (
    <section className={styles.getStarted} aria-labelledby="get-started-heading" data-testid="get-started">
      <div className={styles.getStartedHead}>
        <h2 id="get-started-heading" className="orbit-display">
          Get started
        </h2>
        <span>
          {doneCount} of {steps.length}
          <button type="button" className={styles.hide} onClick={onHide}>
            Hide
          </button>
        </span>
      </div>
      <div className={styles.progress} aria-hidden="true">
        <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <ol className={styles.steps}>
        {steps.map((step, index) => {
          const body = (
            <>
              <span className={styles.stepMark} data-done={step.done || undefined} aria-hidden="true">
                {step.done ? <Check size={14} /> : index + 1}
              </span>
              <span className={styles.stepText}>
                <strong>{step.title}</strong>
                <span>{step.text}</span>
              </span>
              {step.href && !step.done && <ArrowUpRight className={styles.stepArrow} size={16} aria-hidden="true" />}
            </>
          );
          return (
            <li key={step.title} data-done={step.done || undefined}>
              {step.href && !step.done ? (
                <Link href={step.href} className={styles.step}>
                  {body}
                  <span className="sr-only">{step.done ? '(done)' : ''}</span>
                </Link>
              ) : (
                <div className={styles.step} aria-disabled={!step.done && !step.href ? true : undefined}>
                  {body}
                  {step.done && <span className="sr-only">(done)</span>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
