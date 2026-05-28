/**
 * GET /api/companion/list?roomUrl=...&uuid=...
 *
 * Returns all companion textures the player can access, based on
 * the avatar catalog's scope + entitlement resolution.
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
      const parts = roomUrl.replace(/^\/@\//, '').split('/');
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

    // Query catalog for companion textures
    const scopeFilter: Record<string, unknown>[] = [{ scopeType: 'platform' }];
    if (universeId) scopeFilter.push({ scopeType: 'universe', scopeId: universeId });
    if (worldId) scopeFilter.push({ scopeType: 'world', scopeId: worldId });

    const sets = await prisma.avatarSet.findMany({
      where: {
        lifecycle: 'active',
        visibility: { in: ['public', 'restricted', 'hidden', 'assigned_only'] },
        companions: { some: { isActive: true } },
        scopes: { some: { OR: scopeFilter } },
      },
      select: {
        name: true,
        companions: {
          where: { isActive: true },
          select: { textureId: true, name: true, url: true, behavior: true },
          orderBy: { position: 'asc' },
        },
      },
      orderBy: { position: 'asc' },
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