import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { answerOffer, claimOffer, offerAnswerSchema, offerSchema, offersSoFar } from '@/lib/brick-offers';

export const runtime = 'nodejs';

function failed(error: unknown, what: string) {
  if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  Sentry.captureException(error, { tags: { area: 'bricks' } });
  console.error(`[Bricks] ${what} failed:`, error instanceof Error ? error.message : 'unknown');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * The gentle offer (game #1996): a Brick may suggest a Brick for a kind of job that keeps coming back, once per topic,
 * and "Not now" holds in every chat and on every device. Orbit keeps what was suggested, on the person's account.
 * Everything here is for the owner of Brick :id only (`userId` is their game uuid or email); for anyone else, and for a
 * room bot, the answer is the same as for a Brick that does not exist.
 *
 * Auth: service token only.
 *
 * GET /api/bots/:id/brick-offers?userId=...
 *   { after, topics: [{ topic, answer }] }  how often a job has to come back, and every topic already suggested
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const userId = request.nextUrl.searchParams.get('userId')?.trim();
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    const answer = await offersSoFar(id, userId);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ after: answer.after, topics: answer.topics });
  } catch (error) {
    return failed(error, 'Reading offers');
  }
}

/**
 * POST /api/bots/:id/brick-offers   { userId, topic }
 *   { show, topic }  `show` is true exactly once per person and topic: only then is the card shown
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const parsed = offerSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await claimOffer(id, parsed.data);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ show: answer.show, topic: answer.topic });
  } catch (error) {
    return failed(error, 'Claiming an offer');
  }
}

/**
 * PUT /api/bots/:id/brick-offers   { userId, topic, answer: "made" | "not_now" }
 *   { kept }  what the person tapped on the card; the first answer stands
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const parsed = offerAnswerSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const answer = await answerOffer(id, parsed.data);
    if (!answer.ok) return NextResponse.json({ error: answer.error }, { status: answer.status });
    return NextResponse.json({ kept: answer.kept });
  } catch (error) {
    return failed(error, 'Keeping an answer');
  }
}
