import { NextRequest, NextResponse } from 'next/server';
import { overview } from '@/lib/grants-admin';
import { refuseUnauthorized, refusal, serverError, superAdminOf } from '@/lib/grants-route';

export const runtime = 'nodejs';

/** GET /api/admin/grants - what Universe gives people (super admin): the defaults, the exceptions and the gifts, as the Grants page shows them. */
export async function GET(request: NextRequest) {
  if (!(await superAdminOf(request))) return refuseUnauthorized();
  try {
    return NextResponse.json(await overview());
  } catch (error) {
    return refusal(error) ?? serverError('read the grants', error);
  }
}
