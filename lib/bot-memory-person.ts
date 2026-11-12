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

/** Everything that writes or forgets one person's memory of one bot takes this first, so they take turns. */
export type MemoryTx = Prisma.TransactionClient;

export async function lockPeople(tx: MemoryTx, botId: string, userUuids: string[]): Promise<void> {
  // In one order, so two of them never wait on each other
  for (const userUuid of [...new Set(userUuids)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bots_memory:${botId}:${userUuid}`}))`;
  }
}

/**
 * One rule for what is written to a person's memory row: the save and every Forget run under the same lock, and a save
 * takes out what was forgotten as it is when it writes, not as it was when the save began. Whatever a Forget wrote before
 * the lock was given is read here; whatever comes after waits until the save is written, and then takes it out.
 */
export async function saveMemoryRow<T>(botId: string, userUuid: string, memories: unknown, write: (tx: MemoryTx, memories: unknown) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockPeople(tx, botId, [userUuid]);
    const rows = memories ? await tx.botMemoryItemForget.findMany({ where: { botId, userUuid }, select: { userUuid: true, itemKey: true, createdAt: true } }) : [];
    const keys: ForgottenKey[] = rows.map(({ itemKey, createdAt }) => ({ itemKey, createdAt }));
    return write(tx, keys.length > 0 ? withoutForgotten(memories, keys) : memories);
  });
}

/**
 * Put a Forget down for good for these people, and drop its thing from their rows, in one go. Under the same lock as a
 * save, the rows are read again inside the transaction, so a save that arrived after the first read is never written
 * over, and one that comes after is stripped by the Forget written here. A person with no row still gets the Forget.
 * `at` is when the person asked, when the bot server tells us late (a report it had to retry): a thing they said again
 * after that is theirs to keep, so a late report must not make the Forget newer than it was. A Forget already kept as
 * newer stays as it is.
 */
export async function forgetKeys(botId: string, userUuids: string[], keys: Map<string, MemoryItemKind>, at?: Date): Promise<void> {
  const now = at ?? new Date();
  const ids = new Set(keys.keys());
  const people = [...new Set(userUuids)];
  await prisma.$transaction(async (tx) => {
    await lockPeople(tx, botId, people);
    const fresh = await tx.botsMemory.findMany({ where: { botId, userUuid: { in: people } }, select: { id: true, memories: true } });
    for (const userUuid of people) {
      for (const [itemKey, kind] of keys) {
        const kept = at ? await tx.botMemoryItemForget.findUnique({ where: { botId_userUuid_itemKey: { botId, userUuid, itemKey } }, select: { createdAt: true } }) : null;
        await tx.botMemoryItemForget.upsert({
          where: { botId_userUuid_itemKey: { botId, userUuid, itemKey } },
          // Forgotten again after it was said again: the Forget is as new as the second one (never older than one already kept)
          update: kept && kept.createdAt > now ? { droppedAt: null } : { createdAt: now, droppedAt: null },
          create: { botId, userUuid, itemKey, kind, createdAt: now },
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
  await forgetKeys(botId, holding.map((row) => row.userUuid), new Map([[itemId, kind]]));
  return true;
}

/**
 * Forget everything the bot remembers about this person: its notes, how it feels about them and the lines it keeps of
 * the chat. The chat itself and their files stay (they are not what a bot remembers). Each thing is also kept as
 * forgotten, so a restored row is as empty as this one, and the bot server drops the person from memory whole, as it
 * does for a Forget a manager pressed (see lib/bot-privacy.ts). Returns how many things were in the list.
 */
export async function forgetMyEverything(botId: string, who: Remembering): Promise<number> {
  const found = await prisma.botsMemory.findMany({ where: rowsWhere(botId, who), select: { id: true, userUuid: true } });
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Locked (with every save of theirs) and read again here, so what a save wrote a moment ago is forgotten too
    await lockPeople(tx, botId, [...who.refs, ...found.map((row) => row.userUuid)]);
    if (found.length > 0) await tx.$queryRaw`SELECT id FROM bots_memory WHERE id IN (${Prisma.join(found.map((row) => row.id))}) FOR UPDATE`;
    const rows = await tx.botsMemory.findMany({ where: rowsWhere(botId, who), select: { id: true, userUuid: true, memories: true } });
    let count = 0;
    for (const row of rows) {
      const items = memoryItemsOf(row.memories);
      count = Math.max(count, items.length);
      for (const item of items) {
        await tx.botMemoryItemForget.upsert({
          where: { botId_userUuid_itemKey: { botId, userUuid: row.userUuid, itemKey: item.id } },
          update: { createdAt: now, droppedAt: null },
          create: { botId, userUuid: row.userUuid, itemKey: item.id, kind: item.kind, createdAt: now },
        });
      }
      await tx.botsMemory.deleteMany({ where: { id: row.id } });
    }
    // The person as a whole, by every id the bot server may name them by, saved or not: it drops them from memory, and
    // Orbit skips their saves until it says it did. A row's own id is one of them too.
    for (const userUuid of new Set([...who.refs, ...rows.map((row) => row.userUuid)])) {
      await tx.botMemoryForget.create({ data: { botId, userUuid } });
    }
    return count;
  });
}

/**
 * The bot server's own Forget of one thing it holds for a person, by its key (a "forget that" said in the chat). It may
 * hold a thing Orbit has not saved yet, so this needs no row: the key is kept as forgotten, and a row that has it loses it.
 */
export async function forgetItemKey(botId: string, userUuid: string, itemKey: string, kind: MemoryItemKind, at?: Date): Promise<void> {
  await forgetKeys(botId, [userUuid], new Map([[itemKey, kind]]), at);
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
