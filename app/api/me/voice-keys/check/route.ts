import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { loadVoiceKeyModels } from '@/lib/voice-key-check';
import { isOwnSpeechAdapter, loadOwnSpeechServer } from '@/lib/voice-own-server';
import { voiceKeyCompanies } from '@/lib/voice-keys';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

const STATUS = { refused: 422, unreachable: 502, 'bad-request': 400, 'no-models': 409 } as const;

/**
 * POST /api/me/voice-keys/check { adapter, apiKey, address?, region? } - "Load models" for a voice key (#749): one free, authenticated call to the
 * company with the pasted key, to see that it accepts it. Nothing is saved, transcribed or spoken, so nothing is billed, and the
 * key is never logged or returned. Answers 200 `{ ok: true, models }`: for each job the company lists models for, the ones it lists
 * for this key; otherwise the ones the server's own providers for that company list (`[{ id, label?, kind: "recognition" | "speech" | "talk" }]`, each kind and id once; none and `typed: true` for a company whose
 * model is typed, like an Azure deployment, checked on the person's own `address`), or `{ error }` with a plain sentence: 422 the company
 * didn't accept the key, 502 it couldn't be reached (timeout or any other answer), 400 the company or key isn't usable, 409 the
 * company has no models set up, 429 too many tries (the same limit as the text keys' checks).
 *
 * For a speech server on the person's own computer (adapter `openai-compatible`, game #1874) the body also has `address` (https, a name,
 * never a private network) and `apiKey` is optional. The answer is `{ ok: true, models, unsure, voices }`: `models` the ones the server
 * says do a job, `unsure` the ids it lists without saying (the person picks), `voices` how many it lists or null. A private address is
 * 400, a server that doesn't answer 502, a key it turns away 422.
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return respond(request, { error: 'Expected an object' }, 400);
  if (!allowKeyAttempt(user.id)) return respond(request, { error: 'Too many tries. Wait a minute and try again.' }, 429);
  const input = body as { adapter?: unknown; apiKey?: unknown; address?: unknown; region?: unknown };
  try {
    if (isOwnSpeechAdapter(input.adapter)) {
      const own = await loadOwnSpeechServer(input.address, input.apiKey);
      if (!own.ok) return respond(request, { error: own.message }, STATUS[own.reason]);
      return respond(request, { ok: true, models: own.models, unsure: own.unsure, voices: own.voices });
    }
    const result = await loadVoiceKeyModels(input.adapter, input.apiKey, (await voiceKeyCompanies()).map((company) => company.adapter), input.address, input.region);
    if (!result.ok) return respond(request, { error: result.message }, STATUS[result.reason]);
    return respond(request, { ok: true, models: result.models, ...(result.typed ? { typed: true } : {}) });
  } catch (error) {
    console.error('[VoiceKeys] Load models failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Something went wrong on our side. Try again.' }, 500);
  }
}
