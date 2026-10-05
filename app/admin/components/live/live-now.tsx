'use client';

import Link from 'next/link';
import { useContext, useMemo, useState } from 'react';
import { EyeOff } from 'lucide-react';
import type { LiveStatus, LivePlace, LiveView } from '@/lib/live-presence';
import { cn } from '@/lib/utils';
import { WorkAdventureContext } from '../../workadventure-context';
import { useLive } from '../../hooks/use-live';
import { Context, KindIcon, SectionHeader } from '../ds';
import { WokaAvatar } from '../profile-card';
import { DoorEnterIcon } from './door-enter-icon';
import styles from './live.module.css';

/**
 * Live now: the rooms with people in them right now, and who is where. Only places you could enter, only people who
 * share where they are. Left out entirely while the game can't say, rather than claiming nobody is online.
 */

const STATUS_LABEL: Record<LiveStatus, string> = { online: 'Online', busy: 'Busy', away: 'Away' };
const FACES = 4;
const EVERYWHERE = 'everywhere';

type Layout =
  /** Space: places beside People online on a wide screen, above them otherwise. */
  | 'space'
  /** Orbit home, wide: a column of its own beside Here and Recently visited. */
  | 'home-column'
  /** Orbit home, narrow: places only, under Here; nothing when nobody is around. */
  | 'home-inline'
  /** The Live now page: everything. */
  | 'all';

type Person = LiveView['people'][number];

/** Goes to a room: straight there inside the game, its page otherwise. */
function useVisit() {
  const wa = useContext(WorkAdventureContext);
  const ready = Boolean(wa?.isReady);
  return {
    ready,
    visit: (playPath: string) =>
      wa?.navigateToRoom(playPath).catch((error) => console.error('[Live] Could not go to the room:', error)),
  };
}

function Dot({ status }: { status: LiveStatus }) {
  return <i className={styles.dot} data-status={status} title={STATUS_LABEL[status]} aria-hidden="true" />;
}

function VisitButton({
  place,
  label,
  className,
}: {
  place: Pick<LivePlace, 'roomId' | 'name' | 'playPath'>;
  label: string;
  className: string;
}) {
  const { ready, visit } = useVisit();
  const children = (
    <>
      {className === styles.go && <DoorEnterIcon size={14} />}
      {label}
    </>
  );
  return ready ? (
    <button
      type="button"
      className={cn('orbit-press', className)}
      onClick={() => visit(place.playPath)}
      aria-label={`${label}: ${place.name}`}
    >
      {children}
    </button>
  ) : (
    <Link href={`/admin/rooms/${place.roomId}`} className={cn('orbit-press', className)} aria-label={`${label}: ${place.name}`}>
      {children}
    </Link>
  );
}

function PlaceCard({ place }: { place: LivePlace }) {
  const faces = place.people.slice(0, FACES);
  const more = place.count - faces.length;
  return (
    <article className={styles.place} data-here={place.here || undefined} data-testid="live-place">
      <div className={styles.placeTop}>
        <KindIcon kind="room" />
        <div className={styles.placeText}>
          <h3 className={styles.name}>{place.name}</h3>
          <div className={styles.ctx}>
            <Context parts={[{ label: place.universe.name }, { label: place.world.name }]} />
          </div>
        </div>
        <span className={styles.count}>
          <Dot status="online" />
          {place.count} here
        </span>
      </div>
      <div className={styles.placeBottom}>
        <span className={styles.stack}>
          {faces.map((person) => (
            <WokaAvatar key={person.uuid} layers={person.woka} name={person.name} size={34} />
          ))}
          {more > 0 && <span className={styles.more}>+{more}</span>}
        </span>
        {place.bots > 0 && (
          <span className={styles.bot}>
            {place.bots} bot{place.bots === 1 ? '' : 's'}
          </span>
        )}
        {place.here ? (
          <span className={styles.youHere}>You’re here</span>
        ) : (
          <VisitButton place={place} label="Visit" className={styles.action} />
        )}
      </div>
    </article>
  );
}

function PersonRow({ person, hereRoomId }: { person: Person; hereRoomId: string | null }) {
  const { place } = person;
  return (
    <li className={styles.person} data-testid="live-person">
      <WokaAvatar layers={person.woka} name={person.name} size={40} />
      <div className={styles.who}>
        <strong>
          <span>{person.name}</span>
          <Dot status={person.status} />
          <span className="sr-only">{STATUS_LABEL[person.status]}</span>
        </strong>
        <div className={styles.where}>
          {place.name} · {place.universe.name} › {place.world.name}
        </div>
      </div>
      {place.roomId === hereRoomId ? (
        <span className={styles.sameRoom}>Here</span>
      ) : (
        <VisitButton place={place} label="Go" className={styles.go} />
      )}
    </li>
  );
}

