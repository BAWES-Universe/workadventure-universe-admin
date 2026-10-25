'use client';

import Link from 'next/link';
import { useEffect, type CSSProperties } from 'react';
import { ArrowUpRight, Check } from 'lucide-react';
import { universeColour } from '@/lib/universe-colour';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { isNamed, isRecord, useCollection } from '../hooks/use-collection';
import { NameGlyph, StatLine, StatusPill, countPlace, hueStyle } from './ds';
import { deriveProgress, getStartedSteps, type GetStartedProgress } from './get-started-steps';
import styles from './yours.module.css';

export interface MyUniverse {
  id: string;
  name: string;
  description?: string | null;
  isPublic: boolean;
  featured?: boolean;
  _count?: { worlds?: number; rooms?: number };
}
interface MyMembership {
  id: string;
  tags: string[];
  isUniverseOwner?: boolean;
  world: { id: string; name: string; universe: { id?: string; name: string }; _count?: { rooms?: number; members?: number } };
}
interface StarredRoom {
  id: string;
  name: string;
  world: { name: string; universe: { id?: string; name: string } };
}

const SHOWN = 4;

const isUniverse = (value: unknown): value is MyUniverse => isNamed(value) && typeof value.isPublic === 'boolean';
const isMembership = (value: unknown): value is MyMembership =>
  isRecord(value) && typeof value.id === 'string' && Array.isArray(value.tags) && isNamed(value.world) && isRecord(value.world.universe);
const isStar = (value: unknown): value is StarredRoom =>
  isNamed(value) && isRecord(value.world) && typeof value.world.name === 'string' && isRecord(value.world.universe);

/**
 * Get started on You, for someone new: the steps are ticked by what you have (universes, worlds you're a member of,
 * stars). Your universes, memberships and stars themselves are rows on Orbit. Finding new places is Space's job.
 */
export default function Yours({
  profileComplete,
  getStarted,
}: {
  profileComplete: boolean | null;
  /** Whether Get started was hidden, and how to hide it. You keeps this, so its settings can show it again. */
  getStarted: { hidden: boolean | null; hide: () => void; onAllDone?: (allDone: boolean | null) => void };
}) {
  const { mine } = useAdminBootstrap();
  const universes = useCollection(`/api/admin/universes?scope=my&limit=${SHOWN}`, 'universes', isUniverse);
  const memberships = useCollection('/api/memberships/my', 'memberships', isMembership);
  const stars = useCollection('/api/admin/stars/rooms', 'rooms', isStar);

  const progress = deriveProgress({ mine, profileComplete, universes: universes.result, memberships: memberships.result, stars: stars.result });
  const allDone = getStartedSteps(progress).every((step) => step.done);
  const { hidden, hide, onAllDone } = getStarted;
  // Unknown (null) until the profile answer is in, so the page doesn't show or hide its Settings row on a guess.
  const allDoneKnown = profileComplete === null ? null : allDone;
  useEffect(() => {
    onAllDone?.(allDoneKnown);
  }, [allDoneKnown, onAllDone]);

  return (
    <div className={styles.yours} data-testid="yours">
      {!allDone && hidden === false && <GetStarted progress={progress} onHide={hide} />}
    </div>
  );
}

/** A universe as a planet in its own colour, with how many people are there now. The whole card opens it. */
export function UniverseCard({ universe, people = 0 }: { universe: MyUniverse; people?: number }) {
  return (
    <Link
      href={`/admin/universes/${universe.id}`}
      className={`${styles.universe} orbit-kind-wash`}
      data-kind="universe"
      style={{ ...hueStyle(universe.id), '--planet-color': universeColour(universe.id) } as CSSProperties}
    >
      <div className={styles.celestial} aria-hidden="true">
        <span className={styles.orbitRing} />
        <span className={styles.planet} />
        <span className={styles.moon} />
      </div>
      <div className={styles.universeTop}>
        {people > 0 && (
          <span className={styles.peopleHere}>
            <i aria-hidden="true" />
            {people} here
          </span>
        )}
        <span className={styles.universePills}>
          <StatusPill status={universe.isPublic ? 'public' : 'private'} />
          {universe.featured && <StatusPill status="featured" />}
        </span>
      </div>
      <div className={styles.universeBottom}>
        <div>
          <h3 className={`orbit-display ${styles.universeName}`}>
            <NameGlyph kind="universe" size={22} />
            {universe.name}
          </h3>
          {universe.description && <p>{universe.description}</p>}
          <StatLine items={[countPlace('world', universe._count?.worlds, 'world'), countPlace('room', universe._count?.rooms, 'room')]} />
        </div>
        <ArrowUpRight className={styles.cardArrow} size={22} aria-hidden="true" />
      </div>
    </Link>
  );
}

/**
 * For someone new: five steps, each one tap, each ticked by the real thing. It stays until every step is done or you
 * hide it; once hidden, You's settings can show it again. Orbit's top line is the short form of the same steps.
 */
export function GetStarted({ progress, onHide }: { progress: GetStartedProgress; onHide: () => void }) {
  const steps = getStartedSteps(progress);
  const doneCount = steps.filter((step) => step.done).length;
  return (
    <section className={styles.getStarted} aria-labelledby="get-started-heading" data-testid="get-started">
      <div className={styles.getStartedHead}>
        <h2 id="get-started-heading" className="orbit-display">
          Get started
        </h2>
        <span>
          {doneCount} of {steps.length}
          <button type="button" className={styles.hide} onClick={onHide}>
            Hide
          </button>
        </span>
      </div>
      <div className={styles.progress} aria-hidden="true">
        <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <ol className={styles.steps}>
        {steps.map((step, index) => {
          const body = (
            <>
              <span className={styles.stepMark} data-done={step.done || undefined} aria-hidden="true">
                {step.done ? <Check size={14} /> : index + 1}
              </span>
              <span className={styles.stepText}>
                <strong>{step.title}</strong>
                <span>{step.text}</span>
              </span>
              {step.href && !step.done && <ArrowUpRight className={styles.stepArrow} size={16} aria-hidden="true" />}
            </>
          );
          return (
            <li key={step.title} data-done={step.done || undefined}>
              {step.href && !step.done ? (
                <Link href={step.href} className={styles.step}>
                  {body}
                  <span className="sr-only">{step.done ? '(done)' : ''}</span>
                </Link>
              ) : (
                <div className={styles.step} aria-disabled={!step.done && !step.href ? true : undefined}>
                  {body}
                  {step.done && <span className="sr-only">(done)</span>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
