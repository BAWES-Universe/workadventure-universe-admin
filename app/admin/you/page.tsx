'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { StatLine, count } from '../components/ds';
import { AiKeysCard } from '../components/ai-keys-card';
import { ActivitySection, PassportSection } from '../components/passport';
import { ProfileCard } from '../components/profile-card';
import styles from './you.module.css';

/** Your latest activity on You; View all opens the rest. */
const ACTIVITY_SHOWN = 3;

/**
 * You: your profile as others see it (edited in place), how your AI keys are doing, your passport, and your latest
 * activity with View all (Appearance, Sharing and Sign out live in the Orbit menu). Get started, your stars, universes
 * and memberships are on Orbit; finding new places is Space's job.
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
  // `?edit=profile` (the game's "Edit my profile" and Get started's "Set up your profile") opens the profile ready to
  // edit; the menu's Profile just shows it.
  const editProfile = useSearchParams().get('edit') === 'profile';
  const router = useRouter();
  // The card keeps the form open once asked; the address drops the ask at once, so Back, a reload or a later visit
  // shows the profile, never the form you didn't ask for.
  useEffect(() => {
    if (editProfile) router.replace('/admin/you', { scroll: false });
  }, [editProfile, router]);
  return (
    <div className={styles.page}>
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
      <AiKeysCard />
      <PassportSection small />
      <ActivitySection limit={ACTIVITY_SHOWN} />
    </div>
  );
}
