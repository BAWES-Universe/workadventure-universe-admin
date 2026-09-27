'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { StatLine, count } from '../components/ds';
import { ProfileCard } from '../components/profile-card';
import { ThemeChoice } from '../components/shell/theme-choice';
import Yours from '../components/yours';
import LogoutButton from '../logout-button';
import styles from './you.module.css';

/**
 * You: your profile as others see it (edited in place), then what's yours (universes, memberships, stars), then
 * settings. Someone new gets first steps; finding new places is Space's job.
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
  // `?edit=profile` (Get started's "Set up your profile") opens the profile ready to edit; anything else shows it.
  const editProfile = useSearchParams().get('edit') === 'profile';
  const router = useRouter();
  const [profileComplete, setProfileComplete] = useState<boolean | null>(null);
  return (
    <div className={styles.page}>
      <ProfileCard
        user={user}
        startEditing={editProfile}
        onLoaded={setProfileComplete}
        // The intent is used up once editing ends, so Back and a later visit don't reopen the form.
        onEditEnd={() => {
          if (editProfile) router.replace('/admin/you', { scroll: false });
        }}
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
      <Yours profileComplete={profileComplete} />
      <section className={styles.settings} aria-labelledby="settings-heading">
        <h2 id="settings-heading" className="orbit-display">
          Settings
        </h2>
        <div className={styles.settingRow}>
          <span>
            <strong>Appearance</strong>
            <span>Light, dark, or follow your device.</span>
          </span>
          <ThemeChoice className={styles.themeControl} />
        </div>
        <div className={styles.settingRow}>
          <span>
            <strong>Account</strong>
            {user.email && <span>Signed in as {user.email}</span>}
          </span>
          <LogoutButton className="h-10 rounded-full" />
        </div>
      </section>
    </div>
  );
}
