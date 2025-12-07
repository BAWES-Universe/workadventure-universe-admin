import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/lib/auth';

import { parsePlayUri } from '@/lib/utils';

import { prisma } from '@/lib/db';

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
    
    const wokaList: WokaList = {
      woka: {
        collections: [
          {
            name: "Default",
            textures: [
              {
                id: "male1",
                name: "Male 1",
                url: `${playServiceUrl}/resources/characters/pipoya/Male 01-1.png`,
                layer: [],
              },
              {
                id: "male2",
                name: "Male 2",
                url: `${playServiceUrl}/resources/characters/pipoya/Male 02-2.png`,
                layer: [],
              },
              {
                id: "female1",
                name: "Female 1",
                url: `${playServiceUrl}/resources/characters/pipoya/Female 01-1.png`,
                layer: [],
              },
              {
                id: "female2",
                name: "Female 2",
                url: `${playServiceUrl}/resources/characters/pipoya/Female 02-2.png`,
                layer: [],
              },
            ],
          },
        ],
      },
      body: {
        collections: [],
      },
      eyes: {
        collections: [],
      },
      hair: {
        collections: [],
      },
      clothes: {
        collections: [],
      },
      hat: {
        collections: [],
      },
      accessory: {
        collections: [],
      },
    };
    
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

