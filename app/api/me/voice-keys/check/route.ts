import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { loadVoiceKeyModels } from '@/lib/voice-key-check';
import { voiceKeyCompanies } from '@/lib/voice-keys';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

const STATUS = { refused: 422, unreachable: 502, 'bad-request': 400, 'no-models': 409 } as const;

/**
 * POST /api/me/voice-keys/check { adapter, apiKey } - "Load models" for a voice key (#749): one free, authenticated call to the
 * company with the pasted key, to see that it accepts it. Nothing is saved, transcribed or spoken, so nothing is billed, and the
 * key is never logged or returned. Answers 200 `{ ok: true, models }`, the models the server's own providers for that company list
 * (`[{ id, label?, kind: "recognition" | "speech" }]`, each kind and id once), or `{ error }` with a plain sentence: 422 the company
 * didn't accept the key, 502 it couldn't be reached (timeout or any other answer), 400 the company or key isn't usable, 409 the
 * company has no models set up, 429 too many tries (the same limit as the text keys' checks).
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return respond(request, { error: 'Expected an object' }, 400);
  if (!allowKeyAttempt(user.id)) return respond(request, { error: 'Too many tries. Wait a minute and try again.' }, 429);
  const input = body as { adapter?: unknown; apiKey?: unknown };
  try {
    const result = await loadVoiceKeyModels(input.adapter, input.apiKey, (await voiceKeyCompanies()).map((company) => company.adapter));
    if (!result.ok) return respond(request, { error: result.message }, STATUS[result.reason]);
    return respond(request, { ok: true, models: result.models });
  } catch (error) {
    console.error('[VoiceKeys] Load models failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Something went wrong on our side. Try again.' }, 500);
  }
}
