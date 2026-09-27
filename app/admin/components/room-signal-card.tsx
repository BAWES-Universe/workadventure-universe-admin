'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ChevronDown, Navigation, Star } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import { useWorkAdventure } from '../workadventure-context';
import { formatPeakHour, roomSignalFromAnalytics, wasLastVisitorYou, type RoomSignal, type SignalRoom } from './room-signal-data';
import styles from './room-signal-card.module.css';

type SignalState = { roomId: string; kind: 'loading' | 'error' } | { roomId: string; kind: 'ready'; signal: RoomSignal };

/** An illustration of a place in your orbit, never a visualization of activity. */
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
      <circle cx="50" cy="126" r="4" fill="currentColor" />
      <circle cx="235" cy="49" r="2" fill="currentColor" fillOpacity="0.5" />
      <path d="M45 55h8m-4-4v8M226 144h6m-3-3v6" stroke="currentColor" strokeOpacity="0.45" strokeWidth="0.8" />
    </svg>
  );
}

function VisitTime({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value} title={date.toLocaleString()}>{timeAgo(date)}</time>;
}

export default function RoomSignalCard({ room, variant = 'recent', index }: {
  room: SignalRoom;
  variant?: 'current' | 'previous' | 'recent';
  index?: number;
}) {
  const { isReady, navigateToRoom } = useWorkAdventure();
  const [activity, setActivity] = useState<SignalState>({ roomId: room.id, kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const [visiting, setVisiting] = useState(false);
  const [visitError, setVisitError] = useState(false);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setActivity({ roomId: room.id, kind: 'loading' });
    async function load() {
      try {
        const response = await authenticatedFetch(`/api/admin/analytics/rooms/${encodeURIComponent(room.id)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Room activity unavailable');
        const data = await response.json();
        if (!controller.signal.aborted) setActivity({ roomId: room.id, kind: 'ready', signal: roomSignalFromAnalytics(data) });
      } catch {
        if (!controller.signal.aborted) setActivity({ roomId: room.id, kind: 'error' });
      }
    }
    void load();
    return () => controller.abort();
  }, [room.id, retry]);

  const currentActivity = activity.roomId === room.id ? activity : { kind: 'loading' as const };
  const signal = currentActivity.kind === 'ready' ? currentActivity.signal : null;
  const favorites = room._count?.favorites;
  const lastVisited = signal?.lastVisitedByUser?.accessedAt ?? room.accessedAt;
  const history = (
    <div className={styles.visitHistory}>
      {(lastVisited || signal) && <p><span>Last visited by you</span><strong>{lastVisited ? <VisitTime value={lastVisited} /> : 'Not yet'}</strong></p>}
      {signal?.lastVisitedOverall && <p><span>Latest visitor</span><strong>{wasLastVisitorYou(signal) ? 'You' : <VisitTime value={signal.lastVisitedOverall.accessedAt} />}</strong></p>}
      {signal && !signal.lastVisitedOverall && <p className={styles.noVisits}>No visits recorded yet</p>}
    </div>
  );
  const activityStatus = currentActivity.kind === 'loading'
    ? <p className={styles.activityStatus} role="status">Reading room activity…</p>
    : currentActivity.kind === 'error'
      ? <p className={styles.activityStatus}>Activity is unavailable. <button className={styles.retry} onClick={() => setRetry((value) => value + 1)}>Try again</button></p>
      : null;
  const coordinates = <p className={styles.coordinates}>
    <Link href={`/admin/universes/${room.world.universe.id}`}>{room.world.universe.name}</Link>
    <span aria-hidden="true">/</span>
    <Link href={`/admin/worlds/${room.world.id}`}>{room.world.name}</Link>
  </p>;

  async function visit() {
    setVisiting(true);
    setVisitError(false);
    try {
      const slugs = [room.world.universe.slug, room.world.slug, room.slug].map(encodeURIComponent).join('/');
      await navigateToRoom(`/@/${slugs}`);
    } catch {
      setVisitError(true);
    } finally {
      setVisiting(false);
    }
  }

  return (
    <article className={`observatory-room-signal ${styles.card} ${styles[variant]}`} aria-labelledby={titleId} data-testid={`room-signal-${room.id}`}>
      {variant === 'current' && <OrbitalIllustration />}
      <div className={styles.cardTop}>
        <span className={styles.eyebrow}>
          {variant === 'current' ? <><i className={styles.presence} /> You are here</> : variant === 'previous' ? 'Previous location' : 'In your orbit'}
        </span>
        {variant === 'recent' && index !== undefined && <span className={styles.ordinal} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>}
        {typeof favorites === 'number' && <span className={styles.stars} aria-label={`${favorites} ${favorites === 1 ? 'star' : 'stars'}`}><Star size={13} aria-hidden="true" />{favorites.toLocaleString()}</span>}
      </div>

      <div className={styles.place}>
        <div className={styles.placeWords}>
          {variant === 'current' && coordinates}
          <h3 id={titleId} className={styles.roomName}><Link href={`/admin/rooms/${room.id}`}>{room.name}</Link></h3>
          {room.description && <p className={styles.description}>{room.description}</p>}
        </div>
      </div>

      {variant === 'current' ? <div className={styles.activity}>
        {activityStatus}
        {signal && <dl className={styles.metrics}>
          <div><dt>Accesses</dt><dd>{signal.totalAccesses === null ? 'Unavailable' : signal.totalAccesses.toLocaleString()}</dd></div>
          <div><dt>Peak hour <span className={styles.zone}>{signal.peakHour !== null ? `· ${signal.peakZone}` : ''}</span></dt><dd>{signal.peakHour === null ? 'Not enough data' : formatPeakHour(signal.peakHour)}</dd></div>
        </dl>}
        {history}
      </div> : null}

      <div className={styles.actions}>
        {variant === 'current' ?
        <Link href={`/admin/rooms/${room.id}`} className={styles.detailsLink} aria-label={`Explore ${room.name}`}>
          Explore this room<ArrowUpRight size={15} aria-hidden="true" />
        </Link> : <div className={styles.accessSummary}>{signal ? <><strong>{signal.totalAccesses === null ? '—' : signal.totalAccesses.toLocaleString()}</strong><span>{signal.totalAccesses === null ? 'Accesses unavailable' : 'accesses'}</span></> : activityStatus}</div>}
        {variant !== 'current' && isReady && <button type="button" className={styles.visitButton} disabled={visiting} onClick={() => void visit()} aria-label={`Visit ${room.name}`}>
          <Navigation size={13} aria-hidden="true" />{visiting ? 'Opening…' : variant === 'previous' ? 'Return' : 'Visit'}
        </button>}
      </div>
      {variant !== 'current' && <details className={styles.disclosure}>
        <summary>Room activity<ChevronDown size={13} aria-hidden="true" /></summary>
        <div className={styles.disclosureBody}>
          {coordinates}
          {signal && <p className={styles.peakDetail}><span>Peak hour {signal.peakHour !== null ? `· ${signal.peakZone}` : ''}</span><strong>{signal.peakHour === null ? 'Not enough data' : formatPeakHour(signal.peakHour)}</strong></p>}
          {history}
          <Link href={`/admin/rooms/${room.id}`} className={styles.detailsLink} aria-label={`Explore ${room.name}`}>Room details<ArrowUpRight size={15} aria-hidden="true" /></Link>
        </div>
      </details>}
      {visitError && <p className={styles.failure} role="alert">Couldn&apos;t open this room. Try again or open its details.</p>}
    </article>
  );
}
