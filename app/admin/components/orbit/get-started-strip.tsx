'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import styles from './get-started-strip.module.css';

/**
 * Get started as one line at the top of Orbit, for someone partway through: how far along, the next step as a button,
 * and Hide. (Someone with nothing done yet gets the whole checklist there instead.)
 */
export function GetStartedStrip({
  done,
  total,
  next,
  onHide,
}: {
  done: number;
  total: number;
  /** The next step you can take now; none when the steps left wait on each other. */
  next: { title: string; href: string } | null;
  onHide: () => void;
}) {
  const percent = Math.round((done / total) * 100);
  return (
    <section className={styles.strip} aria-label="Get started" data-testid="get-started-strip">
      <span className={styles.ring} style={{ ['--done' as string]: `${percent}%` }} aria-hidden="true">
        <b>
          {done}/{total}
        </b>
      </span>
      <div className={styles.text}>
        <strong>Get started</strong>
        <small>
          {done} of {total} done
        </small>
      </div>
      <button type="button" className={styles.hide} onClick={onHide}>
        Hide
      </button>
      {next && (
        <Link href={next.href} className={`orbit-press ${styles.next}`}>
          {next.title}
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}
