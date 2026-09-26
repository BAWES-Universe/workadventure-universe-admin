import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getViewer, unauthorizedResponse } from '@/lib/access-scope';
import { resolveNavigateIntent } from '@/lib/orbit-bridge-server';

const bodySchema = z.object({
  intent: z.string().min(1).max(64),
  params: z.record(z.string().max(64), z.string().max(256)).optional(),
});

// POST /api/orbit-bridge/resolve - the Orbit page for a page request from the game (see lib/orbit-bridge.ts).
// Always answers with a page: anything unknown or not allowed is Orbit's home.
export async function POST(request: NextRequest) {
  const viewer = await getViewer(request);
  if (!viewer) return unauthorizedResponse();

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ path: '/admin' });

  const path = await resolveNavigateIntent(viewer, body.data.intent, body.data.params);
  return NextResponse.json({ path });
}
