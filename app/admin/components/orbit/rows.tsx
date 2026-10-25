'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Check, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';
import type { LiveView } from '@/lib/live-presence';
import { useAdminBootstrap } from '../../admin-bootstrap-context';
import { isNamed, isRecord, useCollection } from '../../hooks/use-collection';
import { EmptyCard, LoadError, NameGlyph, Place, StatLine, StatusPill, hueStyle } from '../ds';
import { month, worldsIn, type UniverseMembership } from '../membership-rows';
import { RoleChip } from '../universe-people';
import { UniverseCard, type MyUniverse } from '../yours';
import { ScrollSection } from './scroll-row';
import styles from './rows.module.css';

/** Your universes shown on Orbit before the "All N universes" card. */
const UNIVERSES_SHOWN = 24;
/** Read to pick the busiest from: more than are shown, so an older universe with people in it still makes the row. */
const UNIVERSES_READ = 100;

/**
 * People in each room right now, as Live now counts them (bots apart, never counted; only rooms you can enter), and
 * the rooms you're in. You are left out, so a count is always the people you would find there. Someone in two rooms of
 * one universe at once (two tabs) counts once for the universe.
 */
function peopleNow(live: LiveView | null | undefined) {
  const rooms = new Map<string, number>();
  const listed = new Map<string, Set<string>>();
  const unnamed = new Map<string, number>();
  const hereRooms = new Set<string>();
  for (const place of live?.places ?? []) {
    if (place.here) hereRooms.add(place.roomId);
    rooms.set(place.roomId, place.count - (place.here ? 1 : 0));
    const id = place.universe.id;
    const uuids = listed.get(id) ?? new Set<string>();
    for (const person of place.people) if (!person.you) uuids.add(person.uuid);
    listed.set(id, uuids);
    // Guests have no name to tell them apart, so each one counts.
    unnamed.set(id, (unnamed.get(id) ?? 0) + place.guests);
  }
  const universes = new Map([...listed].map(([id, uuids]) => [id, uuids.size + (unnamed.get(id) ?? 0)]));
  return { rooms, universes, hereRooms };
}

/** Busiest first, so you can join people faster; places with nobody keep their own order after them. */
function busiestFirst<T>(items: T[], people: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, people: people(item) }))
    .sort((a, b) => b.people - a.people || a.index - b.index)
    .map((entry) => entry.item);
}

/** "3 here", with Live now's green dot. Nothing when nobody is there. */
export function PeopleHere({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className={styles.peopleHere}>
      <i aria-hidden="true" />
      {count} here
    </span>
  );
}

interface StarredRoom {
  id: string;
  name: string;
  world: { name: string; universe: { id?: string; name: string } };
}

const isStar = (value: unknown): value is StarredRoom =>
  isNamed(value) && isRecord(value.world) && typeof value.world.name === 'string' && isRecord(value.world.universe);

/** The rooms you starred, busiest first, each with who is there now (or that you are). */
export function StarsRow({ live }: { live?: LiveView | null }) {
  const { result, retry } = useCollection('/api/admin/stars/rooms', 'rooms', isStar);
  const { rooms, hereRooms } = peopleNow(live);
  const items = result.status === 'ready' ? busiestFirst(result.items, (room) => rooms.get(room.id) ?? 0) : null;
  return (
    <ScrollSection
      id="stars-heading"
      title="Your stars"
      count={items?.length}
      label="your stars"
      action={items && items.length > 0 ? { href: '/admin/stars', label: 'View all' } : null}
      testId="orbit-stars"
      empty={
        result.status === 'error' ? (
          <LoadError label="your starred rooms" retry={retry} />
        ) : items && items.length === 0 ? (
          <EmptyCard
            kind="star"
            title="Keep a way back to rooms you like."
            text="Star a room from its page and it shows up here, one tap from a visit."
            href="/admin/discover/rooms"
            action="Find rooms"
            testId="empty-stars"
          />
        ) : undefined
      }
    >
      {items === null
        ? [0, 1].map((key) => <div key={key} className={`${styles.card} ${styles.loading}`} aria-hidden="true" />)
        : items.map((room) => (
            <Link key={room.id} href={`/admin/rooms/${room.id}`} className={`${styles.card} orbit-kind-wash`} data-kind="star">
              <span className={styles.top}>
                <NameGlyph kind="star" size={20} />
                {hereRooms.has(room.id) ? <span className={styles.youHere}>You’re here</span> : <PeopleHere count={rooms.get(room.id) ?? 0} />}
              </span>
              <strong className={styles.name}>{room.name}</strong>
              <span className={styles.lines}>
                <Place kind="universe" label={room.world.universe.name} />
                <Place kind="world" label={room.world.name} />
              </span>
            </Link>
          ))}
    </ScrollSection>
  );
}

