import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { authorizeModelCall, authorizeStep } from '@/lib/computer-calls';

export const runtime = 'nodejs';

const MICROS = 2_000_000_000;

/** Version 1: today's body. No `contract` field. Orbit holds exactly one amount for the member and for the pool, and answers in the version 1 shapes only. */
const bodyV1 = z
  .object({
    token: z.string().min(1).max(200),
    callId: z.string().min(1).max(80),
    estimateMicros: z.number().int().min(0).max(MICROS),
    payer: z.enum(['universe', 'own-key']),
  })
  .strict();

/** Version 2 (docs/computer-llm-contract-v2.md): `contract: 2`. Unknown fields are refused (strict), so the game sends only these names. */
const bodyV2 = z
  .object({
    contract: z.literal(2),
    token: z.string().min(1).max(200),
    operationId: z.string().min(1).max(80),
    payer: z.enum(['universe', 'own-key']),
    route: z.enum(['universe-ai', 'own-key', 'provider']),
    model: z.string().min(1).max(120).optional(),
    modelFormat: z.enum(['openai', 'gemini-compatible', 'other']).optional(),
    stepKind: z.enum(['reply', 'edit', 'tool', 'vision', 'other']).optional(),
    inputTokens: z.number().int().min(0).max(100_000_000),
    // Null: the relay has no price for this model. A Universe-paid step with no price is refused `unpriced` and nothing is sent
    inputMicros: z.number().int().min(0).max(MICROS).nullable(),
    outputMicrosPerMillion: z.number().int().min(0).max(MICROS).nullable(),
    maxOutputTokens: z.number().int().min(1).max(10_000_000),
    providerMaxMicros: z.number().int().min(0).max(MICROS).nullable().optional(),
  })
  .strict();

/**
 * POST /api/computer/llm/authorize - before a model call a Brick's computer makes: the computer's key is checked against Orbit's records and
 * room for this one call is reserved from the person's computer credit and the pool.
 *
 * Version 1 `{ token, callId, estimateMicros, payer }` answers `{ ok: true, jobId, botId, reservedMicros }` or `{ ok: false, reason: refused | allowance | pool | rule }`.
 * Version 2 (`contract: 2`) sends the step's figures and answers both amounts, the recorded funding authorisation and the Limits, or a typed
 * refusal (see docs/computer-llm-contract-v2.md). A body that is neither is `400 { error: "Invalid input data" }`, which is how an older Orbit
 * answers a version 2 body, so a newer game falls back to version 1 once. Nothing is sent to an AI provider unless the answer says ok. Asked again
 * with the same callId (version 1) or operationId (version 2) it is the same call. Auth: service token only (the computer never calls this).
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => null);
    const wantsV2 = typeof body === 'object' && body !== null && !Array.isArray(body) && 'contract' in body;
    if (wantsV2) {
      const parsed = bodyV2.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
      const { contract: _contract, ...ask } = parsed.data;
      const answer = await authorizeStep(ask);
      return NextResponse.json(answer, { headers: { 'Cache-Control': 'no-store' } });
    }
    const parsed = bodyV1.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const answer = await authorizeModelCall(parsed.data);
    return NextResponse.json(answer, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not authorize a model call:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
