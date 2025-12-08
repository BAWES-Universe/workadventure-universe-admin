import { NextRequest, NextResponse } from 'next/server';
import type { Capabilities } from '@/types/workadventure';

/**
 * GET /api/capabilities
 * 
 * Public endpoint (no authentication required).
 * Called by WorkAdventure during startup to discover API capabilities.
 * 
 * This endpoint is intentionally public because:
 * - It's called during WorkAdventure startup before authentication is established
 * - It's used for API discovery to determine what features are supported
 */
export async function GET(request: NextRequest) {
  try {
    const capabilities: Capabilities = {
      "api/woka/list": "v1",
      // Disabled as not yet implemented:
      // "api/save-name": "v1",
      // "api/save-textures": "v1",
      // "api/ice-servers": "v1",
    };
    
    return NextResponse.json(capabilities);
  } catch (error) {
    console.error('Error in /api/capabilities:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

