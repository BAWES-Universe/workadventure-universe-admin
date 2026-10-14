/**
 * GET /api/companion/list?roomUrl=...&uuid=...
 *
 * Returns the companion textures the player can wear here: the same check saving a companion uses
 * (scope, entitlement, dates). `uuid` is the player's uuid, or their email when signed in.
 *
 * Called by the WA play server's AdminCompanionService when the
 * "api/companion/list" capability is set to "v1".
 *
 * Response format: CompanionTextureCollection[] from WA protobuf:
 *   Array<{ name: string, textures: Array<{ id, name, url, behavior? }> }>
 *
 * Falls back to static config/companions.json if no catalog sets exist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getCompanions } from '@/lib/wokas';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { wearableSetsHere } from '@/lib/woka-wearable';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);

    const { searchParams } = new URL(request.url);
    const roomUrl = searchParams.get('roomUrl');
    const uuid = searchParams.get('uuid');

    if (!roomUrl) {
      return NextResponse.json({ error: 'roomUrl is required' }, { status: 400 });
    }

    // Resolve world/universe from roomUrl
    let worldId: string | null = null;
    let universeId: string | null = null;

    try {
      // Either the room's address (http://play.../@/universe/world/room) or just its path (/@/universe/world/room)
      const path = /^https?:\/\//.test(roomUrl) ? new URL(roomUrl).pathname : roomUrl;
      const parts = path.replace(/^\/@\//, '').split('/').map(decodeURIComponent);
      if (parts.length >= 2) {
        const world = await prisma.world.findFirst({
          where: {
            slug: parts[1],
            universe: { slug: parts[0] },
          },
          select: { id: true, universeId: true },
        });
        if (world) {
          worldId = world.id;
          universeId = world.universeId;
        }
      }
    } catch {
      // Non-fatal — fall through to platform-scope sets
    }

    // Check if catalog has any active sets
    const catalogCount = await prisma.avatarSet.count({ where: { lifecycle: 'active' } });

    if (catalogCount === 0) {
      // Fallback to static companions.json
      const playServiceUrl = process.env.PLAY_URL || 'http://play.workadventure.localhost';
      const companions = getCompanions(playServiceUrl);
      return NextResponse.json(companions);
    }

    // The same sets saving allows for this person here, so every companion listed can be saved: members-only ones only
    // for members, nothing hidden, invite-only (unless granted to them) or outside its dates.
    const person = uuid ? await findUserByIdentifier(uuid) : null;
    const member =
      person && worldId
        ? await prisma.worldMember.findUnique({ where: { userId_worldId: { userId: person.id, worldId } }, select: { tags: true } })
        : null;
    const allowed = await wearableSetsHere({ worldId, universeId, userId: person?.id ?? null, membershipTags: member?.tags ?? [] });
    const seen = new Set<string>();
    const sets = allowed.filter((set) => {
      if (set.companions.length === 0 || seen.has(set.id)) return false;
      seen.add(set.id);
      return true;
    });

    if (sets.length === 0) {
      // Fallback
      const playServiceUrl = process.env.PLAY_URL || 'http://play.workadventure.localhost';
      const companions = getCompanions(playServiceUrl);
      return NextResponse.json(companions);
    }

    // Group by set name into CompanionTextureCollection format
    const result = sets.map(set => ({
      name: set.name,
      textures: set.companions.map(c => ({
        id: c.textureId,
        name: c.name ?? c.textureId,
        url: c.url,
        ...(c.behavior ? { behavior: c.behavior } : {}),
      })),
    }));

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error in /api/companion/list:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}