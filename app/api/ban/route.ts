import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, getClientIp } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import type { AdminBannedData } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token'); // userIdentifier
    const ipAddress = searchParams.get('ipAddress') || getClientIp(request);
    const roomUrl = searchParams.get('roomUrl');
    
    if (!token || !roomUrl) {
      return NextResponse.json(
        { error: 'token and roomUrl are required' },
        { status: 400 }
      );
    }
    
    const { universe, world } = parsePlayUri(roomUrl);
    
    // Find user
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { uuid: token },
          { email: token },
        ],
      },
    });
    
    // Find world
    const worldData = await prisma.world.findFirst({
      where: {
        slug: world,
        universe: {
          slug: universe,
        },
      },
    });
    
    // Check for active bans
    const banConditions: any[] = [];
    
    // User or IP condition
    const userOrIpConditions: any[] = [];
    if (user) {
      userOrIpConditions.push({ userId: user.id });
    }
    userOrIpConditions.push({ ipAddress: ipAddress });
    banConditions.push({ OR: userOrIpConditions });
    
    // World/Universe condition
    const worldConditions: any[] = [];
    if (worldData) {
      worldConditions.push({ worldId: worldData.id });
      worldConditions.push({ universeId: worldData.universeId });
    }
    worldConditions.push({ worldId: null, universeId: null }); // Global ban
    banConditions.push({ OR: worldConditions });
    
    // Expiration condition
    banConditions.push({
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    });
    
    const ban = await prisma.ban.findFirst({
      where: {
        isActive: true,
        AND: banConditions,
      },
    });
    
    const response: AdminBannedData = {
      is_banned: !!ban,
      message: ban?.reason || '',
    };
    
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/ban GET:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    requireAuth(request);
    
    const body = await request.json();
    const { uuidToBan, playUri, name, message, byUserUuid } = body;
    
    if (!uuidToBan || !playUri) {
      return NextResponse.json(
        { error: 'uuidToBan and playUri are required' },
        { status: 400 }
      );
    }
    
    const { universe, world } = parsePlayUri(playUri);
    
    // Find user to ban
    const userToBan = await prisma.user.findFirst({
      where: {
        OR: [
          { uuid: uuidToBan },
          { email: uuidToBan },
        ],
      },
    });
    
    if (!userToBan) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }
    
    // Find world
    const worldData = await prisma.world.findFirst({
      where: {
        slug: world,
        universe: {
          slug: universe,
        },
      },
    });
    
    // Find banning user
    let bannedBy = null;
    if (byUserUuid) {
      bannedBy = await prisma.user.findFirst({
        where: {
          OR: [
            { uuid: byUserUuid },
            { email: byUserUuid },
          ],
        },
      });
    }
    
    // Create ban
    const ban = await prisma.ban.create({
      data: {
        userId: userToBan.id,
        worldId: worldData?.id,
        universeId: worldData?.universeId,
        reason: message || 'Banned by administrator',
        bannedById: bannedBy?.id,
        isActive: true,
      },
    });
    
    return NextResponse.json(true);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/ban POST:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

