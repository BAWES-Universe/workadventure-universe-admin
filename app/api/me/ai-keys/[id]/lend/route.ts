import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { lendAccess, moveBotsToAllowedModel, parseLendModels } from '@/lib/ai-key-lend';
import { allowedModels, firstForBots, keyModels, lendModels } from '@/lib/ai-key-model-list';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/ai-keys/:id/lend { universeId, models? } - lend one of the caller's keys to a universe where they have Manage
 * bots (or own it). Lending moves no bot. Lending again is fine and changes nothing, except the model list when one is sent.
 * Someone else's key, and a server provider, are "not found".
 *
 * `models` (#575) says which of the key's models bots there may use: null = all of them, a list = only these (each one must
 * be on the key's list now), left out = as it is (all, for a new lend). Narrowing a lend moves the bots there on a model it
 * took out to the first one kept, and the universe's owner is told when it is not the caller.
 * `existing: true` changes a lend only: when there is none (removed meanwhile) nothing is lent and the answer is a 409.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  const input = typeof body === 'object' && body !== null ? (body as { universeId?: unknown; models?: unknown; existing?: unknown }) : {};
  const existing = input.existing === true;
  const universeId = input.universeId;
  if (typeof universeId !== 'string' || !universeId) return respond(request, { error: 'Pick a universe first.' }, 400);
  const parsed = parseLendModels(input.models);
  if (!parsed.ok) return respond(request, { error: parsed.message }, 400);

  try {
    const key = await prisma.botsAiProvider.findFirst({
      where: { providerId: id, ownerId: user.id },
      select: { providerId: true, endpoint: true, apiKeyEncrypted: true, settings: true, model: true },
    });
    if (!key) return respond(request, { error: 'Key not found' }, 404);
    if (!(await lendAccess(user.id, universeId))) {
      return respond(request, { error: 'You need Manage bots in that universe to lend a key to it.' }, 403);
    }
    // Only models the key has now can be allowed; they are kept in the provider's order
    let models = parsed.models;
    if (models) {
      const list = await keyModels(key, { fresh: true });
      if (!list.ok) return respond(request, { error: list.message }, 400);
      const missing = models.find((model) => !list.models.includes(model));
      if (missing) return respond(request, { error: `${missing} isn’t on this key’s list. Load its models again and pick from them.` }, 400);
      models = allowedModels(list.models, models);
    }
    const where = { providerId_universeId: { providerId: id, universeId } };
    const update = models === undefined ? {} : { models: models ?? Prisma.DbNull };
    // What bots there reply with now is judged by the lend as it was, so only bots on a model taken out move
    const before = models ? await prisma.aiKeyLend.findUnique({ where, select: { models: true } }) : null;
    // A change of a lend (`existing`) never lends again: one removed meanwhile, in another tab or by the universe, stays removed
    const saved = existing
      ? await prisma.aiKeyLend.update({ where, data: update, select: { models: true } })
      : await prisma.aiKeyLend.upsert({ where, create: { providerId: id, universeId, models: models ?? Prisma.DbNull }, update, select: { models: true } });
    const moved = models ? await moveBotsToAllowedModel(key, { universeId, allowed: models, firstAllowed: firstForBots(models, key), actor: { id: user.id, name: user.name }, before: lendModels(before?.models) }) : { count: 0 };
    return respond(request, { status: 'lent', models: lendModels(saved.models), moved: moved.count }, 200);
  } catch (error) {
    // The key was revoked, or the universe deleted, between the checks above and the save
    if ((error as { code?: unknown })?.code === 'P2003') return respond(request, { error: 'Key or universe not found' }, 404);
    if (existing && (error as { code?: unknown })?.code === 'P2025') {
      return respond(request, { error: 'This key isn’t lent to that universe any more. Reload the page to see where it’s lent.' }, 409);
    }
    console.error('[AiKeys] Lend failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