function Chips({
  universes,
  value,
  onChange,
}: {
  universes: { id: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.chips} role="group" aria-label="Show">
      <button type="button" className={styles.chip} aria-pressed={value === EVERYWHERE} onClick={() => onChange(EVERYWHERE)}>
        Everywhere
      </button>
      {universes.map((universe) => (
        <button
          key={universe.id}
          type="button"
          className={styles.chip}
          aria-pressed={value === universe.id}
          onClick={() => onChange(universe.id)}
        >
          {universe.name}
        </button>
      ))}
      {/* Lights up when friends arrive. */}
      <button type="button" className={styles.chip} disabled title="Coming with friends">
        Friends
      </button>
    </div>
  );
}

function Note() {
  return (
    <p className={styles.note}>
      <EyeOff size={13} aria-hidden="true" />
      <span>
        Only people who share where they are, in places you can enter.{' '}
        <Link href="/admin/you#live-settings">Hide where you are</Link>
      </span>
    </p>
  );
}

export function LiveNow({ layout }: { layout: Layout }) {
  const view = useLive();
  if (!view) return null;
  return <LiveNowView view={view} layout={layout} />;
}

/** The view itself, for a snapshot already in hand. */
export function LiveNowView({ view, layout }: { view: LiveView; layout: Layout }) {
  const here = view.places.find((place) => place.here) ?? null;
  const universes = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const place of view.places) if (!seen.has(place.universe.id)) seen.set(place.universe.id, place.universe);
    return [...seen.values()];
  }, [view.places]);
  // On Orbit home, the universe you're in comes first; everywhere else, everywhere.
  const [picked, setPicked] = useState<string | null>(null);
  const filter = picked ?? (layout.startsWith('home') && here ? here.universe.id : EVERYWHERE);
  const active = filter === EVERYWHERE || universes.some((universe) => universe.id === filter) ? filter : EVERYWHERE;

  const places = active === EVERYWHERE ? view.places : view.places.filter((place) => place.universe.id === active);
  const people = active === EVERYWHERE ? view.people : view.people.filter((person) => person.place.universe.id === active);
  const total = places.reduce((sum, place) => sum + place.count, 0);
  const hereRoomId = here?.roomId ?? null;
  const empty = view.places.length === 0;

  if (empty && layout === 'home-inline') return null;

  const limit = layout === 'all' ? Infinity : layout === 'home-inline' ? 5 : 4;
  const peopleLimit = layout === 'all' ? Infinity : layout === 'home-column' ? 3 : 4;
  const seeAll = layout === 'all' ? null : { href: '/admin/live', label: 'See all' };

  const placesSection = (
    <section className={styles.section} aria-labelledby={`live-${layout}-heading`} data-testid="live-now">
      <SectionHeader id={`live-${layout}-heading`} title="Live now" count={total} action={seeAll} />
      {!empty && <Chips universes={universes} value={active} onChange={setPicked} />}
      {empty ? (
        <p className={styles.empty}>Nobody is in a place you can enter right now. When people come in, they show up here.</p>
      ) : (
        <div
          className={layout === 'all' ? styles.placesGrid : layout === 'home-column' ? styles.places : styles.placesScroll}
          data-wide-grid={layout === 'space' || undefined}
        >
          {places.slice(0, limit).map((place) => (
            <PlaceCard key={place.roomId} place={place} />
          ))}
        </div>
      )}
    </section>
  );

  if (layout === 'home-inline') return placesSection;

  const peopleSection = empty ? null : (
    <section className={styles.section} aria-labelledby={`people-${layout}-heading`} data-testid="people-online">
      <SectionHeader
        id={`people-${layout}-heading`}
        title="People online"
        count={people.length}
        action={layout === 'all' ? null : { href: '/admin/live#people', label: 'See all' }}
      />
      {people.length === 0 ? (
        <p className={styles.empty}>Only guests and bots here right now.</p>
      ) : (
        <ul className={styles.people} id={layout === 'all' ? 'people' : undefined}>
          {people.slice(0, peopleLimit).map((person) => (
            <PersonRow key={person.uuid} person={person} hereRoomId={hereRoomId} />
          ))}
        </ul>
      )}
      <Note />
    </section>
  );

  if (layout === 'home-column') {
    return (
      <aside className={styles.column} aria-label="Live now">
        {placesSection}
        {peopleSection}
      </aside>
    );
  }
  return (
    <div className={layout === 'space' ? styles.split : 'grid gap-8'}>
      {placesSection}
      {peopleSection}
    </div>
  );
}
