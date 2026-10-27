import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { authorizeBotManager, json } from '@/lib/bot-access-api';
import { USAGE_RANGES, botUsageReport, readTimeZone, type UsageRange } from '@/lib/bot-usage-report';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/:id/usage?range=today|7d|30d&tz=<IANA time zone>
 * How much the bot is used (Orbit #491): replies a day in direct messages and nearby chat, who chatted by name (guests as
 * one count), what it ran on and what that cost, and how many people reached a reply limit. Never what anyone said.
 * Defaults: 7 days, UTC. See lib/bot-usage-report.ts.
 *
 * Auth: whoever manages the bot (its maker, anyone with Manage bots here, the universe's owner, super admins).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const auth = await authorizeBotManager(request, id, { adminTokenReads: false });
    if (auth.response) return auth.response;
    const asked = request.nextUrl.searchParams.get('range') ?? '7d';
    if (!Object.hasOwn(USAGE_RANGES, asked)) return json(request, { error: 'range must be today, 7d or 30d' }, 400);
    const report = await botUsageReport(
      { id: auth.place.id, createdById: auth.place.createdById ?? null },
      { range: asked as UsageRange, timeZone: readTimeZone(request.nextUrl.searchParams.get('tz')), viewerId: auth.viewerId },
    );
    return json(request, report);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bot-usage' } });
    console.error('Error reading bot usage:', error);
    return json(request, { error: 'Failed to read bot usage' }, 500);
  }
}
