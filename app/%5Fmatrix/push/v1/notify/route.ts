import { NextRequest, NextResponse } from 'next/server';
import { handleGatewayNotification } from '@/lib/push-gateway';

export const runtime = 'nodejs';

/**
 * POST /_matrix/push/v1/notify - Synapse's HTTP pushers post here (the folder is `%5Fmatrix` because Next keeps
 * folders starting with `_` out of the routes). Only a device's own secret gets anything sent; see lib/push-gateway.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ errcode: 'M_NOT_JSON', error: 'Invalid JSON body' }, { status: 400 });
  }
  try {
    const answer = await handleGatewayNotification(body);
    if (!answer) return NextResponse.json({ errcode: 'M_BAD_JSON', error: 'Expected { notification }' }, { status: 400 });
    return NextResponse.json(answer);
  } catch (error) {
    console.error('[Push] Gateway failed:', error instanceof Error ? error.message : 'unknown');
    // Synapse tries again later on a server error
    return NextResponse.json({ errcode: 'M_UNKNOWN', error: 'Internal server error' }, { status: 500 });
  }
}
