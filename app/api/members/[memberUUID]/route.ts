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
    
    const { memberUUID } = await params;
    
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
    
    // Get first world membership for tags (or empty array)
    const membership = await prisma.worldMember.findFirst({
      where: {
        userId: user.id,
      },
    });
    
    const memberData: MemberData = {
      uuid: user.uuid,
      name: user.name || undefined,
      email: user.email || undefined,
      tags: membership?.tags || [],
      visitCardUrl: null,
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

