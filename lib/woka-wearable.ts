import { prisma } from '@/lib/db';
import { isInsideDates, isScopedHere, resolvePickerSets } from '@/lib/avatar-catalog';
import { getCompanionMap, getTextureMap } from '@/lib/wokas';

/**
 * The one check for "can this person wear this here", used on room entry, when a pick is saved, and for the Recent list.
 * A Woka (or companion) can be worn in a world when every part is in:
 *  - a set the Woka picker would offer them there (`resolvePickerSets`: active, inside its dates, scoped to the platform,
 *    this universe or this world, public, or restricted and they match a policy, or granted to them directly), or
 *  - an `assigned_only` grant set of theirs that is scoped here, or
 *  - the game's own list (config/woka.json, config/companions.json).
 */
export interface WearableContext {
  worldId: string;
  universeId: string | null;
  userId: string | null;
  membershipTags: string[];
}

/**
 * Why a Woka can't be worn here:
 *  - `removed`: a part is in no active set and not in the game's list (archived, deleted, a draft, or outside its dates);
 *  - `no_access`: a part's set is scoped here, but the person isn't entitled to it;
 *  - `other_place`: a part's set is only scoped to other places.
 */
export type WearableReason = 'removed' | 'no_access' | 'other_place';

export interface WearableResult {
  wearable: boolean;
  reason?: WearableReason;
  /** `other_place` only: the world (or universe) the part's set is scoped to, when there is exactly one. */
  placeName?: string;
}

function playServiceUrl(): string {
  return (process.env.PLAY_URL || process.env.NEXT_PUBLIC_PLAY_URL || 'http://play.workadventure.localhost').replace(/\/$/, '');
}

type Kind = 'layer' | 'companion';

interface Allowed {
  layer: Set<string>;
  companion: Set<string>;
}

/** The texture ids this person may wear in this place. */
async function loadAllowed(ctx: WearableContext): Promise<Allowed> {
  const allowed: Allowed = { layer: new Set(), companion: new Set() };
  const sets = await resolvePickerSets({
    prisma,
    worldId: ctx.worldId,
    universeId: ctx.universeId,
    userId: ctx.userId,
    membershipTags: ctx.membershipTags,
  });
  if (ctx.userId) {
    const now = new Date();
    const grants = await prisma.userAvatarGrant.findMany({
      where: {
        userId: ctx.userId,
        isActive: true,
        grantType: 'assigned_only',
        OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      },
      include: {
        avatarSet: {
          include: {
            layers: { where: { isActive: true } },
            companions: { where: { isActive: true } },
            scopes: true,
          },
        },
      },
    });
    for (const grant of grants) {
      if (
        grant.avatarSet.lifecycle === 'active' &&
        isInsideDates(grant.avatarSet, now) &&
        isScopedHere(grant.avatarSet.scopes, ctx.worldId, ctx.universeId)
      ) {
        sets.push(grant.avatarSet as (typeof sets)[number]);
      }
    }
  }
  for (const set of sets) {
    for (const layer of set.layers) allowed.layer.add(layer.textureId);
    for (const companion of set.companions) allowed.companion.add(companion.textureId);
  }
  return allowed;
}

/** Whether the game's own list has this texture (config/woka.json, config/companions.json). */
function inGameList(kind: Kind, textureId: string, config: { layers?: Map<string, unknown>; companions?: Map<string, unknown> }): boolean {
  return kind === 'layer' ? !!config.layers?.has(textureId) : !!config.companions?.has(textureId);
}

