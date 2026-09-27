import { redirect } from 'next/navigation';

/** Your profile (once called the visit card) is edited in place on You. */
export default function ProfileRedirect() {
  redirect('/admin/you?edit=profile');
}
