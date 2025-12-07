import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/lib/auth';

import { parsePlayUri } from '@/lib/utils';

import { prisma } from '@/lib/db';

import { getWokaList } from '@/lib/wokas';

import type { WokaList } from '@/types/workadventure';

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
    
    // Get your play service URL (or use WorkAdventure CDN)
    const playServiceUrl = process.env.PLAY_URL || 'http://play.workadventure.localhost';
    
    // Load wokas from the default woka.json file
    const wokaList: WokaList = getWokaList(playServiceUrl);
    
    return NextResponse.json(wokaList);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/woka/list:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

