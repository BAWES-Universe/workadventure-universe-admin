import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ memberUUID: string }> }
) {
  try {
    requireAuth(request);
    
    const { memberUUID: userIdentifierRaw } = await params;
    // Decode URL-encoded characters (e.g., %40 for @)
    const userIdentifier = decodeURIComponent(userIdentifierRaw);
    const body = await request.json();
    const { chatId } = body;
    
    if (!chatId) {
      return NextResponse.json(
        { error: 'chatId is required' },
        { status: 400 }
      );
    }
    
    // Find user by UUID or email
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { uuid: userIdentifier },
          { email: userIdentifier },
        ],
      },
    });
    
    if (!user) {
      // Log for debugging
      console.error(`[chatId PUT] User not found for identifier: ${userIdentifier} (raw: ${userIdentifierRaw})`);
      // Try to find any user with similar email to help debug
      const similarUsers = await prisma.user.findMany({
        where: {
          OR: [
            { email: { contains: userIdentifier.split('@')[0] || '', mode: 'insensitive' } },
            { uuid: { contains: userIdentifier.split('@')[0] || '', mode: 'insensitive' } },
          ],
        },
        select: { uuid: true, email: true },
        take: 5,
      });
      if (similarUsers.length > 0) {
        console.error(`[chatId PUT] Found similar users:`, similarUsers);
      }
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }
    
    // Update Matrix chat ID
    await prisma.user.update({
      where: { id: user.id },
      data: { matrixChatId: chatId },
    });
    
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/members/[memberUUID]/chatId:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

