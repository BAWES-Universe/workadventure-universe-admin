import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    requireAuth(request);
    
    const body = await request.json();
    const { reportedUserUuid, reportedUserComment, reporterUserUuid, reportWorldSlug } = body;
    
    if (!reportedUserUuid || !reporterUserUuid || !reportWorldSlug) {
      return NextResponse.json(
        { error: 'reportedUserUuid, reporterUserUuid, and reportWorldSlug are required' },
        { status: 400 }
      );
    }
    
    // Parse world slug (format: /@/universeSlug/worldSlug/roomSlug)
    const { universe, world } = parsePlayUri(reportWorldSlug.startsWith('http') 
      ? reportWorldSlug 
      : `http://play.workadventure.localhost${reportWorldSlug}`);
    
    // Find reported user
    const reportedUser = await prisma.user.findFirst({
      where: {
        OR: [
          { uuid: reportedUserUuid },
          { email: reportedUserUuid },
        ],
      },
    });
    
    // Find reporter user
    const reporterUser = await prisma.user.findFirst({
      where: {
        OR: [
          { uuid: reporterUserUuid },
          { email: reporterUserUuid },
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
    
    // Log the report (you might want to create a Report model in Prisma)
    console.log('User report:', {
      reportedUser: reportedUser?.uuid,
      reporterUser: reporterUser?.uuid,
      world: worldData?.slug,
      comment: reportedUserComment,
      timestamp: new Date().toISOString(),
    });
    
    // TODO: Create a Report model in Prisma to store reports
    // For now, we just log it
    
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/report:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

