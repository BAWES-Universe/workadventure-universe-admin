import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { listResults } from '@/lib/owned-results';

export const runtime = 'nodejs';

/**
 * GET /api/workbench/outputs?limit=50&before=<time>
 * The result files that jobs made for the person signed in, newest first: what each is, which job and Brick made it ("A deleted Brick" once that
 * Brick is gone), who may open it (only them) and how much they keep in all. Nobody else's are ever listed.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'Sign in to see your files.' }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const limit = Number(params.get('limit') ?? 50);
  const listed = await listResults(user.id, { limit: Number.isFinite(limit) ? limit : 50, before: params.get('before') });
  return NextResponse.json(listed, { headers: { 'cache-control': 'private, no-store' } });
}
