'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { DoorOpen, Navigation, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/time-ago';
import { formatHour, useRoomAnalytics, wasLastVisitorYou } from '../hooks/use-room-analytics';
import { useWorkAdventure } from '../workadventure-context';
import styles from './room-card.module.css';

export interface RoomCardRoom {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  favorites?: number;
  world: { id?: string; name: string; slug: string };
  universe: { id?: string; name: string; slug: string };
  /** When you were there, for a room on your trail. */
  accessedAt?: string;
}

type Kind = 'here' | 'previous' | 'trail';

/** A place in your orbit: a decoration, never a picture of activity. */
export function OrbitalIllustration({ small = false }: { small?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={small ? styles.smallOrbit : styles.orbit} viewBox="0 0 280 200" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`moon-${id}`} cx="0.27" cy="0.22" r="0.8">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="0.3" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="0.7" stopColor="currentColor" stopOpacity="0.12" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.02" />
        </radialGradient>
      </defs>
      <circle cx="147" cy="93" r="65" stroke="currentColor" strokeOpacity="0.16" strokeWidth="0.7" />
      <circle cx="147" cy="93" r="45" fill={`url(#moon-${id})`} stroke="currentColor" strokeOpacity="0.35" />
      <path d="M116 60c30-12 58 15 59 45M108 80c26-9 43 7 44 33M131 53c9 18 13 44 4 73" stroke="currentColor" strokeOpacity="0.2" strokeWidth="0.6" />
      <ellipse cx="147" cy="93" rx="114" ry="36" transform="rotate(-26 147 93)" stroke="currentColor" strokeOpacity="0.5" strokeWidth="0.8" />
      <ellipse cx="147" cy="93" rx="133" ry="51" transform="rotate(-26 147 93)" stroke="currentColor" strokeOpacity="0.13" strokeWidth="0.6" />
      <circle cx="50" cy="126" r="4" fill="var(--brand-gold)" />
      <circle cx="235" cy="49" r="2" fill="currentColor" fillOpacity="0.5" />
      <path d="M45 55h8m-4-4v8M226 144h6m-3-3v6" stroke="currentColor" strokeOpacity="0.45" strokeWidth="0.8" />
    </svg>
  );
}

function VisitTime({ value }: { value: string }) {
  const date = new Date(value);
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {timeAgo(date)}
    </time>
  );
}

const EYEBROW: Record<Kind, string> = { here: 'You are here', previous: 'Before this', trail: 'On your trail' };

/**
 * A room at a glance: where it is, what it is, how popular it is and who was there last, the same on every card.
 * The whole card opens the room's page; Visit takes you there in the game (not on the room you are already in).
 */
export function RoomCard({ room, kind, index }: { room: RoomCardRoom; kind: Kind; index?: number }) {
  const { analytics, loading, failed, retry } = useRoomAnalytics(room.id);
  const { isReady, navigateToRoom } = useWorkAdventure();
  const [visiting, setVisiting] = useState(false);
  const [visitError, setVisitError] = useState(false);
  const titleId = useId();
  const here = kind === 'here';

  async function visit() {
    setVisiting(true);
    setVisitError(false);
    try {
      const slugs = [room.universe.slug, room.world.slug, room.slug].map(encodeURIComponent).join('/');
      await navigateToRoom(`/@/${slugs}`);
    } catch (cause) {
      console.error('[RoomCard] Could not visit', cause);
      setVisitError(true);
    } finally {
      setVisiting(false);
    }
  }

  const you = analytics?.lastVisitedByUser?.accessedAt ?? room.accessedAt ?? null;
  const latest = analytics?.lastVisitedOverall ?? null;
  const variant = here ? styles.current : kind === 'previous' ? styles.previous : styles.recent;

  return (
    <article className={cn(styles.card, variant, 'orbit-kind-wash')} data-kind="room" aria-labelledby={titleId} data-testid={`room-card-${kind}`}>
      {here && <OrbitalIllustration />}
      <div className={styles.cardTop}>
        <span className={styles.eyebrow}>
          {here && <i className={styles.presence} />}
          {EYEBROW[kind]}
        </span>
        {kind === 'trail' && index !== undefined && (
          <span className={styles.ordinal} aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
        )}
        <span className={styles.stars} aria-label={`${room.favorites ?? 0} ${room.favorites === 1 ? 'star' : 'stars'}`}>
          <Star size={13} aria-hidden="true" />
          {(room.favorites ?? 0).toLocaleString()}
        </span>
      </div>

      <div className={styles.place}>
        <div className={styles.placeWords}>
          <p className={styles.coordinates}>
            <span>{room.universe.name}</span>
            <span aria-hidden="true">/</span>
            <span>{room.world.name}</span>
          </p>
          <div className={styles.nameRow}>
            <span className="orbit-kind" data-kind="room" aria-hidden="true">
              <DoorOpen size={18} />
            </span>
            <h3 id={titleId} className={styles.roomName}>
              {/* The whole card opens the room's page. */}
              <Link href={`/admin/rooms/${room.id}`} className={styles.cardLink}>
                {room.name}
              </Link>
            </h3>
          </div>
          {room.description && <p className={styles.description}>{room.description}</p>}
        </div>
      </div>

      <div className={styles.activity}>
        {loading && (
          <p className={styles.activityStatus} role="status">
            Reading room activity…
          </p>
        )}
        {failed && (
          <p className={styles.activityStatus}>
            Activity is unavailable.{' '}
            <button type="button" className={styles.retry} onClick={retry}>
              Try again
            </button>
          </p>
        )}
        {analytics && (
          <dl className={styles.metrics}>
            <div>
              <dt>Accesses</dt>
              <dd>{analytics.totalAccesses === null ? '—' : analytics.totalAccesses.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Peak</dt>
              <dd>{analytics.peakHour === null ? '—' : formatHour(analytics.peakHour)}</dd>
            </div>
          </dl>
        )}
        {(you || analytics) && (
          <div className={styles.visitHistory}>
            <p>
              <span>Last visited by you</span>
              <strong>{you ? <VisitTime value={you} /> : 'Never'}</strong>
            </p>
            {analytics &&
              (latest ? (
                wasLastVisitorYou(analytics) ? (
                  <p className={styles.noVisits}>You were the last visitor</p>
                ) : (
                  <p>
                    <span>Most recent visitor</span>
                    <strong>
                      <VisitTime value={latest.accessedAt} />
                    </strong>
                  </p>
                )
              ) : (
                <p className={styles.noVisits}>No visits recorded</p>
              ))}
          </div>
        )}
      </div>

      {!here && isReady && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.visitButton}
            disabled={visiting}
            onClick={() => void visit()}
            aria-label={`Visit ${room.name}`}
          >
            <Navigation size={13} aria-hidden="true" />
            {visiting ? 'Going…' : 'Visit'}
          </button>
        </div>
      )}
      {visitError && (
        <p className={styles.failure} role="alert">
          Couldn&apos;t open this room. Try again or open its page.
        </p>
      )}
    </article>
  );
}

export function RoomCardSkeleton() {
  return <div className={styles.skeleton} aria-hidden="true" />;
}
