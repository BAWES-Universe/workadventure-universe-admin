'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { useAdminBootstrap, useBootstrapFresh } from '../../admin-bootstrap-context';
import { isNamed, isRecord, useCollection } from '../../hooks/use-collection';
import { useGuidanceDismissed } from '../../hooks/use-guidance-dismissed';
import { deriveProgress, getStartedSteps } from '../get-started-steps';
import { GetStarted } from '../yours';
import { GetStartedStrip } from './get-started-strip';
import styles from './get-started-strip.module.css';

const isUniverse = (value: unknown): value is { id: string } => isNamed(value) && typeof value.id === 'string';
const isMembership = (value: unknown): value is { id: string; tags: string[]; isUniverseOwner?: boolean; world: { id: string } } =>
  isRecord(value) && typeof value.id === 'string' && Array.isArray(value.tags) && isRecord(value.world) && typeof value.world.id === 'string';
const isAny = (value: unknown): value is unknown => value !== undefined;

/** A failed profile read is asked again after these waits, so one blip doesn't hide the guide for the whole visit. */
const PROFILE_RETRY_DELAYS_MS = [1500, 4000];

/**
 * Get started on Orbit, under your timeline: nothing done yet shows the whole checklist (there is nothing to orbit
 * yet); after that it is one line with the next step. It goes when every step is done. Hidden, it leaves one quiet
 * row at the bottom of Orbit (`comesBack`) while any step is left; Show brings it back for the account and scrolls up
 * to it. You no longer carries it.
 */
export function useGetStartedOnOrbit(): { guide: ReactNode; comesBack: ReactNode } {
  const { mine } = useAdminBootstrap();
  const fresh = useBootstrapFresh();
  const [hidden, hide, show] = useGuidanceDismissed('getStarted');
  // `null` while reading; `'unknown'` once every try failed (the guide still shows, the profile step as not done yet).
  const [profileComplete, setProfileComplete] = useState<boolean | 'unknown' | null>(null);
  // Hidden or not, the steps are read: the row that brings it back shows only while a step is left.
  const known = hidden !== null;
  const universes = useCollection(known ? '/api/admin/universes?scope=my&limit=4' : null, 'universes', isUniverse);
  const memberships = useCollection(known ? '/api/memberships/my' : null, 'memberships', isMembership);
  const stars = useCollection(known ? '/api/admin/stars/rooms' : null, 'rooms', isAny);
  const reveal = useRef(false);

  useEffect(() => {
    if (!known) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      authenticatedFetch('/api/admin/profile')
        .then(async (response) => {
          if (!response.ok) throw new Error('Profile unavailable');
          const data: unknown = await response.json();
          const profile = isRecord(data) ? data : {};
          if (!cancelled) setProfileComplete(Boolean(profile.bio || (Array.isArray(profile.links) && profile.links.length)));
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < PROFILE_RETRY_DELAYS_MS.length) timer = setTimeout(() => load(attempt + 1), PROFILE_RETRY_DELAYS_MS[attempt]);
          else setProfileComplete('unknown');
        });
    };
    load(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [known]);

  // Until the profile has answered, nothing: a half-known list would flash the wrong step (or a Show row for nothing).
  const ready = known && profileComplete !== null;
  const progress = ready
    ? deriveProgress({ mine, profileComplete: profileComplete === 'unknown' ? null : profileComplete, universes: universes.result, memberships: memberships.result, stars: stars.result })
    : null;
  const steps = progress ? getStartedSteps(progress) : [];
  const done = steps.filter((step) => step.done).length;
  const left = progress !== null && done < steps.length;
  const showing = left && hidden === false;

  // Show scrolls up to the guide it brought back.
  useEffect(() => {
    if (!showing || !reveal.current) return;
    reveal.current = false;
    document.querySelector('[data-testid="get-started"], [data-testid="get-started-strip"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [showing]);

  let guide: ReactNode = null;
  if (showing && progress) {
    const next = steps.find((step) => !step.done && step.href);
    guide =
      done === 0 ? (
        <GetStarted progress={progress} onHide={hide} />
      ) : (
        <GetStartedStrip done={done} total={steps.length} next={next ? { title: next.title, href: next.href! } : null} onHide={hide} />
      );
  }
  // The quiet row waits for this visit's numbers: a step finished on another page must not bring it back for a moment.
  const comesBack =
    left && hidden === true && fresh ? (
      <div className={styles.comesBack} data-testid="get-started-hidden">
        <span>
          <strong>Get started</strong>
          <span>Your first steps, hidden for now.</span>
        </span>
        <button
          type="button"
          className={`orbit-press ${styles.show}`}
          onClick={() => {
            reveal.current = true;
            show();
          }}
        >
          Show
        </button>
      </div>
    ) : null;
  return { guide, comesBack };
}

/** Get started and the row that brings it back, together (Orbit places them apart). */
export function GetStartedOnOrbit() {
  const { guide, comesBack } = useGetStartedOnOrbit();
  return (
    <>
      {guide}
      {comesBack}
    </>
  );
}
