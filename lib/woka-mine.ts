import { prisma } from '@/lib/db';
import { buildWokaListPayload, resolvePickerSets } from '@/lib/avatar-catalog';
import { textureInfo, textureUrl } from '@/lib/woka-avatar';
import { RECENT_EXPIRY_MS } from '@/lib/user-outfits';
import { companionWearableHere, wearableManyHere, type WearableContext, type WearableReason } from '@/lib/woka-wearable';
import { getCompanionMap, getWokaList } from '@/lib/wokas';

/** How many Wokas the Recent list shows, the one worn now included. */
export const RECENT_LIMIT = 4;
/** How many saved outfits are looked at (the table keeps ten; older backfilled rows can be more until the next pick). */
const LOOK_AT = 40;

type Texture = { id: string; url: string };

export interface WokaMine {
  current: { textures: Texture[]; name: string | null; wearableHere: boolean; reason?: WearableReason; placeName?: string } | null;
  suggestion: { textures: Texture[]; name: string | null; lastWorn: boolean } | null;
  recent: { textures: Texture[]; name: string | null; current: boolean }[];
  companion: { id: string; url: string; wearableHere: boolean } | null;
}

function playServiceUrl(): string {
  return (process.env.PLAY_URL || process.env.NEXT_PUBLIC_PLAY_URL || 'http://play.workadventure.localhost').replace(/\/$/, '');
}

/**
 * What the game's Woka picker and "can't be worn here" popup need for a signed-in person in one world: the Woka they
 * wear now (and whether this world allows it), the one to suggest instead, their Recent list (at most four, the one
 * worn now first, only what this world allows, nothing not worn for 30 days), and their companion.
 */
export async function buildWokaMine(userId: string, ctx: WearableContext, now: Date = new Date()): Promise<WokaMine> {
  const [person, rows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { companionTextureId: true } }),
    prisma.userOutfit.findMany({ where: { userId }, orderBy: { lastWornAt: 'desc' }, take: LOOK_AT }),
  ]);
  const checks = await wearableManyHere(rows.map((row) => row.textureIds), ctx);

  const fresh = now.getTime() - RECENT_EXPIRY_MS;
  // The Woka worn now is the newest row and never expires; the others must be recent and allowed here.
  const wanted = rows.map((row, index) => index === 0 || (checks[index].wearable && row.lastWornAt.getTime() >= fresh));
  const info = await textureInfo(rows.filter((_row, index) => wanted[index]).flatMap((row) => row.textureIds));
  const draw = (textureIds: string[]): Texture[] | null => {
    const textures: Texture[] = [];
    for (const id of textureIds) {
      const found = info.get(id);
      if (!found) return null;
      textures.push({ id, url: found.url });
    }
    return textures;
  };
  // The name of a single-texture Woka; an outfit of several layers has none and the game writes "Your WOKA".
  const nameOf = (textureIds: string[]): string | null => {
    const found = textureIds.length === 1 ? info.get(textureIds[0]) : undefined;
    return found?.isWoka ? found.name : null;
  };

  let current: WokaMine['current'] = null;
  const recent: WokaMine['recent'] = [];
  rows.forEach((row, index) => {
    if (!wanted[index]) return;
    if (index === 0) {
      // Parts we can't draw any more are left out of the picture rather than hiding the Woka.
      const textures = row.textureIds.flatMap((id) => (info.get(id) ? [{ id, url: info.get(id)!.url }] : []));
      const check = checks[0];
      current = {
        textures,
        name: nameOf(row.textureIds),
        wearableHere: check.wearable,
        ...(check.reason ? { reason: check.reason } : {}),
        ...(check.placeName ? { placeName: check.placeName } : {}),
      };
      if (!check.wearable) return;
    }
    if (recent.length >= RECENT_LIMIT) return;
    const textures = draw(row.textureIds);
    if (textures) recent.push({ textures, name: nameOf(row.textureIds), current: index === 0 });
  });

  let suggestion: WokaMine['suggestion'] = null;
  const lastWorn = recent.find((entry) => !entry.current);
  if (lastWorn) {
    suggestion = { textures: lastWorn.textures, name: lastWorn.name, lastWorn: true };
  } else {
    // Nothing worn lately is allowed here: the first Woka of this world's picker list.
    const sets = await resolvePickerSets({ prisma, worldId: ctx.worldId, universeId: ctx.universeId, userId, membershipTags: ctx.membershipTags });
    const payload = sets.length === 0 ? getWokaList(playServiceUrl()) : buildWokaListPayload(sets, playServiceUrl());
    const first = payload.woka?.collections?.find((collection) => collection.textures.length > 0)?.textures[0];
    if (first) suggestion = { textures: [{ id: first.id, url: textureUrl(first.url) }], name: first.name ?? null, lastWorn: false };
  }

  let companion: WokaMine['companion'] = null;
  if (person?.companionTextureId) {
    const id = person.companionTextureId;
    const check = await companionWearableHere(id, ctx);
    const fromSet = await prisma.avatarCompanion.findFirst({ where: { textureId: id, isActive: true }, select: { url: true } });
    const url = fromSet?.url ?? getCompanionMap(playServiceUrl()).get(id)?.url;
    if (url) companion = { id, url: textureUrl(url), wearableHere: check.wearable };
  }

  return { current, suggestion, recent, companion };
}
