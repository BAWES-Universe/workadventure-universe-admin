import { NextRequest, NextResponse } from 'next/server';
import {
  getAllowedMobileRedirectUris,
  getMobileRedirectUri,
  validateOptionalRedirectUri,
} from '../redirect-uri';

export function GET() {
  return NextResponse.json({
    mobileRedirectUri: getMobileRedirectUri(),
    allowedRedirectUris: getAllowedMobileRedirectUris(),
  });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Request body must be JSON' },
      { status: 400 }
    );
  }

  const validation = validateOptionalRedirectUri(body.redirectUri ?? body.redirect_uri);

  if (!validation.valid) {
    return NextResponse.json(
      {
        error: validation.error,
        allowedRedirectUris: validation.allowedRedirectUris,
      },
      { status: 400 }
    );
  }

  if (!validation.redirectUri) {
    return NextResponse.json(
      {
        error: 'redirectUri is required',
        allowedRedirectUris: getAllowedMobileRedirectUris(),
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    valid: true,
    redirectUri: validation.redirectUri,
  });
}
