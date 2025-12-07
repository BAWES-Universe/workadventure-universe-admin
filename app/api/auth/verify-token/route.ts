import { NextRequest, NextResponse } from 'next/server';
import { validateAccessToken } from '@/lib/oidc';
import { requireAuth } from '@/lib/auth';

/**
 * Test endpoint to verify OIDC token
 * POST /api/auth/verify-token
 * Body: { "token": "your-oidc-token" }
 * 
 * Or GET with query param:
 * GET /api/auth/verify-token?token=your-oidc-token
 */
export async function POST(request: NextRequest) {
  try {
    requireAuth(request);
    
    const body = await request.json();
    const token = body.token;
    
    if (!token) {
      return NextResponse.json(
        { error: 'Token is required in request body' },
        { status: 400 }
      );
    }
    
    // Decode JWT to see contents (without verification)
    let decodedPayload: any = null;
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = parts[1];
        // Add padding if needed
        const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
        decodedPayload = JSON.parse(Buffer.from(padded, 'base64url').toString());
      }
    } catch (e) {
      // Ignore decode errors
    }
    
    // Validate token with OIDC provider
    const userInfo = await validateAccessToken(token);
    
    return NextResponse.json({
      success: !!userInfo,
      decoded: decodedPayload,
      userInfo: userInfo,
      tokenInfo: decodedPayload ? {
        issuer: decodedPayload.iss,
        subject: decodedPayload.sub,
        audience: decodedPayload.aud,
        expiresAt: decodedPayload.exp ? new Date(decodedPayload.exp * 1000).toISOString() : null,
        issuedAt: decodedPayload.iat ? new Date(decodedPayload.iat * 1000).toISOString() : null,
        email: decodedPayload.email,
        name: decodedPayload.name,
        groups: decodedPayload.groups,
        scopes: decodedPayload.scope,
      } : null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error verifying token:', error);
    return NextResponse.json(
      { 
        error: 'Failed to verify token',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');
    
    if (!token) {
      return NextResponse.json(
        { error: 'Token is required as query parameter: ?token=your-token' },
        { status: 400 }
      );
    }
    
    // Decode JWT to see contents (without verification)
    let decodedPayload: any = null;
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = parts[1];
        // Add padding if needed
        const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
        decodedPayload = JSON.parse(Buffer.from(padded, 'base64url').toString());
      }
    } catch (e) {
      // Ignore decode errors
    }
    
    // Validate token with OIDC provider
    const userInfo = await validateAccessToken(token);
    
    return NextResponse.json({
      success: !!userInfo,
      decoded: decodedPayload,
      userInfo: userInfo,
      tokenInfo: decodedPayload ? {
        issuer: decodedPayload.iss,
        subject: decodedPayload.sub,
        audience: decodedPayload.aud,
        expiresAt: decodedPayload.exp ? new Date(decodedPayload.exp * 1000).toISOString() : null,
        issuedAt: decodedPayload.iat ? new Date(decodedPayload.iat * 1000).toISOString() : null,
        email: decodedPayload.email,
        name: decodedPayload.name,
        groups: decodedPayload.groups,
        scopes: decodedPayload.scope,
      } : null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error verifying token:', error);
    return NextResponse.json(
      { 
        error: 'Failed to verify token',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

