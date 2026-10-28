import type { BotsAiProvider } from '@prisma/client';
import { prisma } from '@/lib/db';
import { kindInfo } from '@/lib/ai-key-kinds';
import { checkKeyForBot, KEY_FOR_BOT_TEXT } from '@/lib/ai-key-pay';
import { recheckIfDue } from '@/lib/ai-key-health';
import { resolveVisionSupport } from '@/lib/vision-models';
import { UNIVERSE_AI_MISSING, resolveUniverseAiProvider } from '@/lib/universe-ai';

/**
 * Where a bot's images go (#374, the Vision row on the bot page). The bot's own model still writes every reply; this only
 * says what looks at the pictures people send:
 *   - "this": the bot's own model. It sees them if it can; if it can't, it is told an image came and not what is in it;
 *   - "universe-ai": Universe AI describes them (the images leave the key the bot runs on);
 *   - "another": a model with Vision on one of the own keys of whoever's key the bot runs on, lent to this universe (#709).
 * The pick is saved in the bot's behavior config under `vision`; nothing saved means the owner picked nothing (see `autoVision`).
 */
export type VisionPick =
  | { choice: 'this' }
  | { choice: 'universe-ai' }
  | { choice: 'another'; keyId: string; model: string };

/** What the owner picked, read from a bot's behavior config; null when nothing (or nothing readable) is saved. */
export function readVisionPick(behaviorConfig: unknown): VisionPick | null {
  const raw = behaviorConfig && typeof behaviorConfig === 'object' ? (behaviorConfig as Record<string, unknown>).vision : null;
  return parseVisionPick(raw);
}

export function parseVisionPick(raw: unknown): VisionPick | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.choice === 'this') return { choice: 'this' };
  if (value.choice === 'universe-ai') return { choice: 'universe-ai' };
  if (value.choice === 'another' && typeof value.keyId === 'string' && value.keyId && typeof value.model === 'string' && value.model) {
    return { choice: 'another', keyId: value.keyId, model: value.model };
  }
  return null;
}

const samePick = (a: VisionPick | null, b: VisionPick | null): boolean =>
  !!a && !!b && a.choice === b.choice && (a.choice !== 'another' || (b.choice === 'another' && a.keyId === b.keyId && a.model === b.model));

/** The models with Vision a key can look at images with: its own model when that sees, then what the provider's docs name. */
export function keyVisionModels(key: { model: string | null; supportsVision: boolean | null; settings: unknown }): string[] {
  const models: string[] = [];
  if (key.model && resolveVisionSupport(key.model, key.supportsVision)) models.push(key.model);
  const facts = kindInfo((key.settings as { kind?: unknown } | null)?.kind)?.knownFacts ?? {};
  for (const [model, fact] of Object.entries(facts)) if (fact.vision === true && !models.includes(model)) models.push(model);
  return models;
}

/**
 * Where images go when the owner picked nothing. A model that sees looks at them itself. One that can't, on a person's own
 * key, uses a Vision model on that same key when the provider has one, so the images stay on the key; otherwise Universe AI
 * looks at them. The page shows this as the picked choice and the owner can change it. Only a person's own key is ever
 * given a different default: Universe AI and server providers keep behaving exactly as they did.
 */
export type AutoVision =
  | { choice: 'this' }
  | { choice: 'universe-ai' }
  | { choice: 'another'; keyId: string; model: string };

export function autoVision(main: { ownKeyId: string | null; sees: boolean; sameKeyModel: string | null }): AutoVision {
  if (main.sees) return { choice: 'this' };
  if (main.ownKeyId && main.sameKeyModel) return { choice: 'another', keyId: main.ownKeyId, model: main.sameKeyModel };
  return { choice: 'universe-ai' };
}

/** Why a key picked for images can't be used right now. */
export type AnotherProblem = 'gone' | 'no-owner' | 'other-owner' | 'not-lent' | 'no-access' | 'no-room' | 'no-model' | 'down';

/**
 * Whether the key picked for "Another model" can look at images for this bot now: it is there, it may run this bot (lent here,
 * its owner still manages the bot, see lib/ai-key-pay.ts), it belongs to the same person as the key the bot runs on when that is a
 * person's key (#709: images follow whoever's key the bot is on), the model is one with Vision on it, and the key isn't Down
 * (`recheck`: a Down key is asked to check itself again when it is due, as a main key is).
 */
