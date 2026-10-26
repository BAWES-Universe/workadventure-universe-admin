import type { Metadata } from 'next';
import * as Sentry from '@sentry/nextjs';
import { LinkNotAvailable, PublicArtifact } from '@/components/public-artifact';
import { ArtifactError } from '@/lib/artifacts';
import { openByLink, type PublicView } from '@/lib/artifact-service';
import { getPlayOrigin } from '@/lib/origin-policy';

/** Never kept: the moment the owner switches the link off, this address stops showing it. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Universe',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * /a/:id — the page "Anyone with the link" opens (Orbit #650). No sign-in: the latest version in the locked box, view only, and a
 * small "Made with Universe" pill. Not shared by link, run out, deleted or never there: "This link is not available".
 */
async function load(id: string): Promise<PublicView | 'gone' | 'broken'> {
  try {
    return await openByLink(id);
  } catch (error) {
    if (error instanceof ArtifactError && error.code === 'not_found') return 'gone';
    // Never the content: only that it broke
    Sentry.captureException(error, { tags: { area: 'artifacts', route: 'GET /a/:id' } });
    console.error('Error in GET /a/:id:', error instanceof Error ? error.message : 'unknown');
    return 'broken';
  }
}

export default async function PublicArtifactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const universeUrl = getPlayOrigin();
  const found = await load(id);
  if (found === 'gone') return <LinkNotAvailable universeUrl={universeUrl} />;
  if (found === 'broken') return <LinkNotAvailable universeUrl={universeUrl} tryAgain />;
  return <PublicArtifact view={found} universeUrl={universeUrl} />;
}