const isUniverse = (value: unknown): value is MyUniverse => isNamed(value) && typeof value.isPublic === 'boolean';

/** The universes you own, as the same planet cards You had, busiest first. Past 24, a card opens the whole list. */
export function UniversesRow({ live }: { live?: LiveView | null }) {
  const { mine } = useAdminBootstrap();
  const { result, retry } = useCollection(`/api/admin/universes?scope=my&limit=${UNIVERSES_READ}`, 'universes', isUniverse);
  const { universes } = peopleNow(live);
  const items =
    result.status === 'ready' ? busiestFirst(result.items, (universe) => universes.get(universe.id) ?? 0).slice(0, UNIVERSES_SHOWN) : null;
  const total = Math.max(mine?.universes ?? 0, result.status === 'ready' ? result.items.length : 0);
  return (
    <ScrollSection
      id="universes-heading"
      title="Your universes"
      count={total}
      label="your universes"
      action={items && items.length > 0 ? { href: '/admin/universes/new', label: 'New universe', icon: Plus } : null}
      testId="orbit-universes"
      empty={
        result.status === 'error' ? (
          <LoadError label="your universes" retry={retry} />
        ) : items && items.length === 0 ? (
          <EmptyCard
            kind="universe"
            title="Every universe starts with an idea."
            text="A universe holds your worlds, and worlds hold rooms. It takes a minute, and you can shape it later."
            href="/admin/universes/new"
            action="Create your universe"
            testId="empty-universes"
          />
        ) : undefined
      }
    >
      {items === null
        ? [0, 1].map((key) => <div key={key} className={`${styles.universe} ${styles.loading}`} aria-hidden="true" />)
        : items.map((universe) => (
            <div key={universe.id} className={styles.universe}>
              <UniverseCard universe={universe} people={universes.get(universe.id) ?? 0} />
            </div>
          ))}
      {items && total > items.length && (
        <Link href="/admin/universes" className={styles.all}>
          All {total} universes
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      )}
    </ScrollSection>
  );
}

interface Invitation {
  id: string;
  tags?: string[];
  world: { id: string; name: string; universe: { id?: string; name: string } };
  invitedBy?: { name: string | null; email: string | null } | null;
}

const isMembership = (value: unknown): value is UniverseMembership =>
  isRecord(value) && isNamed(value.universe) && typeof value.isOwner === 'boolean' && Array.isArray(value.roles);
const isInvitation = (value: unknown): value is Invitation =>
  isRecord(value) && typeof value.id === 'string' && isNamed(value.world) && isRecord(value.world.universe);

/**
 * The universes you joined (the ones you own are under Your universes), busiest first, with any invitation waiting
 * to be answered first: accepting makes you a member at once; declining asks first. Each invitation opens its own
 * page when you want more before deciding.
 */
