import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { promoteResult } from '@/lib/owned-results';

export const runtime = 'nodejs';

const WHY = {
  not_an_artifact_type: 'Only a web page, a Markdown document or an SVG drawing can become an artifact. This file stays in your files.',
  too_big: 'This file is bigger than an artifact may be.',
  not_text: 'This file is not readable text, so it cannot become an artifact.',
} as const;

/**
 * POST /api/workbench/outputs/:id { title? }
 * The owner publishing one of their results as an artifact: a separate step they take on purpose. The artifact starts "Just you"; who else may open it
 * is their next choice, with the sharing every artifact has. The file stays in their files. Anyone else, and a file that has gone, get the same 404.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
  const title = body && typeof body.title === 'string' ? body.title : null;
  const made = await promoteResult(id, user.id, { title });
  if (made.status === 'refused') return made.reason === 'not_found' ? NextResponse.json({ error: 'Not found' }, { status: 404 }) : NextResponse.json({ error: WHY[made.reason] }, { status: 422 });
  return NextResponse.json({ artifactId: made.artifactId, ...(made.status === 'made' ? { kind: made.kind, openScope: 'me' } : { already: true }) }, { status: made.status === 'made' ? 201 : 200 });
}
