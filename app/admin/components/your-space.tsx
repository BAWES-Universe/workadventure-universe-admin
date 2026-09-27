'use client';

import Link from 'next/link';
import { ArrowUpRight, Building2, Globe2, Plus, Star } from 'lucide-react';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import styles from './your-space.module.css';

/**
 * The person's own space at a glance: the universes they own, the worlds they belong to, the rooms they starred.
 * A newcomer with none of them gets one clear invitation to make a universe, and one to explore.
 */
export default function YourSpace() {
  const { mine } = useAdminBootstrap();
  const nothingYet = mine && mine.universes === 0 && mine.worlds === 0 && mine.stars === 0;

  if (nothingYet) {
    return (
      <section className={styles.empty} data-testid="your-space-empty">
        <div>
          <p className={styles.eyebrow}>Room for an idea</p>
          <h2 className="orbit-display">A universe with your name on it.</h2>
          <p>Build one, or find your people in someone else&apos;s.</p>
        </div>
        <div className={styles.emptyActions}>
          <Link href="/admin/universes/new">
            <Plus size={16} aria-hidden="true" />
            Create a universe
          </Link>
          <Link href="/admin/space?tab=explore">
            Explore first
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.section} data-testid="your-space">
      <div className={styles.heading}>
        <h2 className="orbit-display">Your space</h2>
        <Link href="/admin/space">
          Space
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
      {mine ? (
        <div className={styles.index}>
          <Link href="/admin/universes">
            <Globe2 size={15} aria-hidden="true" />
            <strong>{mine.universes}</strong>
            <span>{mine.universes === 1 ? 'universe' : 'universes'}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
          <Link href="/admin/memberships">
            <Building2 size={15} aria-hidden="true" />
            <strong>{mine.worlds}</strong>
            <span>{mine.worlds === 1 ? 'world' : 'worlds'}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
          <Link href="/admin/stars">
            <Star size={15} aria-hidden="true" />
            <strong>{mine.stars}</strong>
            <span>{mine.stars === 1 ? 'star' : 'stars'}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <p className={styles.unavailable}>Open Space to find your universes, memberships and starred rooms.</p>
      )}
      {Boolean(mine?.invitations) && (
        <Link href="/admin/memberships" className={styles.invitation}>
          {mine!.invitations} {mine!.invitations === 1 ? 'invitation' : 'invitations'} waiting
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}
