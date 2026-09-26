import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getViewer, unauthorizedResponse } from '@/lib/access-scope';
import { LANDING_ROOM_MESSAGES, landingRoomForUniverse, landingRoomForWorld } from '@/lib/landing-room';

const querySchema = z.union([
  z.object({ universeId: z.string().uuid(), worldId: z.undefined() }),
  z.object({ worldId: z.string().uuid(), universeId: z.undefined() }),
]);

// GET /api/admin/landing-room?universeId=… | ?worldId=… - the room "Visit" goes to (see lib/landing-room.ts).
export async function GET(request: NextRequest) {
  const viewer = await getViewer(request);
  if (!viewer) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const query = querySchema.safeParse({
    universeId: searchParams.get('universeId') ?? undefined,
    worldId: searchParams.get('worldId') ?? undefined,
  });
  if (!query.success) return NextResponse.json({ error: 'Give a universeId or a worldId' }, { status: 400 });

  const landing = query.data.universeId !== undefined
    ? await landingRoomForUniverse(viewer, query.data.universeId)
    : await landingRoomForWorld(viewer, query.data.worldId);

  if (landing.ok) return NextResponse.json({ roomUrl: landing.roomUrl });
  if (landing.reason === 'not-found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(
    { reason: landing.reason, message: LANDING_ROOM_MESSAGES[landing.reason] },
    { status: landing.reason === 'no-access' ? 403 : 404 },
  );
}
