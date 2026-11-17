import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { claimAppSlot, AppsFull, maxAppsPerBot } from '@/lib/bot-limits';

/**
 * Default access (game #2044): a key app is available to ALL its owner's current and future Bricks, for the owner's own requests,
 * with nothing to switch on. It is a grant row like any app's, so what is already built for grants works unchanged: an explicit
 * Off is the row's switch, a removed grant is a deleted row, taking it away and disconnecting end every approval at once.
 *
 * A grant is only ever from a person to their own Brick (the database holds that line), is never for a room bot, never follows
 * a transferred Brick, and never carries the key: a grant of a key app has no way in at all (`effectiveServer`).
 *
 * Rows are written by connecting (every Brick the person has) and by making a Brick (every key app the person has). A Brick that
 * is already at its limit of Apps is skipped and says so when asked; nothing is dropped to make room.
 */

type Db = Prisma.TransactionClient | typeof prisma;

async function grantOne(tx: Prisma.TransactionClient, ownerId: string, botId: string, connection: { id: string; name: string }): Promise<boolean> {
  try {
    await claimAppSlot(tx, botId);
  } catch (error) {
    if (error instanceof AppsFull) return false;
    throw error;
  }
  try {
    await tx.botMcpServer.create({ data: { botId, connectionId: connection.id, name: connection.name, serverUrl: '', authType: 'none', connectedById: ownerId } });
    return true;
  } catch (error) {
    // Already there (the same Brick and app twice): the same grant
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
    throw error;
  }
}

/** A key app was just connected: every Brick of the owner's that has none of it gets it. Never throws: the connect has already gone through. */
export async function grantKeyAppToBricks(ownerId: string, connection: { id: string; name: string }): Promise<{ granted: number; full: number }> {
  let granted = 0;
  let full = 0;
  try {
    const bricks = await prisma.bot.findMany({ where: { ownerId, roomId: null, deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    for (const brick of bricks) {
      const had = await prisma.botMcpServer.findFirst({ where: { botId: brick.id, connectionId: connection.id }, select: { id: true } });
      if (had) continue;
      const done = await prisma.$transaction((tx) => grantOne(tx, ownerId, brick.id, connection));
      if (done) granted += 1;
      else full += 1;
    }
  } catch (error) {
    console.error('[KeyApps] Could not give every Brick the app:', error instanceof Error ? error.message : 'unknown');
  }
  return { granted, full };
}

/** A Brick was just made: it gets every key app its owner has. Inside the caller's transaction, so a Brick never exists half-granted. */
export async function grantKeyAppsToNewBrick(tx: Db, ownerId: string, botId: string): Promise<void> {
  const apps = await tx.appConnection.findMany({ where: { ownerId, kind: 'direct' }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  for (const app of apps) {
    // A brand-new Brick has nothing else yet, so the slot count needs no lock; the limit is still held
    if ((await tx.botMcpServer.count({ where: { botId } })) >= (await maxAppsPerBot())) break;
    await tx.botMcpServer.create({ data: { botId, connectionId: app.id, name: app.name, serverUrl: '', authType: 'none', connectedById: ownerId } });
  }
}
