import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { kindInfo, type AiKeyKindInfo } from '@/lib/ai-key-kinds';
import { decryptApiKey } from '@/lib/encryption';
import { ANSWER_TRIES, firstAnswering } from '@/lib/ai-key-answering';
import { probeChat, type ModelFactsById, type ProbeFailure } from '@/lib/ai-key-models';
import { addNotice } from '@/lib/notices';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { allowedModels, forgetKeyModels, keyModels, lendModels, modelFactsOf, servedModel, type KeyForModels } from '@/lib/ai-key-model-list';

/**
 * A provider stopped offering the model one bot replies with (#575). That says nothing about the key's other models, so the
 * key is not marked Down: the bot moves to the first model its lend still allows that answers one tiny reply (the provider's
 * suggested one first), and the key's owner, who made the bot, is told. When the lend allows none that the provider still
 * lists, or none of them answers, the bots there move to Universe AI, the same as when a key is pulled. When the key's check
 * model is the one that went, the key gets a new check model, so the health check does not mark it Down for a model nobody uses.
 *
 * A model the provider still lists but that answers a bot with a 404 is treated the same for that bot (another listed model
 * may still answer), the key's check model too. Before anything moves, the bot's model is asked once more: one that answers
 * now (a reply sent before the bot moved to it, a passing hiccup), or no clear answer, changes nothing.
 *
 * Returns false when this can't be decided (the list can't be loaded, the provider has no list, or more models are allowed
 * than are asked): then the reply's failure counts against the key as before. When asking showed the key itself refused or
 * out of credit, that is returned instead, so the key is marked Down for what really went wrong.
 */
export function moveBotOffGoneModel(key: KeyForModels & { ownerId: string | null; name: string }, botId: string): Promise<boolean | KeyFailure> {
  // Replies in flight at once report the same 404: they share one answer, so the provider is asked once, not once each
  const id = `${key.providerId}|${botId}`;
  const running = deciding.get(id);
  if (running) return running;
  // Other bots on the key deciding at the same time share what each model answered, so no model is asked twice for them
  const shared = sharedAnswers(key.providerId);
  shared.users += 1;
  const decided = decide(key, botId, shared.asked).finally(() => {
    deciding.delete(id);
    shared.users -= 1;
    if (shared.users === 0 && answers.get(key.providerId) === shared) answers.delete(key.providerId);
  });
  deciding.set(id, decided);
  return decided;
}

/** The key itself failed when a model was asked: refused, or out of credit. */
export type KeyFailure = 'rejected' | 'credit';

const deciding = new Map<string, Promise<boolean | KeyFailure>>();

type ChatAnswer = ReturnType<typeof probeChat>;
/** How long answers are shared while bots keep reporting: a run of reports that never ends still asks again after this. */
const SHARED_ANSWERS_MS = 60_000;
const answers = new Map<string, { at: number; users: number; asked: Map<string, ChatAnswer> }>();

function sharedAnswers(providerId: string) {
  const held = answers.get(providerId);
  if (held && Date.now() - held.at < SHARED_ANSWERS_MS) return held;
  const fresh = { at: Date.now(), users: 0, asked: new Map<string, ChatAnswer>() };
  answers.set(providerId, fresh);
  return fresh;
}

