import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { memoryItemsOf, withoutForgotten, withoutItems, MEMORY_ITEM_KINDS, type ForgottenKey, type MemoryItem, type MemoryItemKind } from '@/lib/bot-memory-items';

/**
 * A person's own view of what a bot remembers about them, and their Forget (game #2003). It is for the person alone:
 * the bot's owner, its managers and a super admin never read the list through here, and nothing here takes a "who" from
 * the request body. A bot's memory is kept per bot and person (`bots_memory`), so another person's rows are never found.
 */

export interface Remembering {
  /** Their Orbit account. */
  userId: string;
  /** The ids the bot server may have named them by: their uuid, and their email for sign-ins that name people by it. */
  refs: string[];
}

export async function rememberingOf(userId: string): Promise<Remembering | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, uuid: true, email: true, isGuest: true } });
  if (!user || user.isGuest) return null;
  return { userId: user.id, refs: [user.uuid, ...(user.email ? [user.email] : [])] };
}

function rowsWhere(botId: string, who: Remembering): Prisma.BotsMemoryWhereInput {
  return { botId, OR: [{ userId: who.userId }, { userUuid: { in: who.refs } }] };
}

/** What was forgotten for these people of this bot, by who. */
async function forgottenFor(botId: string, userUuids: string[]): Promise<Map<string, ForgottenKey[]>> {
  const rows = userUuids.length === 0 ? [] : await prisma.botMemoryItemForget.findMany({ where: { botId, userUuid: { in: userUuids } }, select: { userUuid: true, itemKey: true, createdAt: true } });
  const byPerson = new Map<string, ForgottenKey[]>();
  for (const row of rows) byPerson.set(row.userUuid, [...(byPerson.get(row.userUuid) ?? []), { itemKey: row.itemKey, createdAt: row.createdAt }]);
  return byPerson;
}

export interface MyMemory {
  items: MemoryItem[];
}