export function MembershipsRow({ live }: { live?: LiveView | null }) {
  const memberships = useCollection('/api/memberships/my/universes', 'universes', isMembership);
  const invitations = useCollection('/api/memberships/invitations', 'invitations', isInvitation);
  const { universes } = peopleNow(live);
  // One lock per invitation, so answering one never unlocks or blocks another.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDecline, setConfirmingDecline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const joining = useRef<{ ids: string[]; after: unknown }>({ ids: [], after: null });

  const joined =
    memberships.result.status === 'ready'
      ? busiestFirst(
          memberships.result.items.filter((membership) => !membership.isOwner),
          (membership) => universes.get(membership.universe.id) ?? 0,
        )
      : null;
  const waiting = invitations.result.status === 'ready' ? invitations.result.items : [];
  // Invitations still show (and can be answered) when your memberships can't be read.
  const failed = memberships.result.status === 'error';

  async function answer(invitation: Invitation, choice: 'accept' | 'reject') {
    if (pending.has(invitation.id)) return;
    setPending((current) => new Set(current).add(invitation.id));
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/memberships/invitations/${invitation.id}/${choice}`, { method: 'POST' });
      if (!response.ok) throw new Error('answer failed');
      if (choice === 'accept') {
        // The invitation stays (locked) until the new membership has loaded, so the row never reads empty between.
        joining.current = { ids: [...joining.current.ids, invitation.id], after: memberships.result };
        memberships.retry();
        return;
      }
      invitations.update((items) => items.filter((item) => item.id !== invitation.id));
    } catch {
      setError(`Couldn’t ${choice === 'accept' ? 'accept' : 'decline'} the invitation to ${invitation.world.name}. Try again.`);
    } finally {
      setConfirmingDecline((current) => (current === invitation.id ? null : current));
    }
    unlock([invitation.id]);
  }

  function unlock(ids: string[]) {
    setPending((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  // Your memberships answered again after accepting: the accepted invitations make way for the memberships.
  useEffect(() => {
    const { ids, after } = joining.current;
    if (ids.length === 0 || memberships.result === after) return;
    joining.current = { ids: [], after: null };
    invitations.update((items) => items.filter((item) => !ids.includes(item.id)));
    unlock(ids);
  }, [memberships.result, invitations]);

  return (
    <>
      <ScrollSection
        id="memberships-heading"
        title="Your memberships"
        count={joined?.length}
        label="your memberships"
        action={joined && joined.length > 0 ? { href: '/admin/memberships', label: 'Manage' } : null}
        testId="orbit-memberships"
        empty={
          failed && waiting.length === 0 ? (
            <LoadError label="your memberships" retry={memberships.retry} />
          ) : joined && joined.length === 0 && waiting.length === 0 && invitations.result.status !== 'loading' ? (
            <EmptyCard kind="universe" title="No memberships yet." text="When someone invites you to their universe, it shows up here." testId="empty-memberships" />
          ) : undefined
        }
      >
        {waiting.map((invitation) => {
          const from = invitation.invitedBy?.name || invitation.invitedBy?.email;
          const busy = pending.has(invitation.id);
          return (
            <div key={invitation.id} className={`${styles.card} ${styles.member} ${styles.waiting}`} data-testid="invitation">
              <span className={styles.top}>
                <NameGlyph kind="world" size={20} />
                <StatusPill status="waiting" />
              </span>
              <Link href={`/admin/invitations/${invitation.id}`} className={`${styles.name} ${styles.cover}`}>
                {invitation.world.name}
              </Link>
              <span className={styles.lines}>
                <span>
                  {from ? `${from} invited you` : 'You’re invited'}
                  {invitation.tags?.length ? ` as ${invitation.tags.join(', ')}` : ''}
                </span>
                <Place kind="universe" label={invitation.world.universe.name} />
              </span>
              <span className={styles.answer}>
                {confirmingDecline === invitation.id ? (
                  <>
                    <Button variant="outline" className="h-11 flex-1 px-4" disabled={busy} onClick={() => setConfirmingDecline(null)}>
                      Keep
                    </Button>
                    <Button variant="destructive" className="h-11 flex-1 px-4" disabled={busy} onClick={() => void answer(invitation, 'reject')}>
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
                    <Button className="h-11 flex-1 gap-1.5 px-4" disabled={busy} onClick={() => void answer(invitation, 'accept')}>
                      <Check size={15} aria-hidden="true" />
                      Accept
                    </Button>
                  </>
                )}
              </span>
            </div>
          );
        })}
        {failed ? (
          <div className={`${styles.card} ${styles.member}`}>
            <LoadError label="your memberships" retry={memberships.retry} />
          </div>
        ) : joined === null ? (
          <div className={`${styles.card} ${styles.member} ${styles.loading}`} aria-hidden="true" />
        ) : (
          joined.map((membership) => {
            const where = worldsIn(membership);
            return (
              <Link
                key={membership.universe.id}
                href={`/admin/universes/${membership.universe.id}`}
                className={`${styles.card} ${styles.member} orbit-kind-wash`}
                data-kind="universe"
                style={hueStyle(membership.universe.id) as CSSProperties}
              >
                <span className={styles.top}>
                  <NameGlyph kind="universe" size={20} />
                  <PeopleHere count={universes.get(membership.universe.id) ?? 0} />
                  <span className={styles.roles}>
                    {membership.roles.length === 0 ? (
                      <RoleChip name="Member" color="#A78BFA" />
                    ) : (
                      membership.roles.map((role) => <RoleChip key={role.key} name={role.name} color={role.color} />)
                    )}
                  </span>
                </span>
                <strong className={styles.name}>{membership.universe.name}</strong>
                <span className={styles.lines}>
                  <StatLine items={[where && <Place key="worlds" kind="world" label={where} />, `Joined ${month(membership.joinedAt)}`]} />
                </span>
              </Link>
            );
          })
        )}
      </ScrollSection>
      {invitations.result.status === 'error' && <LoadError label="your invitations" retry={invitations.retry} />}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </>
  );
}
