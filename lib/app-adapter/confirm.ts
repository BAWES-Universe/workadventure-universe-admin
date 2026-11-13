import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/app-adapter';

/**
 * A ready-made app is connected when the provider says the person finished signing in, not when the sign-in was started: a person
 * who closes the provider's page, or lets it expire, has nothing connected. Asks the provider once, for a connection not yet
 * confirmed, and remembers the answer. Null while it is not confirmed, the adapter is off or the provider cannot be reached (it
 * is then asked again next time; nothing is ever shown as connected on a guess).
 */
export async function confirmReadyMade(connection: { id: string; source: string; providerAccountId: string | null; providerConfirmedAt: Date | null }): Promise<Date | null> {
  if (connection.source !== 'ready_made') return null;
  if (connection.providerConfirmedAt) return connection.providerConfirmedAt;
  const adapter = getAdapter();
  if (!adapter || !connection.providerAccountId) return null;
  try {
    if ((await adapter.connectionStatus({ providerAccountId: connection.providerAccountId })) !== 'active') return null;
  } catch {
    return null;
  }
  const now = new Date();
  // Only the sign-in this answer is about: a newer start in the meantime replaced the account id, and its answer is not this one
  const marked = await prisma.appConnection.updateMany({
    where: { id: connection.id, providerAccountId: connection.providerAccountId, providerConfirmedAt: null },
    data: { providerConfirmedAt: now },
  });
  return marked.count > 0 ? now : null;
}