export async function usableVisionKey(
  pick: Extract<VisionPick, { choice: 'another' }>,
  bot: { id: string | null; createdById: string | null; roomId: string },
  options: { recheck?: boolean; mainKeyOwnerId?: string | null } = {}
): Promise<{ ok: true; key: BotsAiProvider } | { ok: false; problem: AnotherProblem; key: BotsAiProvider | null }> {
  const key = await prisma.botsAiProvider.findUnique({ where: { providerId: pick.keyId } });
  if (!key || !key.ownerId) return { ok: false, problem: 'gone', key: null };
  if (options.mainKeyOwnerId && options.mainKeyOwnerId !== key.ownerId) return { ok: false, problem: 'other-owner', key };
  const verdict = await checkKeyForBot({ keyId: key.providerId, keyOwnerId: key.ownerId, bot });
  if (!verdict.ok) return { ok: false, problem: verdict.reason, key };
  // A model the lend there leaves out (#575) is not one this bot may use, for images either
  if (!keyVisionModels(key).includes(pick.model) || (verdict.lendModels && !verdict.lendModels.includes(pick.model))) return { ok: false, problem: 'no-model', key };
  if (key.downSince) {
    // A key used only for images is never asked for as a bot's main key, so nothing else would check it again: ask here (the
    // 5-minute rule is the same). The answer does not wait for the check; the next request sees what it found.
    if (options.recheck) {
      recheckIfDue({ ...key, ifDown: 'universe-ai' }).catch((error) => {
        console.error('[AiKeys] Recheck of a vision key failed:', error instanceof Error ? error.message : 'unknown');
      });
    }
    return { ok: false, problem: 'down', key };
  }
  return { ok: true, key };
}

/**
 * Checks a vision pick being saved with a bot. Nothing picked, the pick the bot already has, "this" and "universe-ai" (while it
 * has a provider to run on) are fine for anyone who may save the bot. "another" is a key, so only its owner may choose it
 * (#709), and only a model with Vision on a key lent to the bot's universe. Returns a message for a 400, or null.
 */
export async function checkVisionPick(
  raw: unknown,
  context: { current: VisionPick | null; actorId: string | null; makerId: string | null; roomId: string; botId: string | null; mainRef?: string | null }
): Promise<string | null> {
  if (raw === undefined || raw === null) return null;
  const pick = parseVisionPick(raw);
  if (!pick) return 'Pick where images go: This model, Another model or Universe AI.';
  if (samePick(pick, context.current)) return null;
  if (pick.choice === 'this') return null;
  if (pick.choice === 'universe-ai') return (await resolveUniverseAiProvider()) ? null : UNIVERSE_AI_MISSING;
  const key = await prisma.botsAiProvider.findUnique({ where: { providerId: pick.keyId }, select: { ownerId: true } });
  if (!key || !key.ownerId || key.ownerId !== context.actorId) return 'That key isn’t there.';
  // Images follow whoever's key the bot runs on (#709): on someone else's key, they stay off yours
  if (context.mainRef && context.mainRef !== pick.keyId) {
    const main = await prisma.botsAiProvider.findUnique({ where: { providerId: context.mainRef }, select: { ownerId: true } });
    if (main?.ownerId && main.ownerId !== context.actorId) return OTHER_OWNER_TEXT;
  }
  const usable = await usableVisionKey(pick, { id: context.botId, createdById: context.makerId, roomId: context.roomId });
  if (usable.ok) return null;
  switch (usable.problem) {
    case 'no-model':
      return 'That model can’t look at images on this key.';
    case 'down':
      return 'That key is down right now. Pick it again when it’s back.';
    case 'gone':
      return 'That key isn’t there.';
    case 'other-owner':
      return OTHER_OWNER_TEXT;
    default:
      return KEY_FOR_BOT_TEXT[usable.problem];
  }
}

const OTHER_OWNER_TEXT = 'This bot runs on someone else’s key, so its images can’t go to your key. Move it to your key first.';

/** The same check for a bot's whole behavior config as it arrives on a save: only a `vision` key in it is judged here. */
export async function checkConfigVision(
  behaviorConfig: unknown,
  context: { storedConfig: unknown; actorId: string | null; makerId: string | null; roomId: string; botId: string | null; mainRef?: string | null }
): Promise<string | null> {
  if (!behaviorConfig || typeof behaviorConfig !== 'object' || !('vision' in behaviorConfig)) return null;
  return checkVisionPick((behaviorConfig as Record<string, unknown>).vision, {
    current: readVisionPick(context.storedConfig),
    actorId: context.actorId,
    makerId: context.makerId,
    roomId: context.roomId,
    botId: context.botId,
    mainRef: context.mainRef,
  });
}

/**
 * A bot someone moves to another key or Universe AI (#709) stops sending images to a key picked for "Another model" that isn't
 * theirs: the owner of that key no longer pays for this bot, and images go back to the default (the new key's own Vision model,
 * else Universe AI). Returns the config without that pick, or null when nothing changes.
 */
export async function dropOthersVisionKey(config: unknown, actorId: string | null): Promise<Record<string, unknown> | null> {
  const pick = readVisionPick(config);
  if (pick?.choice !== 'another' || !config || typeof config !== 'object') return null;
  const key = await prisma.botsAiProvider.findUnique({ where: { providerId: pick.keyId }, select: { ownerId: true } });
  if (key?.ownerId && key.ownerId === actorId) return null;
  const rest = { ...(config as Record<string, unknown>) };
  delete rest.vision;
  return rest;
}
