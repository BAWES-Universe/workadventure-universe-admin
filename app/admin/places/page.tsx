import { redirect } from 'next/navigation';

/** Links and bookmarks from the first Orbit shell land on Space. */
export default function PlacesRedirect() {
  redirect('/admin/space');
}
