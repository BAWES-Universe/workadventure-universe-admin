'use client';

import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { cn } from '@/lib/utils';
import { timeAgo, timeAgoShort } from '@/lib/time-ago';
import type { RecentVisitor } from '@/lib/recent-visitors';
import { WokaAvatar } from './profile-card';
import { PersonSheet } from './person-sheet';
import { VisitorMembership } from './visitor-membership';
import styles from './recent-visitors.module.css';

type Scope = 'universe' | 'world' | 'room';

/**
 * Who came by lately: a row of faces, newest first, each with a name and how long ago. Tapping one opens their profile
 * card. Past visits, not who is online. Nothing at all when there is nobody to show, or the viewer may not see who.
 */
export default function RecentVisitors({ scope, id, onOpenVisitors, lastVisited }: { scope: Scope; id: string; onOpenVisitors?: () => void; lastVisited?: string | null }) {
  const [visitors, setVisitors] = useState<RecentVisitor[]>([]);
  const [guests, setGuests] = useState(0);
  const [picked, setPicked] = useState<RecentVisitor | null>(null);
  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`/api/admin/recent-visitors?scope=${scope}&id=${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { visitors?: RecentVisitor[]; guests?: number };
        if (cancelled) return;
        if (Array.isArray(data.visitors)) setVisitors(data.visitors);
        if (typeof data.guests === 'number' && data.guests > 0) setGuests(data.guests);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scope, id]);
  if (visitors.length === 0 && guests === 0) return null;
  return (
    <section className={styles.section} aria-labelledby={`recent-visitors-${scope}`} data-testid="recent-visitors">
      <div className={styles.head}>
        <h2 id={`recent-visitors-${scope}`} className="orbit-display text-lg font-bold">
          Recent visitors
        </h2>
        {onOpenVisitors && (
          <button type="button" className={cn('orbit-press', styles.seeAllPill)} onClick={onOpenVisitors} data-testid="recent-visitors-see-all">
            See all
          </button>
        )}
      </div>
      {lastVisited && <p className={styles.note}>Last visited <time dateTime={lastVisited} title={new Date(lastVisited).toLocaleString()}>{timeAgo(new Date(lastVisited))}</time></p>}
      <p className={styles.note}>Who came by lately, newest first. Past visits, not who is online.{guests > 0 && ' Guests are people without an account.'}</p>
      <ul className={styles.visitors}>
        {guests > 0 && (
          <li>
            <button
              type="button"
              className={cn(styles.face, styles.guests)}
              aria-label={`${guests} ${guests === 1 ? 'guest' : 'guests'} this week. See all visitors`}
              onClick={onOpenVisitors}
            >
              <span className={styles.guestCount} aria-hidden="true">
                {guests}
              </span>
              <strong>{guests === 1 ? 'Guest' : 'Guests'}</strong>
              <span>this week</span>
            </button>
          </li>
        )}
        {visitors.map((visitor) => (
          <li key={visitor.key}>
            <button
              type="button"
              className={styles.face}
              data-picked={picked?.key === visitor.key}
              aria-label={`${visitor.name}, ${visitor.guest ? 'guest, ' : ''}${timeAgo(new Date(visitor.at))}`}
              onClick={() => setPicked(visitor)}
            >
              <WokaAvatar layers={visitor.woka} name={visitor.name} size={44} tinted />
              <strong>{visitor.name}</strong>
              <span>{visitor.guest ? `Guest · ${timeAgoShort(new Date(visitor.at))}` : timeAgo(new Date(visitor.at))}</span>
            </button>
          </li>
        ))}
      </ul>
      <PersonSheet person={picked} onClose={() => setPicked(null)} description={picked && <>{picked.guest && 'Guest · '}Here {timeAgo(new Date(picked.at))} · {picked.room.name}</>}>
        {scope === 'room' && picked && <VisitorMembership key={`${id}-${picked.key}`} roomId={id} userId={picked.guest ? null : picked.userId} />}
      </PersonSheet>
    </section>
  );
}
