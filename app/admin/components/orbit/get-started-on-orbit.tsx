'use client';

import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { useAdminBootstrap } from '../../admin-bootstrap-context';
import { isNamed, isRecord, useCollection } from '../../hooks/use-collection';
import { useGuidanceDismissed } from '../../hooks/use-guidance-dismissed';
import { deriveProgress, getStartedSteps } from '../get-started-steps';
import { GetStarted } from '../yours';
import { GetStartedStrip } from './get-started-strip';

const isUniverse = (value: unknown): value is { id: string } => isNamed(value) && typeof value.id === 'string';
const isMembership = (value: unknown): value is { id: string; tags: string[]; isUniverseOwner?: boolean; world: { id: string } } =>
  isRecord(value) && typeof value.id === 'string' && Array.isArray(value.tags) && isRecord(value.world) && typeof value.world.id === 'string';
const isAny = (value: unknown): value is unknown => value !== undefined;

/**
 * Get started where it's seen: at the top of Orbit. Nothing done yet shows the whole checklist (there is nothing to
 * orbit yet); after that it is one line with the next step. It goes when every step is done or you hide it, and You's
 * settings bring it back, here and on You together.
 */
export function GetStartedOnOrbit() {
  const { mine } = useAdminBootstrap();
  const [hidden, hide] = useGuidanceDismissed('getStarted');
  const [profileComplete, setProfileComplete] = useState<boolean | null>(null);
  const universes = useCollection(hidden === false ? '/api/admin/universes?scope=my&limit=4' : null, 'universes', isUniverse);
  const memberships = useCollection(hidden === false ? '/api/memberships/my' : null, 'memberships', isMembership);
  const stars = useCollection(hidden === false ? '/api/admin/stars/rooms' : null, 'rooms', isAny);

  useEffect(() => {
    if (hidden !== false) return;
    let cancelled = false;
    authenticatedFetch('/api/admin/profile')
      .then(async (response) => {
        if (!response.ok) throw new Error('Profile unavailable');
        const data: unknown = await response.json();
        const profile = isRecord(data) ? data : {};
        if (!cancelled) setProfileComplete(Boolean(profile.bio || (Array.isArray(profile.links) && profile.links.length)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hidden]);

  // Until the profile has answered, nothing: a half-known list would flash the wrong step.
  if (hidden !== false || profileComplete === null) return null;
  const progress = deriveProgress({ mine, profileComplete, universes: universes.result, memberships: memberships.result, stars: stars.result });
  const steps = getStartedSteps(progress);
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;
  if (done === 0) return <GetStarted progress={progress} onHide={hide} />;
  const next = steps.find((step) => !step.done && step.href);
  return <GetStartedStrip done={done} total={steps.length} next={next ? { title: next.title, href: next.href! } : null} onHide={hide} />;
}
