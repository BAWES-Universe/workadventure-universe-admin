'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { ProfileCard } from '../components/profile-card';
import { ThemeChoice } from '../components/shell/theme-choice';
import Yours from '../components/yours';
import LogoutButton from '../logout-button';
import styles from './you.module.css';

/** You: your profile as others see it (edited in place), what's yours, then how Orbit looks and your account. */
export default function YouPage() {
  return (
    <Suspense fallback={null}>
      <You />
    </Suspense>
  );
}

function You() {
  const { user } = useAdminBootstrap();
  // `?edit=profile` (the game's "edit your profile" and old visit-card links) opens the profile ready to edit.
  const editProfile = useSearchParams().get('edit') === 'profile';
  return (
    <div className={styles.page}>
      <ProfileCard user={user} startEditing={editProfile} />
      <Yours />
      <footer className={styles.footer}>
        <section className={styles.appearance} aria-labelledby="appearance-heading">
          <h2 id="appearance-heading">Appearance</h2>
          <ThemeChoice className={styles.themeControl} />
        </section>
        <div className={styles.account}>
          {user.email && (
            <p>
              Signed in as <strong>{user.email}</strong>
            </p>
          )}
          <LogoutButton className="h-10 rounded-full" />
        </div>
      </footer>
    </div>
  );
}
