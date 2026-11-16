'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Github } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import styles from './github-setup-row.module.css';

/** Where Universe's one-time GitHub App setup is (game #2041). */
export const GITHUB_SETUP_HREF = '/admin/github-app';

/** Whether Universe's GitHub App is made; null until known, and for anyone who is not a super admin. */
export function useGitHubSetup(enabled: boolean): boolean | null {
  const [made, setMade] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await authenticatedFetch('/api/admin/github-app');
        if (!response.ok) return;
        const body = (await response.json()) as { made?: unknown };
        if (!cancelled && typeof body.made === 'boolean') setMade(body.made);
      } catch {
        // Extra: without it Orbit home still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? made : null;
}

/**
 * Orbit home, for super admins: the way to the one-time "GitHub for Universe" setup, and whether it has been done. One row, the
 * whole row the link. Quiet once set up; until then it carries the same amber as a notice, so the step is not missed.
 */
export function GitHubSetupRow({ made }: { made: boolean }) {
  return (
    <Link href={GITHUB_SETUP_HREF} className={`orbit-press ${styles.row}`} data-state={made ? 'made' : 'todo'} data-testid="github-setup">
      <Github size={24} className={styles.glyph} aria-hidden="true" />
      <span className={styles.text}>
        <span className={styles.head}>
          <strong>GitHub for Universe</strong>
          <span className={styles.pill}>
            <i aria-hidden="true" />
            {made ? 'Set up' : 'Not set up'}
          </span>
        </span>
        <small>{made ? 'Everyone can connect GitHub in Apps.' : 'Press Create on GitHub, once. After that everyone can connect GitHub in Apps.'}</small>
      </span>
      <ChevronRight size={20} className={styles.chevron} aria-hidden="true" />
    </Link>
  );
}
