import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { openOutput } from '@/lib/workbench/executor';

export const runtime = 'nodejs';

/**
 * GET /api/workbench/outputs/:id
 * A file a code job kept, for the person whose job it was (signed in). Anyone else, and a file that has gone, get the same 404. It is always a
 * download, never shown in the page, and sent as the type its name says with sniffing off and no scripts, so a file a script made can never run
 * as part of Orbit.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { id } = await context.params;
  const file = await openOutput(id, user.id);
  if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(Buffer.from(file.bytes), {
    status: 200,
    headers: {
      'content-type': file.contentType,
      'content-length': String(file.bytes.byteLength),
      'content-disposition': `attachment; filename="${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
    },
  });
}
