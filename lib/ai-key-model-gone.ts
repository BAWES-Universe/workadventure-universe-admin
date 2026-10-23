import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { kindInfo, type AiKeyKindInfo } from '@/lib/ai-key-kinds';
import { decryptApiKey } from '@/lib/encryption';
import { ANSWER_TRIES, firstAnswering } from '@/lib/ai-key-answering';
import { probeChat, type ModelFactsById, type ProbeFailure } from '@/lib/ai-key-models';
import { changedLately, noteCheckModelChanged, noteModelChanged } from '@/lib/ai-key-late-report';
import { addNotice } from '@/lib/notices';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { allowedModels, forgetKeyModels, keyModels, lendModels, modelFactsOf, servedModel, type KeyForModels } from '@/lib/ai-key-model-list';

export { LATE_REPORT_MS, noteModelChanged } from '@/lib/ai-key-late-report';

/**
 * A provider stopped offering the model one bot replies with (#575). That says nothing about the key's other models, so the
 * key is not marked Down: the bot moves to the first model its lend still allows that answers one tiny reply (the provider's
 * suggested one first), and the key's owner, who made the bot, is told. When the lend allows none that the provider still
 * lists, or none of them answers, the bots there move to Universe AI, the same as when a key is pulled. When the key's check model is the one that went, the key
 * gets a new check model, so the health check does not mark it Down for a model nobody uses.
 *
 * A model the provider still lists but that answers a bot with a 404 is treated the same for that bot (another listed model
 * may still answer), the key's check model too.
 *
 * Returns false when this can't be decided (the list can't be loaded, the provider has no list, the key was refused, or more
 * models are allowed than are asked): then the reply's failure counts against the key as before. A provider busy or not answering while the models are asked decides nothing, and the next report asks again. A report that comes in just after the bot was moved is
 * about the model it left (a reply already on its way, or the bot server still holding the old answer), so it is let go.
 */
export function moveBotOffGoneModel(key: KeyForModels & { ownerId: string | null; name: string }, botId: string): Promise<boolean> {
  // Replies in flight at once report the same 404: they share one answer, so the provider is asked once, not once each
  const id = `${key.providerId}|${botId}`;
  const running = deciding.get(id);
  if (running) return running;
  const decided = decide(key, botId).finally(() => deciding.delete(id));
  deciding.set(id, decided);
  return decided;
}

const deciding = new Map<string, Promise<boolean>>();

