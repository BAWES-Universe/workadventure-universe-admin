'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { StatLine, count } from '../components/ds';
import { ActivitySection, PassportSection } from '../components/passport';
import { ProfileCard } from '../components/profile-card';
import { useGuidanceDismissed } from '../hooks/use-guidance-dismissed';
import Yours from '../components/yours';
import styles from './you.module.css';

/**
 * You: your profile as others see it (edited in place), then what's yours (universes, memberships, stars), then
 * a Settings row for bringing Get started back (Appearance, Sharing and Sign out live in the Orbit menu). Someone new gets first steps; finding new places is Space's job.
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
  const [profileComplete, setProfileComplete] = useState<boolean | null>(null);
  // The card keeps the form open once asked; the address drops the ask at once, so Back, a reload or a later visit
  // shows the profile, never the form you didn't ask for.
  useEffect(() => {
    if (editProfile) router.replace('/admin/you', { scroll: false });
  }, [editProfile, router]);
  // Get started, once hidden, comes back from Settings (while any step is left), and the page scrolls up to it.
  const [getStartedHidden, hideGetStarted, showGetStarted] = useGuidanceDismissed('getStarted');
  const [stepsAllDone, setStepsAllDone] = useState(false);
  const scrollToSteps = useRef(false);
  useEffect(() => {
    if (!scrollToSteps.current || getStartedHidden !== false) return;
    scrollToSteps.current = false;
    document.getElementById('get-started-heading')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [getStartedHidden]);
  return (
    <div className={styles.page}>
      <ProfileCard
        user={user}
        startEditing={editProfile}
        onLoaded={setProfileComplete}
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
      <PassportSection />
      <ActivitySection />
      <Yours
        profileComplete={profileComplete}
        getStarted={{ hidden: getStartedHidden, hide: hideGetStarted, onAllDone: setStepsAllDone }}
      />
      {getStartedHidden === true && !stepsAllDone && (
        <section className={styles.settings} aria-labelledby="settings-heading">
          <h2 id="settings-heading" className="orbit-display">
            Settings
          </h2>
          <div className={styles.settingRow}>
            <span>
              <strong>Get started</strong>
              <span>Your first steps, hidden for now.</span>
            </span>
            <button
              type="button"
              className={`orbit-press ${styles.settingButton}`}
              onClick={() => {
                scrollToSteps.current = true;
                showGetStarted();
              }}
            >
              Show
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
