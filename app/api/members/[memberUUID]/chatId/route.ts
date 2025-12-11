import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ memberUUID: string }> }
) {
  try {
    requireAuth(request);
    
    const { memberUUID: userIdentifier } = await params;
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

