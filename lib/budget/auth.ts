import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

/** The Budget page and everything behind it is a super admin's: nobody else reads a number or sees a Save. */
export async function superAdmin(request: NextRequest) {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? user : null;
}

export const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
