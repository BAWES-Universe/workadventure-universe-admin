import { prisma } from '@/lib/db';
import { getAdapter, AdapterError } from '@/lib/app-adapter';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { createConnection } from '@/lib/app-connections';
import { getMeterSettings, recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';

/**
 * Ready-made apps through the adapter (game #2001, step 8). Everything here answers "not there" while the adapter is off, which
 * is always until Khalid says otherwise, so nothing of it shows anywhere. Connecting an app never makes a computer.
 *
 * Which apps, and the adapter's sign-in setup for each, are a super admin setting (settings.ts), never in code.
 */

/**
 * "Connect" on a ready-made app: starts the person's sign-in on the provider's own page and makes the connection (theirs alone,
 * source `ready_made`), whose link is the person's own at the provider. Null when the adapter is off or the app is not listed or
 * is off: the same answer as an app that does not exist. Asked again, the person's existing connection is returned.
 */
export async function connectReadyMade(ownerId: string, key: string, returnUrl: string): Promise<{ id: string; redirectUrl: string | null; created: boolean } | null> {
  const adapter = getAdapter();
  if (!adapter) return null;
  const app = (await readReadyMadeApps()).find((entry) => entry.key === key && entry.enabled);
  if (!app) return null;
  const existing = await prisma.appConnection.findFirst({ where: { ownerId, providerToolkit: key }, select: { id: true } });
  if (existing) return { id: existing.id, redirectUrl: null, created: false };

  const start = await adapter.startConnect({ person: ownerId, toolkit: key, returnUrl });
  const link = await adapter.appLink({ person: ownerId, toolkits: [key] });
  try {
    const connection = await createConnection(ownerId, {
      name: app.name,
      serverUrl: link.url,
      authType: Object.keys(link.headers).length > 0 ? 'api-key' : 'none',
      authConfig: undefined,
      headers: Object.keys(link.headers).length > 0 ? link.headers : undefined,
      source: 'ready_made',
      providerToolkit: key,
      providerAccountId: start.providerAccountId,
    });
    return { id: connection.id, redirectUrl: start.redirectUrl, created: true };
  } catch (error) {
    // Two taps at once: the other one made it
    const again = await prisma.appConnection.findFirst({ where: { ownerId, providerToolkit: key }, select: { id: true } });
    if (again) return { id: again.id, redirectUrl: null, created: false };
    throw error;
  }
}

export type ReadyMadeUseOutcome =
  | { status: 'done'; ok: boolean; data: unknown }
  | { status: 'off' | 'gone' | 'not_owner' | 'already_asked' | 'unavailable' };

/**
 * One use of a ready-made app for the person who owns it. The meter is written FIRST, under an event id taken from the call's
 * own id, so a retry never counts twice and never runs twice: a call id seen before answers `already_asked` and the provider is
 * not called again (an unclear outcome is looked up by the caller, never repeated). Paid by the universe: the cost is the super
 * admin's setting while it has one (estimated), unknown while empty (never a made-up price). Nothing is refused for the price.
 */
export async function useReadyMade(input: { botId: string; connectionId: string; ownerId: string; tool: string; arguments: Record<string, unknown>; callId: string }): Promise<ReadyMadeUseOutcome> {
  const adapter = getAdapter();
  if (!adapter) return { status: 'off' };
  const connection = await prisma.appConnection.findFirst({ where: { id: input.connectionId, ownerId: input.ownerId, source: 'ready_made' } });
  if (!connection || !connection.providerToolkit) return { status: 'gone' };
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true } });
  if (!bot || bot.roomId !== null || bot.ownerId !== input.ownerId) return { status: 'not_owner' };

  const settings = await getMeterSettings();
  const cost = settings.appUseMicros;
  const written = await recordMeterEvent({
    eventId: `app:${input.callId}`,
    kind: 'app_use',
    pool: 'chat',
    occurredAt: new Date(),
    personKey: personKeyOf({ personId: input.ownerId }),
    personId: input.ownerId,
    botId: input.botId,
    brick: true,
    payerKind: 'universe',
    payerPersonId: null,
    route: 'app',
    jobId: null,
    quantity: 1,
    unit: 'use',
    costMicros: cost,
    basis: cost === null ? 'unknown' : 'estimated',
    sourceRef: null,
    // What was asked is the person's: only which app and which tool, never the arguments
    detail: { toolkit: connection.providerToolkit, tool: input.tool },
  });
  if (!written.recorded) return { status: 'already_asked' };

  try {
    const result = await adapter.use({
      person: input.ownerId,
      toolkit: connection.providerToolkit,
      tool: input.tool,
      arguments: input.arguments,
      providerAccountId: connection.providerAccountId,
      callId: input.callId,
    });
    return { status: 'done', ok: result.ok, data: result.data };
  } catch (error) {
    if (error instanceof AdapterError) console.error('[ReadyMade] Provider failed:', error.message);
    else console.error('[ReadyMade] Could not use:', error instanceof Error ? error.message : 'unknown');
    return { status: 'unavailable' };
  }
}
