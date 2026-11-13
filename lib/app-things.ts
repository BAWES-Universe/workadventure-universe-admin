import { prisma } from '@/lib/db';
import { connectedState, confirmIfPending } from '@/lib/app-connections';
import { testReadyMade } from '@/lib/app-adapter/ready-made';
import { ensureFreshOAuthConfig } from '@/lib/mcp/oauth-refresh';
import { testMcpConnection } from '@/lib/mcp/test-connection';

/** "GMAIL_FETCH_EMAILS" and "find_events" and "findEvents" read "Fetch Emails", "Find Events", "Find Events". */
export function thingName(toolName: string, toolkit: string | null): string {
  let name = toolName.trim();
  if (toolkit && name.toUpperCase().startsWith(`${toolkit.toUpperCase()}_`)) name = name.slice(toolkit.length + 1);
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-/]+/)
    .filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

/**
 * What an app of this person's can do, in plain names, from the app itself ("Connected · it can do 3 things"). Only for the
 * person's own connection: null for anyone else's, the same as for one that does not exist. An app that is not signed in, or that
 * cannot be reached right now, has no list (an empty one), never an error: the sheet then just says "Connected". Nothing of the
 * link or the sign-in is returned.
 */
export async function thingsForOwnApp(connectionId: string, ownerId: string): Promise<string[] | null> {
  const found = await prisma.appConnection.findFirst({ where: { id: connectionId, ownerId } });
  if (!found) return null;
  const connection = await confirmIfPending(found);
  if (!connectedState(connection).connected) return [];
  let toolNames: string[] = [];
  try {
    if (connection.source === 'ready_made') {
      // The link of a ready-made app needs the provider key, which only Orbit holds: asked through the adapter
      toolNames = (await testReadyMade(connection)).toolNames;
    } else {
      let authConfig = connection.authConfig;
      if (connection.authType === 'oauth' && authConfig) {
        const outcome = await ensureFreshOAuthConfig({ serverId: connection.id, connectionId: connection.id, authConfig, serverUrl: connection.serverUrl });
        if (outcome.status === 'reconnect_required') return [];
        if (outcome.authConfig) authConfig = outcome.authConfig;
      }
      toolNames = (await testMcpConnection({ serverUrl: connection.serverUrl, authType: connection.authType, authConfig, headers: connection.headers as Record<string, string> | null })).toolNames;
    }
  } catch {
    return [];
  }
  return [...new Set(toolNames.map((name) => thingName(name, connection.providerToolkit)).filter(Boolean))];
}
