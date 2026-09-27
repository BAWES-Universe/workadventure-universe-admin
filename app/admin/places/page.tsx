import { redirect } from 'next/navigation';

/** Links and bookmarks from the first Orbit shell land on Space. */
export default async function PlacesRedirect({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  redirect(tab === 'explore' ? '/admin/space?tab=explore' : '/admin/space');
}
