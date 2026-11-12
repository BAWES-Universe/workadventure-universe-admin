import { NextRequest } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { asOwner, notFound, optionsFor } from '@/lib/computer-api';
import { watchComputer } from '@/lib/computer';

export const runtime = 'nodejs';
export const OPTIONS = optionsFor;

/**
 * POST /api/bricks/:id/computer/watch
 * The screen of a computer that is working (game #2000). It only looks and never wakes a machine: a computer that rests, a job that
 * is over, an old link, a refresh or a reconnect get `resting` and wake nothing. The link expires.
 */
export const POST = (request: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
  asOwner(request, params, async (id, ownerId) => {
    const watched = await watchComputer(id, ownerId);
    if (watched.ok) return brickJson(request, { url: watched.url, expiresAt: watched.expiresAt });
    return watched.reason === 'not_found' ? notFound(request) : brickJson(request, { error: 'Its computer is resting', resting: true }, 409);
  });
