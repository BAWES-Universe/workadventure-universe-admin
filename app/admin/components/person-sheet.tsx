'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import type { Stamp } from '@/lib/passport';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ProfileLinks, WokaAvatar, type ProfileLink } from './profile-card';
import { Stamps } from './passport';
import passportStyles from './passport.module.css';
import styles from './recent-visitors.module.css';

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

/** Shared profile sheet for members and visitors. Fetch private profile details only when opened. */
export function PersonSheet({ person, description, children, onClose, testId = 'visitor-sheet' }: {
  person: { userId: string | null; name: string; woka: string[] } | null;
  description: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  testId?: string;
}) {
  const profile = useProfile(person?.userId ?? null);
  return (
    <Sheet open={person !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className={styles.sheet} data-testid={testId}>
        {person && (
          <>
            <div className={styles.top}>
              <WokaAvatar layers={person.woka} name={person.name} size={76} tinted />
              <div>
                <SheetTitle className={styles.name}>{person.name}</SheetTitle>
                <SheetDescription className={styles.when}>{description}</SheetDescription>
              </div>
            </div>
            {children}
            {profile?.bio && <p className={styles.bio}>{profile.bio}</p>}
            {profile && <ProfileLinks links={profile.links} />}
            {profile && profile.stamps.length > 0 && <Stamps stamps={profile.stamps} className={`${passportStyles.stamps} ${styles.stamps}`} />}
            {person.userId && <Link href={`/admin/users/${encodeURIComponent(person.userId)}`} className={styles.full}>Full profile</Link>}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
