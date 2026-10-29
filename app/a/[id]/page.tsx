import type { Metadata } from 'next';
import { cache } from 'react';
import * as Sentry from '@sentry/nextjs';
import { LinkNotAvailable, PublicArtifact } from '@/components/public-artifact';
import { artifactKindName } from '@/lib/artifact-labels';
import { ArtifactError } from '@/lib/artifacts';
import { openByLink, type PublicView } from '@/lib/artifact-service';
import { getPlayOrigin } from '@/lib/origin-policy';

/** Never kept: the moment the owner switches the link off, this address stops showing it. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PRIVATE: Pick<Metadata, 'robots' | 'referrer'> = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

/**
 * The tab icon: the Universe mark the game's own tab shows (the same files as the room metatags), in place of Orbit's
 * leftover default. An artifact has no picture of its own, so every shared page, available or not, shows this one.
 */
const ICONS: Pick<Metadata, 'icons'> = {
  icons: {
    icon: { url: '/assets/favicon-trans-512x512.png', sizes: '512x512', type: 'image/png' },
    // iPhone and iPad paint a see-through icon on black, so this one is the mark on Universe ink
    apple: { url: '/assets/apple-touch-icon-180x180.png', sizes: '180x180' },
  },
};

/**
 * /a/:id — the page "Anyone with the link" opens (Orbit #650, #711). No sign-in: the latest version filling the window,
 * view only, and a small floating "Made with Universe" pill. Not shared by link, run out, deleted or never there: "This
 * link is not available".
 */
const load = cache(async (id: string): Promise<PublicView | 'gone' | 'broken'> => {
  try {
    return await openByLink(id);
  } catch (error) {
    if (error instanceof ArtifactError && error.code === 'not_found') return 'gone';
    // Never the content: only that it broke
    Sentry.captureException(error, { tags: { area: 'artifacts', route: 'GET /a/:id' } });
    console.error('Error in GET /a/:id:', error instanceof Error ? error.message : 'unknown');
    return 'broken';
  }
});

/**
 * What a pasted link previews as (Orbit #712): the artifact's name and "Page by Laura", no content and no image. Only an
 * artifact shared by link gets them, which is what anyone with the address sees anyway; every other link keeps the plain
 * "Universe", so a preview never tells that an artifact is there.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const found = await load(id);
  if (typeof found !== 'object') return { title: 'Universe', ...ICONS, ...PRIVATE };
  const description = `${artifactKindName(found.kind)} by ${found.makerName}`;
  return {
    title: found.title,
    description,
    openGraph: { title: found.title, description },
    ...ICONS,
    ...PRIVATE,
  };
}

export default async function PublicArtifactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const universeUrl = getPlayOrigin();
  const found = await load(id);
  if (found === 'gone') return <LinkNotAvailable universeUrl={universeUrl} />;
  if (found === 'broken') return <LinkNotAvailable universeUrl={universeUrl} tryAgain />;
  return <PublicArtifact view={found} universeUrl={universeUrl} />;
}
