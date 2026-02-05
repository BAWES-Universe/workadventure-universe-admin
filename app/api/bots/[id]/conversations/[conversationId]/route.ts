import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/:botId/conversations/:conversationId
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * PUT /api/bots/:botId/conversations/:conversationId
 * Update existing conversation by ID
 * 
 * Auth: BOT_SERVICE_TOKEN
 * 
 * Request body:
 * {
 *   "messages": [...],           // Updated message array
 *   "messageCount": 5,           // Updated message count
 *   "endedAt": 1704067800000,    // Optional: if provided and > startedAt, marks conversation as completed
 *   "endReason": "user_left"     // Optional: reason for ending conversation
 * }
 * 
 * Response: { status: "updated" }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; conversationId: string }> }
) {
  try {
    requireServiceToken(request);

    const { id: botId, conversationId } = await params;
    const body = await request.json();

    const {
      messages,
      messageCount,
      endedAt,
      endReason,
    } = body;

    // Validate required fields
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: 'Missing required field: messages' },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Convert conversationId to number
    const conversationIdNum = parseInt(conversationId, 10);
    if (isNaN(conversationIdNum)) {
      return NextResponse.json(
        { error: 'Invalid conversation ID' },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Check if conversation exists and belongs to the bot
    const existingConversation = await prisma.botsConversation.findFirst({
      where: {
        id: conversationIdNum,
        botId,
      },
      select: { id: true, startedAt: true, endedAt: true },
    });

    if (!existingConversation) {
      console.error(`Conversation ${conversationIdNum} not found for bot ${botId}`);
      
      // Additional debugging: Check if conversation exists at all
      const anyConversation = await prisma.botsConversation.findFirst({
        where: { id: conversationIdNum },
        select: { id: true, botId: true, userUuid: true },
      });
      
      if (anyConversation) {
        console.error(`Conversation ${conversationIdNum} exists but belongs to bot ${anyConversation.botId}, not ${botId}`);
      } else {
        console.error(`Conversation ${conversationIdNum} does not exist in database at all`);
      }
      
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404, headers: corsHeaders() }
      );
    }

    // Prepare update data
    const updateData: any = {
      messages: messages,
      messageCount: messageCount || messages.length,
    };

    // Handle conversation completion
    if (endedAt) {
      const endedAtDate = new Date(endedAt);
      const startedAtDate = existingConversation.startedAt;
      
      // Only set endedAt if it's greater than startedAt (marks as completed)
      if (endedAtDate > startedAtDate) {
        updateData.endedAt = endedAtDate;
        if (endReason) {
          updateData.endReason = endReason;
        }
      }
    }

    // Update the conversation
    await prisma.botsConversation.update({
      where: { id: conversationIdNum },
      data: updateData,
    });

    console.log(`Successfully updated conversation ${conversationIdNum} for bot ${botId}`);

    return NextResponse.json(
      { status: 'updated' },
      { headers: corsHeaders() }
    );
  } catch (error: any) {
    if (error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error updating conversation:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}