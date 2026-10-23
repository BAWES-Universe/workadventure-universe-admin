import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { listAiKeys } from '@/lib/ai-keys';
import { MAX_AI_KEYS } from '@/lib/ai-key-kinds';
import { KEY_CHARACTERS, KEY_LOOKS_WRONG, allowKeyAttempt, keyTarget, loadModels, modelCaps, probeChat, type ProbeFailure } from '@/lib/ai-key-models';
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

/** How many of a provider's listed models Add key tries for its one tiny reply before it says why none answered. */
const CHECK_TRIES = 4;

/**
 * POST /api/me/ai-keys { kind, address?, region?, apiKey?, model?, name? } - add a key for the caller. The provider is asked
 * for its models first, then for one tiny reply, so a key that doesn't answer is never saved (some providers list their
 * models to anyone, so the list alone can't prove a key). The key is stored encrypted and never sent back.
 *
 * No model is picked when adding a key (#575): each bot picks its own. The key keeps a check model for that reply and the
 * health check: the provider's suggested model when it lists it, else the first listed one that answers. A provider with
 * no model list has its model typed (`model`), which is then its check model and its one model.
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

  const typedModel = typeof input.model === 'string' ? input.model.trim() : '';
  if (typedModel.length > 255) return respond(request, { error: 'That model name is too long.' }, 400);
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
    // A provider with no model list: the person typed the model, so nothing says it exists but the chat reply below
    const noList = !checked.ok && checked.noList === true;
    if (!checked.ok && !noList) return respond(request, { error: checked.message }, 400);
    if (noList && !typedModel) return respond(request, { error: `${info.label} doesn’t share a list of its models. Type the model name.` }, 400);
    if (checked.ok && checked.models.length === 0) return respond(request, { error: `${info.label} lists no models for this key.` }, 400);
    // An older page still sends the model it picked: it must be on the list, as before
    if (checked.ok && typedModel && !checked.models.includes(typedModel)) {
      return respond(request, { error: 'That model isn’t on the list. Load models again and pick one.' }, 400);
    }
    const candidates = !checked.ok
      ? [typedModel]
      : typedModel
        ? [typedModel]
        : checkCandidates(checked.models, checked.facts, info.suggestedModel);
    let model: string | null = null;
    let refused: string | null = null;
    let refusedForCredit = false;
    // A listed model that refuses only this tiny request (a reasoning model that wants a bigger cap, say) is not a wrong key
    // or model, the same as the health check lets it pass. A typed model has no list behind it, so only a real reply keeps it.
    // A model picked from the list is kept only when none of the others gives a real reply: a model that doesn't chat at all
    // (an embedding model whose name says nothing) can answer the same way.
    let refusedRequest: string | null = null;
    for (const candidate of candidates) {
      const chat = await probeChat({ kind: info.kind, address: input.address, region, apiKey, model: candidate, ...(noList ? { noList } : {}) });
      if (chat.ok) {
        model = candidate;
        break;
      }
      if (!noList && chat.reason === 'request') {
        if (typedModel) {
          model = candidate;
          break;
        }
        refusedRequest ??= candidate;
        continue;
      }
      // Out of credit is said ahead of a later model's words: it is what the person can fix
      if (!refusedForCredit) refused = chat.message;
      if (chat.reason === 'credit') refusedForCredit = true;
      if (!tryNextModel(chat)) {
        // The key or the provider failed, not this model: one that only refused the tiny request earlier proves nothing now
        refusedRequest = null;
        break;
      }
    }
    model ??= refusedRequest;
    if (!model) return respond(request, { error: refused ?? 'That didn’t work. Try again.' }, 400);
    // What the provider said about the check model, from the list it just gave (never from the request)
    const caps = checked.ok ? modelCaps(checked.facts, model) : {};
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
        // How many models it has is shown on the key card (#575); a provider with no list has only the typed one
        settings: { kind: info.kind, ...(region ? { region } : {}), ...(Object.keys(caps).length > 0 ? { caps } : {}), ...(checked.ok ? { modelCount: checked.models.length } : {}) },
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

/**
 * The models Add key tries for its one tiny reply: the provider's suggested model when listed, then models the provider says
 * call tools (a model that calls tools chats; a list sorted by name can start with ones that don't), then the rest, the first
 * few of those, and a free model when the list has one (OpenRouter's ":free" models answer a key with no credit).
 */
function checkCandidates(listed: string[], facts: Record<string, { tools?: boolean }>, suggested: string | undefined): string[] {
  const first = suggested && listed.includes(suggested) ? [suggested] : [];
  const rest = listed.filter((id) => id !== suggested);
  const chats = rest.filter((id) => facts[id]?.tools === true);
  const candidates = [...first, ...chats, ...rest.filter((id) => facts[id]?.tools !== true)].slice(0, CHECK_TRIES);
  const free = listed.find((id) => id.endsWith(':free'));
  return free && !candidates.includes(free) ? [...candidates, free] : candidates;
}

/**
 * Whether another listed model may still answer after this one failed. A refused key or a busy provider would say the same
 * for every model, and so would a provider that didn't answer at all (each try could wait the whole timeout). A model that
 * is gone, out of this key's credit (a free one may still run), or answered with its own error says nothing about the next.
 */
function tryNextModel(chat: { reason: ProbeFailure; status?: number }): boolean {
  if (chat.reason === 'gone' || chat.reason === 'other' || chat.reason === 'credit') return true;
  return chat.reason === 'unreachable' && chat.status !== undefined;
}
