import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { pickTemplate } from '@/lib/brick-template-use';

export const runtime = 'nodejs';

async function superAdmin(request: NextRequest) {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? user : null;
}
const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

async function setPick(request: NextRequest, params: Promise<{ id: string }>, picked: boolean) {
  try {
    const user = await superAdmin(request);
    if (!user) return refused();
    const { id } = await params;
    const answer = await pickTemplate(id, user.id, picked);
    if (answer === 'not_found') return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    if (answer === 'not_for_everyone') return NextResponse.json({ error: 'Only a template shared with everyone can be picked' }, { status: 409 });
    return NextResponse.json({ picked });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error picking a template:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** PUT /api/admin/brick-templates/:id/pick - Universe picks a template for the "a few picks" list (game #2008). Super admin only. A new version waits to be picked again. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return setPick(request, params, true);
}

/** DELETE /api/admin/brick-templates/:id/pick - takes it off the picks. Super admin only. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return setPick(request, params, false);
}
