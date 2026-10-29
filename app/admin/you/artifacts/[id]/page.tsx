'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArtifactBox } from '@/components/public-artifact';
import { authenticatedFetch } from '@/lib/client-auth';
import type { PublicView } from '@/lib/artifact-service';
import passport from '../../../components/passport.module.css';
import styles from '../../you.module.css';

/**
 * One of your artifacts, opened from Your artifacts when Orbit is not in a game that opens it in its window (game #1474):
 * its latest version in the same locked box, view only.
 */
export default function YourArtifactPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<PublicView | 'gone' | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`/api/me/artifacts/${encodeURIComponent(id)}`)
      .then(async (response) => {
        const next = response.ok ? ((await response.json()) as PublicView) : response.status === 404 ? 'gone' : 'failed';
        if (!cancelled) setView(next);
      })
      .catch(() => {
        if (!cancelled) setView('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className={styles.page} data-testid="your-artifact">
      {view === 'gone' && <p className={passport.empty}>This artifact is not there any more.</p>}
      {view === 'failed' && <p className={passport.empty}>This artifact could not be loaded. Try again in a moment.</p>}
      {view !== null && typeof view === 'object' && (
        <div className="flex min-h-[70dvh] flex-col gap-4">
          <ArtifactBox view={view} />
        </div>
      )}
    </div>
  );
}
