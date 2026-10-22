import { prisma } from '@/lib/db';
import { has } from '@/lib/permissions';
import { permissionsForWorld } from '@/lib/roles';
import { addNotice } from '@/lib/notices';
import { UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';

/**
 * Lending a personal AI key to a universe (#374). A person may lend a key where they have Manage bots: the universe's
 * owner, or anyone whose roles give Manage bots in one of its worlds (the same permission number the game gets).
 * Lending moves no bot. When a key stops being lent (pulled, revoked), every bot of that universe on it moves to
 * Universe AI and the universe's owner is told once.
 */

export type LendAccess = 'owner' | 'manage';

export interface LendableUniverse {
  id: string;
  name: string;
  access: LendAccess;
}

/** How this person may lend to this universe: as its owner, with Manage bots in one of its worlds, or not at all. */
export async function lendAccess(userId: string, universeId: string): Promise<LendAccess | null> {
  const universe = await prisma.universe.findUnique({
    where: { id: universeId },
    select: { ownerId: true, worlds: { select: { id: true } } },
  });
  if (!universe) return null;
  if (universe.ownerId === userId) return 'owner';
  const members = await prisma.worldMember.findMany({
    where: { userId, world: { universeId } },
    select: { worldId: true, tags: true },
  });
  const tagsOf = new Map(members.map((member) => [member.worldId, member.tags]));
  for (const world of universe.worlds) {
    const permissions = await permissionsForWorld({ userId, worldId: world.id, universeId, worldTags: tagsOf.get(world.id) ?? [] });
    if (has(permissions, 'MANAGE_BOTS')) return 'manage';
  }
  return null;
}

/** The universes this person could lend a key to, by name. */
export async function lendableUniverses(userId: string): Promise<LendableUniverse[]> {
  const [owned, worldMemberships, universeMemberships] = await Promise.all([
    prisma.universe.findMany({ where: { ownerId: userId }, select: { id: true, name: true } }),
    prisma.worldMember.findMany({ where: { userId }, select: { world: { select: { universe: { select: { id: true, name: true } } } } } }),
    prisma.universeMember.findMany({ where: { userId }, select: { universe: { select: { id: true, name: true } } } }),
  ]);
  const candidates = new Map<string, string>();
  for (const universe of owned) candidates.set(universe.id, universe.name);
  for (const entry of worldMemberships) candidates.set(entry.world.universe.id, entry.world.universe.name);
  for (const entry of universeMemberships) candidates.set(entry.universe.id, entry.universe.name);

  // Each universe is asked at the same time, so the list takes as long as the slowest one, not all of them one after another
  const checked = await Promise.all([...candidates].map(async ([id, name]) => ({ id, name, access: await lendAccess(userId, id) })));
  const result: LendableUniverse[] = [];
  for (const { id, name, access } of checked) if (access) result.push({ id, name, access });
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export interface MovedBots {
  count: number;
  /** Per universe: who owns it and which bots moved, for the notice. */
  universes: { id: string; name: string; ownerId: string; botNames: string[] }[];
}

/**
 * Moves every bot on this key (optionally only in one universe) to Universe AI, and tells each universe's owner once.
 * The owner is not told about their own action, unless Universe AI has no enabled provider: then the bots can't reply
 * until a super admin switches one on, and that is never left unsaid. A notice that can't be saved is logged; the bots
 * have moved either way.
 */
export async function moveBotsOffKey(
  providerId: string,
  options: { universeId?: string; actor: { id: string; name: string | null }; why: 'pulled' | 'revoked' },
): Promise<MovedBots> {
  const bots = await prisma.bot.findMany({
    where: {
      aiProviderRef: providerId,
      ...(options.universeId ? { room: { world: { universeId: options.universeId } } } : {}),
    },
    select: { id: true, name: true, room: { select: { world: { select: { universe: { select: { id: true, name: true, ownerId: true } } } } } } },
  });
  if (bots.length === 0) return { count: 0, universes: [] };

  // Only rows still on the key move, one by one in a single transaction, so a second request that ran at the same time can't be told about or counted twice
  const results = await prisma.$transaction(
    bots.map((bot) => prisma.bot.updateMany({ where: { id: bot.id, aiProviderRef: providerId }, data: { aiProviderRef: UNIVERSE_AI_REF } })),
  );
  const movedBots = bots.filter((_, index) => results[index].count > 0);
  if (movedBots.length === 0) return { count: 0, universes: [] };

  const byUniverse = new Map<string, MovedBots['universes'][number]>();
  for (const bot of movedBots) {
    const universe = bot.room.world.universe;
    const entry = byUniverse.get(universe.id) ?? { id: universe.id, name: universe.name, ownerId: universe.ownerId, botNames: [] };
    entry.botNames.push(bot.name);
    byUniverse.set(universe.id, entry);
  }
  const universes = [...byUniverse.values()];
  const who = options.actor.name || 'Someone';
  const moment = new Date().toISOString();
  // If this can't be checked the move still stands and the usual notice goes out
  const universeAiMissing = await resolveUniverseAiProvider().then(
    (provider) => !provider,
    () => false,
  );
  for (const universe of universes) {
    if (universe.ownerId === options.actor.id && !universeAiMissing) continue;
    const names = universe.botNames;
    try {
      await addNotice({
        userId: universe.ownerId,
        kind: 'ai-key-moved',
        dedupeKey: `moved:${providerId}:${universe.id}:${moment}`,
        title: names.length === 1 ? `${names[0]} moved to Universe AI` : `${names.length} bots moved to Universe AI`,
        body: `${who} ${options.why === 'revoked' ? 'revoked their AI key' : `pulled their AI key from ${universe.name}`}. ${
          names.length === 1 ? 'The bot now replies' : `The ${names.length} bots now reply`
        } on Universe AI.${
          universeAiMissing ? ' Universe AI has no provider switched on yet, so they stay quiet until a super admin enables one.' : ''
        }`,
        href: `/admin/universes/${universe.id}`,
      });
    } catch (error) {
      console.error('[AiKeys] Could not tell the universe owner:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return { count: movedBots.length, universes };
}