/** Why each of these parts (none of them wearable here) can't be worn here. */
async function reasonsFor(kind: Kind, textureIds: string[], ctx: WearableContext): Promise<Map<string, WearableResult>> {
  const result = new Map<string, WearableResult>();
  if (textureIds.length === 0) return result;
  const where = { textureId: { in: textureIds }, isActive: true, avatarSet: { lifecycle: 'active' } };
  const select = { textureId: true, avatarSet: { select: { availableFrom: true, availableUntil: true, scopes: { select: { scopeType: true, scopeId: true } } } } };
  const rows =
    kind === 'layer'
      ? await prisma.avatarLayer.findMany({ where, select })
      : await prisma.avatarCompanion.findMany({ where, select });
  const now = new Date();
  // Only a set that is active and inside its dates still counts; a part in none of them was removed.
  const live = rows.filter((row) => isInsideDates(row.avatarSet, now));
  const places = new Map<string, Set<string>>();
  const placeIds = { world: new Set<string>(), universe: new Set<string>() };
  for (const row of live) {
    if (isScopedHere(row.avatarSet.scopes, ctx.worldId, ctx.universeId)) {
      result.set(row.textureId, { wearable: false, reason: 'no_access' });
      continue;
    }
    for (const scope of row.avatarSet.scopes) {
      if (scope.scopeType === 'world' || scope.scopeType === 'universe') {
        const key = `${scope.scopeType}:${scope.scopeId}`;
        places.set(row.textureId, (places.get(row.textureId) ?? new Set()).add(key));
        placeIds[scope.scopeType].add(scope.scopeId);
      }
    }
    if (!result.has(row.textureId)) result.set(row.textureId, { wearable: false, reason: 'other_place' });
  }
  const names = new Map<string, string>();
  if (placeIds.world.size) {
    for (const world of await prisma.world.findMany({ where: { id: { in: [...placeIds.world] } }, select: { id: true, name: true } })) {
      names.set(`world:${world.id}`, world.name);
    }
  }
  if (placeIds.universe.size) {
    for (const universe of await prisma.universe.findMany({ where: { id: { in: [...placeIds.universe] } }, select: { id: true, name: true } })) {
      names.set(`universe:${universe.id}`, universe.name);
    }
  }
  for (const [textureId, found] of result) {
    if (found.reason !== 'other_place') continue;
    const keys = places.get(textureId);
    const name = keys && keys.size === 1 ? names.get([...keys][0]) : undefined;
    if (name) found.placeName = name;
  }
  for (const id of textureIds) if (!result.has(id)) result.set(id, { wearable: false, reason: 'removed' });
  return result;
}

const PRIORITY: WearableReason[] = ['removed', 'no_access', 'other_place'];

async function check(kind: Kind, outfits: string[][], ctx: WearableContext): Promise<WearableResult[]> {
  const allowed = await loadAllowed(ctx);
  const set = kind === 'layer' ? allowed.layer : allowed.companion;
  const url = playServiceUrl();
  const config = { layers: getTextureMap(url), companions: getCompanionMap(url) };
  const isWearable = (id: string) => set.has(id) || inGameList(kind, id, config);
  const failing = [...new Set(outfits.flat().filter((id) => !isWearable(id)))];
  const reasons = failing.length ? await reasonsFor(kind, failing, ctx) : new Map<string, WearableResult>();
  return outfits.map((textureIds) => {
    if (textureIds.length === 0) return { wearable: false };
    const missing = textureIds.filter((id) => !isWearable(id));
    if (missing.length === 0) return { wearable: true };
    // The most telling reason among the parts that fail: removed, then no access, then another place.
    const found = missing.map((id) => reasons.get(id) ?? { wearable: false, reason: 'removed' as const });
    for (const reason of PRIORITY) {
      const match = found.find((part) => part.reason === reason);
      if (match) return match.placeName ? { wearable: false, reason, placeName: match.placeName } : { wearable: false, reason };
    }
    return { wearable: false, reason: 'removed' };
  });
}

/** Whether this outfit can be worn here (see the top of the file), and if not, why. */
export async function wearableHere(textureIds: string[], ctx: WearableContext): Promise<WearableResult> {
  return (await check('layer', [textureIds], ctx))[0];
}

/** `wearableHere` for several outfits at once, one lookup of what the person may wear. */
export async function wearableManyHere(outfits: string[][], ctx: WearableContext): Promise<WearableResult[]> {
  return outfits.length ? check('layer', outfits, ctx) : [];
}

/** The same rule for a companion; no companion (null) is always fine. */
export async function companionWearableHere(textureId: string | null, ctx: WearableContext): Promise<WearableResult> {
  if (!textureId) return { wearable: true };
  return (await check('companion', [[textureId]], ctx))[0];
}

/** Where a person is wearing something: the world's universe and their tags in that world. */
export async function wearableContextFor(userId: string, worldId: string): Promise<WearableContext | null> {
  const world = await prisma.world.findUnique({ where: { id: worldId }, select: { universeId: true } });
  if (!world) return null;
  const member = await prisma.worldMember.findUnique({ where: { userId_worldId: { userId, worldId } }, select: { tags: true } });
  return { worldId, universeId: world.universeId, userId, membershipTags: member?.tags ?? [] };
}
