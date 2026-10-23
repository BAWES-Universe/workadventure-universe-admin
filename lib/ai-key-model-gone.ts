import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { kindInfo } from '@/lib/ai-key-kinds';
import { addNotice } from '@/lib/notices';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { allowedModels, forgetKeyModels, keyModels, lendModels, modelFactsOf, servedModel, type KeyForModels } from '@/lib/ai-key-model-list';

/**
 * A provider stopped offering the model one bot replies with (#575). That says nothing about the key's other models, so the
 * key is not marked Down: the bot moves to the first model its lend still allows (the provider's suggested one when it is
 * allowed), and the key's owner, who made the bot, is told. When the lend allows none that the provider still lists, the
 * bots there move to Universe AI, the same as when a key is pulled. When the key's check model is the one that went, the key
 * gets a new check model, so the health check does not mark it Down for a model nobody uses.
 *
 * Returns false when this can't be decided (the list can't be loaded, the provider has no list, or the model is still on
 * it): then the reply's failure counts against the key as before. A report that comes in just after the bot was moved is
 * about the model it left (a reply already on its way, or the bot server still holding the old answer), so it is let go.
 */
/** How long after a move a model-gone report for that bot is taken as late news about the model it left. */
export const LATE_REPORT_MS = 10 * 60_000;
const movedAt = new Map<string, number>();

export async function moveBotOffGoneModel(key: KeyForModels & { ownerId: string | null; name: string }, botId: string): Promise<boolean> {
  if (!key.ownerId) return false;
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { id: true, name: true, aiModel: true, aiProviderRef: true, room: { select: { world: { select: { universe: { select: { id: true, name: true } } } } } } },
  });
  if (!bot || bot.aiProviderRef !== key.providerId) return false;
  const list = await keyModels(key, { fresh: true });
  if (!list.ok || !list.listed) return false;
  const universe = bot.room.world.universe;
  const lent = await prisma.aiKeyLend.findUnique({ where: { providerId_universeId: { providerId: key.providerId, universeId: universe.id } }, select: { models: true } });
  const lend = lendModels(lent?.models);
  // The model the reply was asked of: the bot's own, or the one its lend falls back to
  const gone = servedModel(bot, key, lend);
  if (!gone || list.models.includes(gone)) {
    const at = movedAt.get(`${key.providerId}:${bot.id}`);
    return at !== undefined && Date.now() - at < LATE_REPORT_MS;
  }

  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  const label = info?.label ?? 'The provider';
  if (gone === key.model && list.models.length > 0) await replaceCheckModel(key, list.models, info?.suggestedModel);

  const allowed = allowedModels(list.models, lend);
  if (allowed.length === 0) {
    // Nothing allowed here is offered any more: the bots here can't run on this key, as if it were pulled
    await moveBotsOffKey(key.providerId, { universeId: universe.id, actor: { id: '', name: label }, why: 'models-gone' });
    return true;
  }
  const next = info?.suggestedModel && allowed.includes(info.suggestedModel) ? info.suggestedModel : allowed[0];
  const moved = await prisma.bot.updateMany({ where: { id: bot.id, aiProviderRef: key.providerId, aiModel: bot.aiModel }, data: { aiModel: next } });
  movedAt.set(`${key.providerId}:${bot.id}`, Date.now());
  if (moved.count > 0) {
    try {
      await addNotice({
        userId: key.ownerId,
        kind: 'ai-key-moved',
        dedupeKey: `model-gone:${key.providerId}:${bot.id}:${new Date().toISOString()}`,
        title: `${bot.name} now replies with ${next}`,
        body: `${label} no longer has ${gone}, so ${bot.name} in ${universe.name} moved to ${next} on ${key.name}. Pick another model for it on its bot page if you like.`,
        href: '/admin/you/ai-keys',
      });
    } catch (error) {
      console.error('[AiKeys] Could not tell the key owner:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return true;
}

/** The key's check model is gone: the provider's suggested model when listed, otherwise the first one listed. */
async function replaceCheckModel(key: KeyForModels, listed: string[], suggested: string | undefined): Promise<void> {
  const model = suggested && listed.includes(suggested) ? suggested : listed[0];
  const caps = modelFactsOf(key, model);
  const settings = { ...((key.settings as Record<string, unknown> | null) ?? {}) };
  if (Object.keys(caps).length > 0) settings.caps = caps;
  else delete settings.caps;
  await prisma.botsAiProvider.updateMany({
    where: { providerId: key.providerId, ownerId: { not: null }, model: key.model },
    data: { model, settings: settings as Prisma.InputJsonValue, supportsVision: caps.vision ?? null },
  });
  forgetKeyModels(key.providerId);
}
