import { prisma } from '@/lib/db';
import { addNotice } from '@/lib/notices';
import { kindInfo } from '@/lib/ai-key-kinds';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';

/**
 * Someone moved a bot off another person's key (#709): anyone who manages a bot may move it to their own key or Universe
 * AI, and only the key's owner can put it back, so that owner is told on Orbit home, with where it went and how to move it
 * back. Nobody is told when they move a bot off their own key, or when a bot leaves a server provider or Universe AI.
 * Telling is extra: the save has gone through either way.
 */
export async function tellKeyOwnerMovedOff(input: {
  bot: { id: string; name: string };
  fromRef: string | null;
  toRef: string | null;
  actorId: string | null;
}): Promise<void> {
  const { bot, fromRef, toRef, actorId } = input;
  if (!fromRef || !actorId || fromRef === toRef || fromRef === UNIVERSE_AI_REF) return;
  try {
    const from = await prisma.botsAiProvider.findUnique({ where: { providerId: fromRef }, select: { name: true, ownerId: true } });
    if (!from?.ownerId || from.ownerId === actorId) return;
    const [actor, to, place] = await Promise.all([
      prisma.user.findUnique({ where: { id: actorId }, select: { name: true } }),
      toRef && toRef !== UNIVERSE_AI_REF ? prisma.botsAiProvider.findUnique({ where: { providerId: toRef }, select: { settings: true } }) : null,
      prisma.bot.findUnique({ where: { id: bot.id }, select: { room: { select: { world: { select: { universe: { select: { name: true } } } } } } } }),
    ]);
    const who = actor?.name ?? 'Someone';
    const target = to ? `${who}’s ${kindInfo((to.settings as { kind?: unknown } | null)?.kind)?.label ?? 'AI key'}` : 'Universe AI';
    const universe = place?.room.world.universe.name;
    await addNotice({
      userId: from.ownerId,
      kind: 'ai-key-moved',
      dedupeKey: `moved-off:${fromRef}:${bot.id}:${new Date().toISOString()}`,
      title: `${bot.name} moved off your key`,
      body: `${who} moved it to ${target}${universe ? ` in ${universe}` : ''}. To move it back, open ${bot.name} and pick ${from.name}.`,
      href: '/admin/you/ai-keys',
    });
  } catch (error) {
    console.error('[AiKeys] Could not tell the key owner:', error instanceof Error ? error.message : 'unknown');
  }
}