/** What the bot remembers about this person, from every row it keeps for them, without what they forgot. */
export async function listMyMemory(botId: string, who: Remembering): Promise<MyMemory> {
  const rows = await prisma.botsMemory.findMany({ where: rowsWhere(botId, who), select: { userUuid: true, memories: true } });
  const forgotten = await forgottenFor(botId, rows.map((row) => row.userUuid));
  const seen = new Set<string>();
  const items: MemoryItem[] = [];
  for (const row of rows) {
    for (const item of memoryItemsOf(withoutForgotten(row.memories, forgotten.get(row.userUuid) ?? []))) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return { items };
}

/**
 * Put a Forget down for good, and drop its thing from the row, in one go. The rows are locked and read again inside the
 * transaction, so a save the bot server sent a moment ago is never written over with what was read before it.
 */
export async function forgetKeys(botId: string, rows: { id: number; userUuid: string; memories: unknown }[], keys: Map<string, MemoryItemKind>): Promise<void> {
  const now = new Date();
  const ids = new Set(keys.keys());
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots_memory WHERE id IN (${Prisma.join(rows.map((row) => row.id))}) FOR UPDATE`;
    const fresh = await tx.botsMemory.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: { id: true, memories: true } });
    for (const row of rows) {
      for (const [itemKey, kind] of keys) {
        await tx.botMemoryItemForget.upsert({
          where: { botId_userUuid_itemKey: { botId, userUuid: row.userUuid, itemKey } },
          // Forgotten again after it was said again: the Forget is as new as the second one
          update: { createdAt: now, droppedAt: null },
          create: { botId, userUuid: row.userUuid, itemKey, kind, createdAt: now },
        });
      }
    }
    for (const row of fresh) {
      await tx.botsMemory.update({ where: { id: row.id }, data: { memories: (withoutItems(row.memories, ids).data ?? Prisma.DbNull) as Prisma.InputJsonValue } });
    }
  });
}

/**
 * Forget one thing, by the id the list gave. False when the bot does not remember it (any more): nothing was written.
 * Every row of theirs that holds it loses it, and the bot server is told to drop it from what it keeps in memory.
 */
export async function forgetMyItem(botId: string, who: Remembering, itemId: string): Promise<boolean> {
  const rows = await prisma.botsMemory.findMany({ where: rowsWhere(botId, who), select: { id: true, userUuid: true, memories: true } });
  const forgotten = await forgottenFor(botId, rows.map((row) => row.userUuid));
  const holding = rows.filter((row) => memoryItemsOf(withoutForgotten(row.memories, forgotten.get(row.userUuid) ?? [])).some((item) => item.id === itemId));
  if (holding.length === 0) return false;
  const kind = memoryItemsOf(holding[0].memories).find((item) => item.id === itemId)?.kind ?? 'fact';
  await forgetKeys(botId, holding, new Map([[itemId, kind]]));
  return true;
}

/**
 * Forget everything the bot remembers about this person: its notes, how it feels about them and the lines it keeps of
 * the chat. The chat itself and their files stay (they are not what a bot remembers). Each thing is also kept as
 * forgotten, so a restored row is as empty as this one, and the bot server drops the person from memory whole, as it
 * does for a Forget a manager pressed (see lib/bot-privacy.ts). Returns how many things were in the list.
 */
export async function forgetMyEverything(botId: string, who: Remembering): Promise<number> {
  const rows = await prisma.botsMemory.findMany({ where: rowsWhere(botId, who), select: { id: true, userUuid: true, memories: true } });
  const now = new Date();
  let count = 0;
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (const row of rows) {
    const items = memoryItemsOf(row.memories);
    count = Math.max(count, items.length);
    for (const item of items) {
      writes.push(
        prisma.botMemoryItemForget.upsert({
          where: { botId_userUuid_itemKey: { botId, userUuid: row.userUuid, itemKey: item.id } },
          update: { createdAt: now, droppedAt: null },
          create: { botId, userUuid: row.userUuid, itemKey: item.id, kind: item.kind, createdAt: now },
        }),
      );
    }
    writes.push(prisma.botsMemory.deleteMany({ where: { id: row.id } }));
  }
  // The person as a whole, by every id the bot server may name them by, saved or not: it drops them from memory, and
  // Orbit skips their saves until it says it did. A row's own id is one of them too.
  for (const userUuid of new Set([...who.refs, ...rows.map((row) => row.userUuid)])) {
    writes.push(prisma.botMemoryForget.create({ data: { botId, userUuid } }));
  }
  await prisma.$transaction(writes);
  return count;
}

/**
 * The bot server's own Forget of one thing it holds for a person, by its key (a "forget that" said in the chat). It may
 * hold a thing Orbit has not saved yet, so this needs no row: the key is kept as forgotten, and a row that has it loses it.
 */
export async function forgetItemKey(botId: string, userUuid: string, itemKey: string, kind: MemoryItemKind): Promise<void> {
  const row = await prisma.botsMemory.findUnique({ where: { botId_userUuid: { botId, userUuid } }, select: { id: true, userUuid: true, memories: true } });
  if (row) {
    await forgetKeys(botId, [row], new Map([[itemKey, kind]]));
    return;
  }
  const now = new Date();
  await prisma.botMemoryItemForget.upsert({
    where: { botId_userUuid_itemKey: { botId, userUuid, itemKey } },
    update: { createdAt: now, droppedAt: null },
    create: { botId, userUuid, itemKey, kind, createdAt: now },
  });
}

export const isMemoryItemKind = (value: unknown): value is MemoryItemKind => typeof value === 'string' && (MEMORY_ITEM_KINDS as readonly string[]).includes(value);

/** What the bot server is told to drop from what it keeps in memory: the things forgotten that it has not reported yet. */
export interface ItemForgetNotice {
  id: string;
  userUuid: string;
  itemKey: string;
  kind: string;
  /** When it was forgotten, in milliseconds: a thing the person said again after this is theirs to keep. */
  at: number;
}

export async function takeItemForgets(botId: string): Promise<ItemForgetNotice[]> {
  const rows = await prisma.botMemoryItemForget.findMany({ where: { botId, droppedAt: null }, select: { id: true, userUuid: true, itemKey: true, kind: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 1000 });
  return rows.map(({ createdAt, ...row }) => ({ ...row, at: createdAt.getTime() }));
}

/** The bot server reports what it dropped. Ids of other bots are ignored. The Forget itself stays. */
export async function acknowledgeItemForgets(botId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { count } = await prisma.botMemoryItemForget.updateMany({ where: { botId, id: { in: ids }, droppedAt: null }, data: { droppedAt: new Date() } });
  return count;
}

/** A save from the bot server, without what these people forgot: one read for all of them. */
export async function withoutForgottenFor<T extends { userUuid: string; memories?: unknown }>(botId: string, entries: T[]): Promise<T[]> {
  if (entries.length === 0) return entries;
  const forgotten = await forgottenFor(botId, [...new Set(entries.map((entry) => entry.userUuid))]);
  if (forgotten.size === 0) return entries;
  return entries.map((entry) => {
    const keys = forgotten.get(entry.userUuid);
    return keys && entry.memories ? { ...entry, memories: withoutForgotten(entry.memories, keys) } : entry;
  });
}

/** The same, for the one memory an immediate save carries. */
export async function withoutForgottenOne(botId: string, userUuid: string, memories: unknown): Promise<unknown> {
  if (!memories) return memories;
  const keys = (await forgottenFor(botId, [userUuid])).get(userUuid);
  return keys ? withoutForgotten(memories, keys) : memories;
}
