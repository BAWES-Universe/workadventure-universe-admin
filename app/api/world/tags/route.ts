import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

/**
 * GET /api/world/tags
 * 
 * Returns all allowed tags for world/room access rights.
 * Always returns the same three tags regardless of searchText.
 * 
 * Query Parameters:
 * - playUri (required): The full room URL
 * - searchText (optional): Ignored - always returns all tags
 * 
 * Response:
 * - Status: 200 OK
 * - Body: ["admin", "member", "editor"]
 */
export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const playUri = searchParams.get('playUri');
    
    // Validate playUri is provided
    if (!playUri) {
      return NextResponse.json(
        { error: 'playUri is required' },
        { status: 400 }
      );
    }
    
    // Always return all allowed tags, regardless of searchText
    const allowedTags = ["admin", "member", "editor"];
    
    return NextResponse.json(allowedTags);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/world/tags:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

