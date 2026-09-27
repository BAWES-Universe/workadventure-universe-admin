import { redirect } from 'next/navigation';

/** Preserve links and bookmarks from the first Orbit shell. */
export default async function PlacesRedirect({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  redirect(tab === 'explore' ? '/admin/spaces?tab=explore' : '/admin/spaces');
}
