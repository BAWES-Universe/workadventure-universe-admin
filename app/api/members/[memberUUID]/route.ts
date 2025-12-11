import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { MemberData } from '@/types/workadventure';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ memberUUID: string }> }
) {
  try {
    requireAuth(request);
    
    const { memberUUID: memberUUIDRaw } = await params;
    // Decode URL-encoded characters (e.g., %40 for @)
    const memberUUID = decodeURIComponent(memberUUIDRaw);
    
    // Find user
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { uuid: memberUUID },
          { email: memberUUID },
        ],
      },
    });
    
    if (!user) {
      return NextResponse.json(
        { error: 'Member not found' },
        { status: 404 }
      );
    }
    
    // Return format expected by WorkAdventure: id (not uuid), and chatID
    // Tags are only in /api/room/access, not in /api/members/{uuid}
    const memberData = {
      id: user.uuid, // WorkAdventure expects 'id' not 'uuid'
      name: user.name || undefined,
      email: user.email || undefined,
      visitCardUrl: null,
      chatID: user.matrixChatId || null, // Matrix chat ID (capital ID)
    };
    
    return NextResponse.json(memberData);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/members/[memberUUID]:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

