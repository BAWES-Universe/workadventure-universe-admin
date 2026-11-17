import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { deleteResult } from '@/lib/owned-results';
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

/**
 * DELETE /api/workbench/outputs/:id
 * The owner deleting one of their result files. The stored file goes first and the record after, so a file that could not be removed is still listed
 * and can be tried again. An Artifact made from it is a separate thing and stays. Anyone else, and a file that has gone, get the same 404.
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { id } = await context.params;
  try {
    return (await deleteResult(id, user.id)) === 'deleted' ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    console.error('[Results] A file could not be removed yet:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'The file could not be removed right now. It is still listed; try again.' }, { status: 502 });
  }
}
