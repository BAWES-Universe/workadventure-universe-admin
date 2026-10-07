'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/time-ago';
import type { RecentVisitor } from '@/lib/recent-visitors';
import type { Stamp } from '@/lib/passport';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ProfileLinks, WokaAvatar, type ProfileLink } from './profile-card';
import { Stamps } from './passport';
import passportStyles from './passport.module.css';
import styles from './recent-visitors.module.css';

type Scope = 'universe' | 'world' | 'room';

interface Profile {
  bio: string | null;
  links: ProfileLink[];
  stamps: Stamp[];
}

/** What the sheet shows of someone besides the row: their words and links, and their stamps. Missing pieces are left out. */
function useProfile(userId: string | null): Profile | null {
  const [loaded, setLoaded] = useState<{ userId: string; profile: Profile } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const json = async (path: string) => {
      try {
        const response = await authenticatedFetch(path);
        return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    Promise.all([json(`/api/admin/users/${encodeURIComponent(userId)}`), json(`/api/admin/users/${encodeURIComponent(userId)}/passport`)]).then(([user, passport]) => {
      if (cancelled) return;
      const card = (user?.visitCard ?? null) as { bio?: string | null; links?: ProfileLink[] } | null;
      setLoaded({
        userId,
        profile: {
          bio: card?.bio?.trim() || null,
          links: Array.isArray(card?.links) ? card.links : [],
          stamps: Array.isArray(passport?.stamps) ? (passport.stamps as Stamp[]) : [],
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return loaded && loaded.userId === userId ? loaded.profile : null;
}

function VisitorSheet({ visitor, onClose }: { visitor: RecentVisitor | null; onClose: () => void }) {
  const profile = useProfile(visitor?.userId ?? null);
  return (
    <Sheet open={visitor !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className={styles.sheet} data-testid="visitor-sheet">
        {visitor && (
          <>
            <div className={styles.top}>
              <WokaAvatar layers={visitor.woka} name={visitor.name} size={76} tinted />
              <div>
                <SheetTitle className={styles.name}>{visitor.name}</SheetTitle>
                <SheetDescription className={styles.when}>
                  Here {timeAgo(new Date(visitor.at))} · {visitor.room.name}
                </SheetDescription>
              </div>
            </div>
            {profile?.bio && <p className={styles.bio}>{profile.bio}</p>}
            {profile && <ProfileLinks links={profile.links} />}
            {profile && profile.stamps.length > 0 && <Stamps stamps={profile.stamps} className={`${passportStyles.stamps} ${styles.stamps}`} />}
            <Link href={`/admin/users/${visitor.userId}`} className={styles.full}>
              Full profile
            </Link>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Who came by lately: a row of faces, newest first, each with a name and how long ago. Tapping one opens their profile
 * card. Past visits, not who is online. Nothing at all when there is nobody to show, or the viewer may not see who.
 */
export default function RecentVisitors({ scope, id, onOpenVisitors }: { scope: Scope; id: string; onOpenVisitors?: () => void }) {
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
      <h2 id={`recent-visitors-${scope}`} className="orbit-display text-lg font-bold">
        Recent visitors
      </h2>
      <p className={styles.note}>Who came by lately, newest first. Past visits, not who is online.{guests > 0 && ' Guests are people without an account.'}</p>
      <ul className={styles.visitors}>
        {guests > 0 && (
          <li>
            <button
              type="button"
              className={cn(styles.face, styles.guests)}
              aria-label={`${guests} ${guests === 1 ? 'guest' : 'guests'} this week. See the Visitors tab`}
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
          <li key={visitor.userId}>
            <button
              type="button"
              className={styles.face}
              data-picked={picked?.userId === visitor.userId}
              aria-label={`${visitor.name}, ${timeAgo(new Date(visitor.at))}`}
              onClick={() => setPicked(visitor)}
            >
              <WokaAvatar layers={visitor.woka} name={visitor.name} size={44} tinted />
              <strong>{visitor.name}</strong>
              <span>{timeAgo(new Date(visitor.at))}</span>
            </button>
          </li>
        ))}
      </ul>
      <VisitorSheet visitor={picked} onClose={() => setPicked(null)} />
    </section>
  );
}