async function decide(key: KeyForModels & { ownerId: string | null; name: string }, botId: string): Promise<boolean> {
  if (!key.ownerId) return false;
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { id: true, name: true, aiModel: true, aiProviderRef: true, room: { select: { world: { select: { universe: { select: { id: true, name: true } } } } } } },
  });
  if (!bot || bot.aiProviderRef !== key.providerId) return false;
  const universe = bot.room.world.universe;
  const readLend = async () =>
    lendModels((await prisma.aiKeyLend.findUnique({ where: { providerId_universeId: { providerId: key.providerId, universeId: universe.id } }, select: { models: true } }))?.models);
  const lend = await readLend();
  // The model the reply was asked of: the bot's own, or the one its lend falls back to
  const gone = servedModel(bot, key, lend);
  if (!gone) return false;
  // Moved or changed in the last few minutes: late news about the model it left, as long as the one it has now answers. When
  // the provider says it doesn't have that one either, the report is about it, and the bot moves off it as from any other.
  // A new check model only counts for a bot that really replies with it (a lend that leaves it out serves its own first model).
  if (changedLately(bot, key.providerId, gone === key.model) && (await askAbout(key, gone)) !== 'gone') return true;
  const list = await keyModels(key, { fresh: true });
  if (!list.ok || !list.listed) return false;
  // A model the provider still lists but that won't answer is that model's failure only, the key's check model too: the
  // bot moves off it the same as off a gone one, and the key gets another check model when one answers
  const listed = list.models.includes(gone);

  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  const label = info?.label ?? 'The provider';
  const pick = answeringPicker(key, info, list.facts);
  const others = list.models.filter((model) => model !== gone);
  if (gone === key.model && others.length > 0) {
    // Only a model that answered becomes the check model: else the next health check finds one, as it does for a gone one
    const check = await pick(others);
    if (check.answered) await replaceCheckModel(key, check.model);
  }

  const allowed = allowedModels(list.models, lend).filter((model) => model !== gone);
  const found = allowed.length > 0 ? await pick(allowed) : null;
  // Every other model allowed here was asked and the provider says it has none of them to answer with: as good as none left
  const noneAnswer = found !== null && !found.answered && (found.why === 'gone' || found.why === 'other') && allowed.length <= ANSWER_TRIES;
  if (!found || noneAnswer) {
    // One report is not the last word before every bot here leaves the key: the bot's own model is asked once more (a local
    // provider's list can leave out a model it hasn't loaded yet). One that answers now, or no clear answer, decides nothing;
    // a refused key leaves it to the key's own rules.
    const again = await askAbout(key, gone);
    if (again !== 'gone') return again !== 'key';
    // The owner changed the lend while the provider was asked: the lend change already moved these bots where it allows,
    // so nobody is pulled off the key on the old lend's say, and a later report is decided on the new one
    if (JSON.stringify(await readLend()) !== JSON.stringify(lend)) return true;
    // Nothing allowed here is offered any more: the bots here can't run on this key, as if it were pulled
    const moved = await moveBotsOffKey(key.providerId, { universeId: universe.id, actor: { id: '', name: label }, why: 'models-gone' });
    // That tells the universe's owner. The key's owner made these bots, so they hear it too when it is someone else's universe.
    const elsewhere = moved.universes.find((entry) => entry.ownerId !== key.ownerId);
    if (elsewhere) {
      const names = elsewhere.botNames;
      try {
        await addNotice({
          userId: key.ownerId,
          kind: 'ai-key-moved',
          dedupeKey: `models-gone:${key.providerId}:${elsewhere.id}:${new Date().toISOString()}`,
          title: names.length === 1 ? `${names[0]} moved to Universe AI` : `${names.length} bots moved to Universe AI`,
          body: `${label} no longer has any of the models ${key.name} may use in ${elsewhere.name}, so ${
            names.length === 1 ? `${names[0]} now replies` : `the ${names.length} bots there now reply`
          } on Universe AI.`,
          href: '/admin/you/ai-keys',
        });
      } catch (error) {
        console.error('[AiKeys] Could not tell the key owner:', error instanceof Error ? error.message : 'unknown');
      }
    }
    return true;
  }
  if (!found.answered) {
    // The bot is never moved to a model nobody checked. The provider busy or not answering just now: nothing is decided, and
    // the next report asks again. The key refused, or not every allowed model could be asked: the key's own rules apply.
    return found.why === 'busy' || found.why === 'unreachable';
  }
  const next = found.model;
  const moved = await prisma.bot.updateMany({ where: { id: bot.id, aiProviderRef: key.providerId, aiModel: bot.aiModel }, data: { aiModel: next } });
  if (moved.count > 0) {
    // A report just after the move is late news about the model it left: the new one just answered
    noteModelChanged(bot.id);
    try {
      await addNotice({
        userId: key.ownerId,
        kind: 'ai-key-moved',
        dedupeKey: `model-gone:${key.providerId}:${bot.id}:${new Date().toISOString()}`,
        title: `${bot.name} now replies with ${next}`,
        body: `${label} ${listed ? 'doesn’t answer with' : 'no longer has'} ${gone}, so ${bot.name} in ${universe.name} moved to ${next} on ${key.name}. Pick another model for it on its bot page if you like.`,
        href: '/admin/you/ai-keys',
      });
    } catch (error) {
      console.error('[AiKeys] Could not tell the key owner:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return true;
}

/**
 * What the provider says about this model to one tiny reply: it answers (a refused tiny request counts), it has no such model
 * to answer with, no clear answer (busy, not answering), or the key itself was refused.
 */
async function askAbout(key: KeyForModels, model: string): Promise<'answers' | 'gone' | 'unsure' | 'key'> {
  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  if (!info) return 'unsure';
  let apiKey: string | undefined;
  try {
    apiKey = key.apiKeyEncrypted ? decryptApiKey(key.apiKeyEncrypted) : undefined;
  } catch {
    return 'key';
  }
  const reply = await probeChat({ kind: info.kind, address: key.endpoint ?? undefined, apiKey, model });
  if (reply.ok || reply.reason === 'request') return 'answers';
  if (reply.reason === 'gone' || reply.reason === 'other') return 'gone';
  return reply.reason === 'busy' || reply.reason === 'unreachable' ? 'unsure' : 'key';
}

/**
 * Picks the model to move to from a list: the first that answers one tiny reply, the same as Add key (the provider's
 * suggested model first). `answered` says whether one did; when none did, `why` says what the last one asked said.
 * Answers are kept for the one report, so the check model and the bot's model never ask the same model twice.
 */
function answeringPicker(key: KeyForModels, info: AiKeyKindInfo | null, facts: ModelFactsById) {
  const asked = new Map();
  let apiKey: string | undefined;
  let readable = true;
  try {
    apiKey = key.apiKeyEncrypted ? decryptApiKey(key.apiKeyEncrypted) : undefined;
  } catch {
    readable = false;
  }
  return async (models: string[]): Promise<{ model: string; answered: true } | { answered: false; why: ProbeFailure }> => {
    const suggested = info?.suggestedModel;
    if (!info || !readable) return { answered: false, why: 'rejected' };
    const found = await firstAnswering({ kind: info.kind, address: key.endpoint ?? undefined, apiKey }, models, suggested, asked, facts);
    return found.ok ? { model: found.model, answered: true } : { answered: false, why: found.reason };
  };
}

/** The key's check model is gone: it moves to `model`, one the provider still lists. */
async function replaceCheckModel(key: KeyForModels, model: string): Promise<void> {
  const caps = modelFactsOf(key, model);
  // Finding an answering model took a while: settings saved meanwhile are kept
  const saved = await prisma.botsAiProvider.findUnique({ where: { providerId: key.providerId }, select: { settings: true } });
  const settings = { ...(((saved ? saved.settings : key.settings) as Record<string, unknown> | null) ?? {}) };
  if (Object.keys(caps).length > 0) settings.caps = caps;
  else delete settings.caps;
  const { count } = await prisma.botsAiProvider.updateMany({
    where: { providerId: key.providerId, ownerId: { not: null }, model: key.model },
    data: { model, settings: settings as Prisma.InputJsonValue, supportsVision: caps.vision ?? null },
  });
  // Someone changed the model meanwhile: theirs stands
  if (count === 0) return;
  forgetKeyModels(key.providerId);
  noteCheckModelChanged(key.providerId);
}
