import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import { getPlayOrigin, requestOrigin } from '@/lib/origin-policy';
import {
  PREFERENCE_VALUE_MAX_BYTES,
  isAllowedPreferenceKey,
  preferenceValueSize,
} from '@/lib/user-preferences';

export const runtime = 'nodejs';

/** Orbit's own origin and the game's exact origin; never `*`. */
function allowedOrigins(request: NextRequest): string[] {
  const origins: string[] = [];
  const own = resolveExpectedLoginOrigin(process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL, '');
  if (own) origins.push(own);
  else if (process.env.NODE_ENV !== 'production') origins.push(request.nextUrl.origin);
  try {
    origins.push(getPlayOrigin());
  } catch {
    // Missing play origin in production: only Orbit itself may call.
  }
  return origins;
}

/** No Origin header (same-origin GET) is allowed; a present Origin must be on the list. */
function originAllowed(request: NextRequest): boolean {
  if (!request.headers.get('origin')) return true;
  const origin = requestOrigin(request);
  return origin !== null && allowedOrigins(request).includes(origin);
}

function respond(request: NextRequest, body: unknown, status = 200) {
  const result = status === 204 ? new NextResponse(null, { status }) : NextResponse.json(body, { status });
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('Vary', 'Origin');
  const origin = requestOrigin(request);
  if (origin && allowedOrigins(request).includes(origin)) {
    result.headers.set('Access-Control-Allow-Origin', origin);
    result.headers.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    result.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  return result;
}

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && originAllowed(request) ? 204 : 403);
}

// GET /api/me/preferences[?key=] - the caller's own preferences
export async function GET(request: NextRequest) {
  if (!originAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  const key = request.nextUrl.searchParams.get('key');
  if (key !== null && !isAllowedPreferenceKey(key)) {
    return respond(request, { error: 'Unknown preference key' }, 400);
  }

  try {
    const rows = await prisma.userPreference.findMany({
      where: key === null ? { userId: user.id } : { userId: user.id, key },
      select: { key: true, value: true },
    });
    const preferences: Record<string, unknown> = {};
    for (const row of rows) preferences[row.key] = row.value;
    return respond(request, { preferences });
  } catch (error) {
    console.error('[Preferences] Read failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

// PUT /api/me/preferences { key, value } - upsert one of the caller's own preferences
export async function PUT(request: NextRequest) {
  if (!originAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return respond(request, { error: 'Expected { key, value }' }, 400);
  }
  const { key, value } = body as { key?: unknown; value?: unknown };
  if (!isAllowedPreferenceKey(key)) return respond(request, { error: 'Unknown preference key' }, 400);
  if (value === undefined || value === null) return respond(request, { error: 'Preference value required' }, 400);

  const size = preferenceValueSize(value);
  if (size === null) return respond(request, { error: 'Preference value must be JSON' }, 400);
  if (size > PREFERENCE_VALUE_MAX_BYTES) {
    return respond(request, { error: `Preference value exceeds ${PREFERENCE_VALUE_MAX_BYTES} bytes` }, 413);
  }

  try {
    const jsonValue = value as Prisma.InputJsonValue;
    const saved = await prisma.userPreference.upsert({
      where: { userId_key: { userId: user.id, key } },
      create: { userId: user.id, key, value: jsonValue },
      update: { value: jsonValue },
      select: { key: true, value: true, updatedAt: true },
    });
    return respond(request, saved);
  } catch (error) {
    console.error('[Preferences] Write failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
