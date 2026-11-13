import type { AppConnection } from '@prisma/client';
import { prisma } from '@/lib/db';
import { lendAccess } from '@/lib/ai-key-lend';

/**
 * Who manages what (game #2001 step 7). A person's own app is managed by that person. A universe's own app is managed by the
 * universe's owner, always, and by the people named as its managers, but only while they still have Manage bots in that
 * universe: someone who leaves stops managing it, and nothing is handed over in their place.
 */

/** True when this person manages this universe's own app. */
export async function managesTeamApp(userId: string, connection: Pick<AppConnection, 'id' | 'universeId'>): Promise<boolean> {
  if (!connection.universeId) return false;
  const access = await lendAccess(userId, connection.universeId);
  if (!access) return false;
  if (access === 'owner') return true;
  return (await prisma.appConnectionManager.count({ where: { connectionId: connection.id, userId } })) > 0;
}

/** True when this person may manage this connection, whether it is their own or their universe's. */
export async function managesConnection(userId: string, connection: Pick<AppConnection, 'id' | 'ownerId' | 'universeId'>): Promise<boolean> {
  if (connection.ownerId) return connection.ownerId === userId;
  return managesTeamApp(userId, connection);
}

/** The connection if this person manages it (their own, or their universe's), else null: anyone else's looks like one that is not there. */
export async function getManagedConnection(connectionId: string, userId: string): Promise<AppConnection | null> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!connection) return null;
  return (await managesConnection(userId, connection)) ? connection : null;
}
