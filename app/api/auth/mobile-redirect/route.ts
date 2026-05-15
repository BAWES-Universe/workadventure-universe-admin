import { NextRequest, NextResponse } from 'next/server';
import {
  getAllowedMobileRedirectUris,
  getMobileRedirectUri,
  validateOptionalRedirectUri,
} from '../redirect-uri';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);

  Object.entries(corsHeaders()).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
}

export function OPTIONS() {
  return jsonResponse({});
}

export function GET() {
  return jsonResponse({
    mobileRedirectUri: getMobileRedirectUri(),
    allowedRedirectUris: getAllowedMobileRedirectUris(),
  });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: 'Request body must be JSON' },
      { status: 400 }
    );
  }

  const validation = validateOptionalRedirectUri(body.redirectUri ?? body.redirect_uri);

  if (!validation.valid) {
    return jsonResponse(
      {
        error: validation.error,
        allowedRedirectUris: validation.allowedRedirectUris,
      },
      { status: 400 }
    );
  }

  if (!validation.redirectUri) {
    return jsonResponse(
      {
        error: 'redirectUri is required',
        allowedRedirectUris: getAllowedMobileRedirectUris(),
      },
      { status: 400 }
    );
  }

  return jsonResponse({
    valid: true,
    redirectUri: validation.redirectUri,
  });
}
