import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import type { CompanionTextureCollectionList } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const roomUrl = searchParams.get('roomUrl');
    const uuid = searchParams.get('uuid');
    
    if (!roomUrl || !uuid) {
      return NextResponse.json(
        { error: 'roomUrl and uuid are required' },
        { status: 400 }
      );
    }
    
    // Default companion list - you can customize this based on your needs
    const companionList: CompanionTextureCollectionList = [
      {
        name: "Pets",
        textures: [
          {
            id: "dog1",
            url: "https://example.com/companions/dog1.png",
          },
          {
            id: "cat1",
            url: "https://example.com/companions/cat1.png",
          },
        ],
      },
    ];
    
    return NextResponse.json(companionList);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/companion/list:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