async function decide(key: KeyForModels & { ownerId: string | null; name: string }, botId: string, asked: Map<string, ChatAnswer>): Promise<boolean | KeyFailure> {
  if (!key.ownerId) return false;
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { id: true, name: true, aiModel: true, aiProviderRef: true, room: { select: { world: { select: { universe: { select: { id: true, name: true } } } } } } },
  });
  if (!bot) return false;
  // The bot left this key while the reply was on its way: the report is about a key it isn't on, so it says nothing here
  if (bot.aiProviderRef !== key.providerId) return true;
  const universe = bot.room.world.universe;
  const readLend = async () =>
    lendModels((await prisma.aiKeyLend.findUnique({ where: { providerId_universeId: { providerId: key.providerId, universeId: universe.id } }, select: { models: true } }))?.models);
  const lend = await readLend();
  // The model the reply was asked of: the bot's own, or the one its lend falls back to
  const gone = servedModel(bot, key, lend);
  if (!gone) return false;
  // One 404 is not the last word: the model is asked once more first. It answers now (a reply sent before the bot moved to
  // it, a passing hiccup) or no clear answer comes: nothing changes, and the next report asks again. A refused key: the
  // key is marked Down for what it said. Only a provider that says, again, that it has no such model moves anything.
  // A bot's reply always offers tools (sending an image, a file), and OpenRouter answers a model with none that calls them
  // with a 404: every model here is asked with one tool, as a bot asks, so a model that chats but calls no tools is not
  // taken as answering. One the provider already says calls no tools is not asked: its 404 is real for bots.
  if (modelFactsOf(key, gone).tools !== false) {
    const again = await askAbout(key, gone, asked);
    if (again === 'rejected' || again === 'credit') return again;
    if (again !== 'gone') return true;
  }
  const list = await keyModels(key, { fresh: true });
  if (!list.ok || !list.listed) return false;
  // A model the provider still lists but that won't answer is that model's failure only, the key's check model too: the
  // bot moves off it the same as off a gone one, and the key gets another check model when one answers
  const listed = list.models.includes(gone);

  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  const label = info?.label ?? 'The provider';
  const pick = answeringPicker(key, info, list.facts, asked);
  // Bots with no model of their own reply with the check model, so it too is one that calls tools when the provider says
  const others = list.models.filter((model) => model !== gone && list.facts[model]?.tools !== false);
  if (gone === key.model && others.length > 0) {
    // Only a model that answered becomes the check model: else the next health check finds one, as it does for a gone one
    const check = await pick(others);
    if (check.answered) await replaceCheckModel(key, check.model);
  }

  // A bot is never moved to a model the provider says calls no tools: its replies there would fail the same way
  const allowed = allowedModels(list.models, lend).filter((model) => model !== gone && list.facts[model]?.tools !== false);
  const found = allowed.length > 0 ? await pick(allowed) : null;
  // Every other model allowed here was asked and the provider says it has none of them to answer with: as good as none left
  const noneAnswer = found !== null && !found.answered && found.why === 'gone' && allowed.length <= ANSWER_TRIES;
  if (!found || noneAnswer) {
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
    // the next report asks again. The key refused or out of credit: it is marked Down for that. Not every allowed model
    // could be asked: the key's own rules apply.
    if (found.why === 'rejected' || found.why === 'credit') return found.why;
    return found.why === 'busy' || found.why === 'unreachable';
  }
  const next = found.model;
  const moved = await prisma.bot.updateMany({ where: { id: bot.id, aiProviderRef: key.providerId, aiModel: bot.aiModel }, data: { aiModel: next } });
  if (moved.count > 0) {
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
 * to answer with, no clear answer (busy, not answering), or the key itself was refused or is out of credit.
 */
async function askAbout(key: KeyForModels, model: string, asked: Map<string, ChatAnswer>): Promise<'answers' | 'gone' | 'unsure' | KeyFailure> {
  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  if (!info) return 'unsure';
  let apiKey: string | undefined;
  try {
    apiKey = key.apiKeyEncrypted ? decryptApiKey(key.apiKeyEncrypted) : undefined;
  } catch {
    return 'rejected';
  }
  let answer = asked.get(model);
  if (!answer) {
    answer = probeChat({ kind: info.kind, address: key.endpoint ?? undefined, apiKey, model, withTool: true });
    asked.set(model, answer);
  }
  const reply = await answer;
  if (reply.ok || reply.reason === 'request') return 'answers';
  if (reply.reason === 'gone') return 'gone';
  // Any other error (a timeout, a conflict) says nothing sure about the model
  return reply.reason === 'rejected' || reply.reason === 'credit' ? reply.reason : 'unsure';
}

/**
 * Picks the model to move to from a list: the first that answers one tiny reply, the same as Add key (the provider's
 * suggested model first). `answered` says whether one did; when none did, `why` says what the last one asked said.
 * Answers are shared by every report on the key being decided at once, so no model is asked twice for them.
 */
function answeringPicker(key: KeyForModels, info: AiKeyKindInfo | null, facts: ModelFactsById, asked: Map<string, ChatAnswer>) {
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
    const found = await firstAnswering({ kind: info.kind, address: key.endpoint ?? undefined, apiKey, withTool: true }, models, suggested, asked, facts);
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
}
