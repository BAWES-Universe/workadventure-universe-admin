'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { StatLine, count } from '../components/ds';
import { ProfileCard } from '../components/profile-card';
import { QuestBadges } from '../components/quests/quest-badges';
import Yours from '../components/yours';
import styles from './you.module.css';

/**
 * You: your profile as others see it (edited in place), your badges and quests right under it, then what's yours
 * (universes, memberships, stars). Appearance and Sign out sit at the foot of the Orbit Menu; finding new places is
 * Space's job.
 */
export default function YouPage() {
  return (
    <Suspense fallback={null}>
      <You />
    </Suspense>
  );
}

function You() {
  const { user, mine } = useAdminBootstrap();
  // `?edit=profile` (the game's "Edit my profile") opens the profile ready to edit; the menu's Profile just shows it.
  const editProfile = useSearchParams().get('edit') === 'profile';
  const router = useRouter();
  // The card keeps the form open once asked; the address drops the ask at once, so Back, a reload or a later visit
  // shows the profile, never the form you didn't ask for.
  useEffect(() => {
    if (editProfile) router.replace('/admin/you', { scroll: false });
  }, [editProfile, router]);
  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <ProfileCard
          user={user}
          startEditing={editProfile}
          stats={
            mine && (
              <StatLine
                items={[
                  mine.universes > 0 && `Owns ${count(mine.universes, 'universe')}`,
                  mine.worlds > 0 && `Member of ${count(mine.worlds, 'world')}`,
                  mine.stars > 0 && count(mine.stars, 'star'),
                ]}
              />
            )
          }
        />
        <QuestBadges />
      </div>
      <Yours />
    </div>
  );
}
