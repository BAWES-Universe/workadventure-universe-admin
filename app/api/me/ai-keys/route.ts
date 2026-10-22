import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { listAiKeys } from '@/lib/ai-keys';
import { MAX_AI_KEYS } from '@/lib/ai-key-kinds';
import { KEY_CHARACTERS, KEY_LOOKS_WRONG, allowKeyAttempt, keyTarget, loadModels, modelCaps, probeChat } from '@/lib/ai-key-models';
import { encryptApiKey } from '@/lib/encryption';
import { meOriginAllowed, meRespond } from '@/lib/me-route';

export const runtime = 'nodejs';

/** The shortest key whose last four characters are kept to recognise it by. */
const MIN_KEY_FOR_LAST4 = 12;

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/** GET /api/me/ai-keys - the caller's own AI keys (#374), with what each spent this month. Never returns a key. */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    return respond(request, { keys: await listAiKeys(user.id) });
  } catch (error) {
    console.error('[AiKeys] List failed:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * POST /api/me/ai-keys { kind, address?, region?, apiKey?, model, name? } - add a key for the caller. The provider is asked
 * for its models first, then for one tiny reply from the model picked, so a key that doesn't answer is never saved and the
 * model is one it really has (some providers list their models to anyone, so the list alone can't prove a key). The key
 * is stored encrypted and never sent back.
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return respond(request, { error: 'Expected an object' }, 400);
  const input = body as { kind?: unknown; address?: unknown; region?: unknown; apiKey?: unknown; model?: unknown; name?: unknown };

  const resolved = keyTarget(input);
  if (!resolved.ok) return respond(request, { error: resolved.message }, 400);
  const { info, endpoint, region } = resolved.target;

  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model || model.length > 255) return respond(request, { error: 'Pick a model first.' }, 400);
  const typedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (typedName.length > 60) return respond(request, { error: 'Keep the name under 60 characters.' }, 400);
  const name = typedName || `My ${info.label}`;
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (apiKey && !KEY_CHARACTERS.test(apiKey)) return respond(request, { error: KEY_LOOKS_WRONG }, 400);

  if (!allowKeyAttempt(user.id)) return respond(request, { error: 'Too many tries. Wait a minute and try again.' }, 429);
  try {
    if ((await prisma.botsAiProvider.count({ where: { ownerId: user.id } })) >= MAX_AI_KEYS) {
      return respond(request, { error: `You can have up to ${MAX_AI_KEYS} keys. Revoke one you don’t use.` }, 400);
    }
    const checked = await loadModels(input);
    if (!checked.ok) return respond(request, { error: checked.message }, 400);
    if (!checked.models.includes(model)) {
      return respond(request, { error: 'That model isn’t on the list. Load models again and pick one.' }, 400);
    }
    // What the provider said about this model, from the list it just gave (never from the request)
    const caps = modelCaps(checked.facts, model);
    const chat = await probeChat({ kind: info.kind, address: input.address, region, apiKey, model });
    // The model is on the list, so a 400 here is the provider refusing this tiny request (a reasoning model that wants a bigger
    // cap, say), not a wrong key or model: it is saved, the same as the health check lets it pass
    if (!chat.ok && chat.reason !== 'request') return respond(request, { error: chat.message }, 400);
    const row = await prisma.botsAiProvider.create({
      data: {
        providerId: `key-${randomUUID()}`,
        name,
        type: info.providerType,
        enabled: true,
        endpoint,
        apiKeyEncrypted: apiKey ? encryptApiKey(apiKey) : null,
        // Only a long key keeps its last four in plain text: for a short one (an own server's "1234"), four is most of the key
        apiKeyLast4: apiKey.length >= MIN_KEY_FOR_LAST4 ? apiKey.slice(-4) : null,
        model,
        temperature: 0.7,
        maxTokens: 500,
        supportsStreaming: true,
        // The provider's word on images when it gave one; otherwise left to the bot server's own guess from the name
        supportsVision: caps.vision ?? null,
        settings: { kind: info.kind, ...(region ? { region } : {}), ...(Object.keys(caps).length > 0 ? { caps } : {}) },
        tested: true,
        testedAt: new Date(),
        ownerId: user.id,
      },
      select: { providerId: true },
    });
    return respond(request, { id: row.providerId }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENCRYPTION_KEY')) {
      console.error('[AiKeys] ENCRYPTION_KEY is not set; no key can be saved');
      return respond(request, { error: 'Keys can’t be saved on this server yet. Tell the Universe team.' }, 500);
    }
    console.error('[AiKeys] Add failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
