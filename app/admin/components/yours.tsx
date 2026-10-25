'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ArrowUpRight, Check } from 'lucide-react';
import { universeColour } from '@/lib/universe-colour';
import { NameGlyph, StatLine, StatusPill, countPlace, hueStyle } from './ds';
import { getStartedSteps, type GetStartedProgress } from './get-started-steps';
import styles from './yours.module.css';

/** A universe you own, as the universes list gives it. */
export interface MyUniverse {
  id: string;
  name: string;
  description?: string | null;
  isPublic: boolean;
  featured?: boolean;
  _count?: { worlds?: number; rooms?: number };
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
