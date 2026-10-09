'use client';

import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
import { Eye, Lock, Users } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import { universeColour } from '@/lib/universe-colour';
import type { Audience } from '@/lib/people-settings';
import type { ActivityEvent } from '@/lib/activity';
import type { Passport } from '@/lib/passport';
import { KIND_ICON } from './ds';
import styles from './passport.module.css';

/** The tilt of each stamp, repeated: a stamp is never quite straight. */
const TILTS = [-4, 3, -2, 4, -3];

const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;

/** Who sees the passport, said plainly, with the way to change it. */
function Visible({ audience }: { audience: Audience }) {
  const Icon = audience === 'everyone' ? Eye : audience === 'friends' ? Users : Lock;
  return (
    <span className={styles.visible} data-testid="passport-visible">
      <Icon size={13} aria-hidden="true" />
      {audience === 'everyone' ? 'Everyone can see this' : audience === 'friends' ? 'Only your friends can see this' : 'Only you can see this'}
      {' · '}
      <Link href="/admin/sharing">Who can see me</Link>
    </span>
  );
}

/** The stamps themselves: one per world, in its universe's colour. */
export function Stamps({ stamps, className }: { stamps: Passport['stamps']; className?: string }) {
  const World = KIND_ICON.world;
  return (
    <ul className={className ?? styles.stamps}>
      {stamps.map((stamp, index) => (
        <li
          key={stamp.worldId}
          className={styles.stamp}
          style={{ '--c': universeColour(stamp.universe.id), '--r': `${TILTS[index % TILTS.length]}deg` } as CSSProperties}
          data-testid="passport-stamp"
        >
          <World size={22} className={styles.glyph} aria-hidden="true" />
          <strong>{stamp.world}</strong>
          <span>{stamp.universe.name}</span>
          <em>{plural(stamp.visits, 'visit')}</em>
          <small>since {dateOf(stamp.since)}</small>
        </li>
      ))}
    </ul>
  );
}

/**
 * Your passport: every world you have been to, and how long you have been around. Given `userId` it is someone else's:
 * only the public worlds they chose to show you, and nothing at all when they hide it.
 */
export function PassportSection({ userId, name }: { userId?: string; name?: string } = {}) {
  const [state, setState] = useState<{ passport: Passport; audience?: Audience } | 'loading' | 'error'>('loading');
  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(userId ? `/api/admin/users/${encodeURIComponent(userId)}/passport` : '/api/me/passport')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Passport answered ${response.status}`);
        const data = (await response.json()) as { passport?: Passport | null; audience?: Audience };
        // Someone who hides their passport from you answers with none; show nothing, not an error.
        if (userId && data.passport === null) {
          if (!cancelled) setState('error');
          return;
        }
        if (!data.passport) throw new Error('No passport');
        if (!cancelled) setState({ passport: data.passport, audience: userId ? undefined : (data.audience ?? 'everyone') });
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  // Nothing while it loads or if it can't be read: the rest of You stays as it was.
  if (state === 'loading' || state === 'error') return null;
  const { passport, audience } = state;
  // On someone else's profile, no stamps means nothing to show.
  if (userId && passport.stamps.length === 0) return null;
  return (
    <section className={styles.section} aria-labelledby="passport-heading" data-testid="passport">
      <div className={styles.head}>
        <h2 id="passport-heading" className="orbit-display">
          {userId ? (name ? `${name}’s passport` : 'Their passport') : 'Your passport'}
        </h2>
        {audience && <Visible audience={audience} />}
      </div>
      <div className={styles.card}>
        {passport.stamps.length === 0 ? (
          <p className={styles.empty}>Your passport gets a stamp for every world you visit.</p>
        ) : (
          <>
            <div className={styles.cardHead}>
              <p className={styles.big}>
                <b>{plural(passport.worlds, 'world')}</b> in <b>{plural(passport.universes, 'universe')}</b>
              </p>
              {passport.since && (
                <span className={styles.sub}>
                  Since {dateOf(passport.since)} · {plural(passport.days, 'day')} in Universe
                </span>
              )}
            </div>
            <Stamps stamps={passport.stamps} />
          </>
        )}
      </div>
    </section>
  );
}

/** Your activity: what happened to you lately. Only you see it. */
export function ActivitySection() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    authenticatedFetch('/api/me/activity')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Activity answered ${response.status}`);
        const data = (await response.json()) as { events?: ActivityEvent[] };
        if (!cancelled) setEvents(Array.isArray(data.events) ? data.events : []);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!events || events.length === 0) return null;
  return (
    <section className={styles.section} aria-labelledby="activity-heading" data-testid="activity">
      <div className={styles.head}>
        <h2 id="activity-heading" className="orbit-display">
          Your activity
        </h2>
        <span className={styles.visible}>
          <Lock size={13} aria-hidden="true" /> Only you can see this
        </span>
      </div>
      <div className={styles.card} style={{ paddingTop: 6, paddingBottom: 6 }}>
        <ul className={styles.events}>
          {events.map((event) => {
            const Icon = KIND_ICON[event.kind];
            const body = (
              <>
                <Icon size={18} className={styles.eventGlyph} data-kind={event.kind} aria-hidden="true" />
                <p>{event.text}</p>
                <time dateTime={event.at}>{timeAgo(new Date(event.at))}</time>
              </>
            );
            return <li key={event.id}>{event.href ? <Link href={event.href}>{body}</Link> : body}</li>;
          })}
        </ul>
      </div>
    </section>
  );
}
