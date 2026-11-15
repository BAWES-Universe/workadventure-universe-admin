import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/app-adapter';
import type { ReadyMadeAdapter } from '@/lib/app-adapter/types';

/**
 * Test 9 (session activation): turning on Instant for the project must give no old session any new spending power.
 *
 * Composio lets a session whose policy says nothing about Instant run Instant tools once the project switch is on, with no dollar
 * cap, through the MCP link. Sessions made by this version say `instant: false` out loud (lib/app-adapter/composio.ts). This reads
 * every ready-made app's EXISTING session back and switches Instant off on each one that allows it, and writes down what it
 * checked. It only ever turns Instant OFF on a session; nothing here can turn it on.
 */

/** The session id inside an app link (https://backend.composio.dev/tool_router/<id>/mcp, or .../tool_router/v3/<id>/mcp), or null. */
export function sessionIdOfLink(url: string): string | null {
  try {
    const match = /\/tool_router\/(?:v\d+\/)?([^/]+)\/mcp\/?$/.exec(new URL(url).pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export interface SessionSweep {
  checked: number;
  alreadyDenied: number;
  denied: number;
  gone: number;
  /** Links that are not a session link, or sessions Composio could not be asked about right now. They stay unchecked and are looked at again. */
  failed: number;
  /** Ready-made connections still without a checked session after this pass. */
  remaining: number;
}

/** Writes down that a try failed, so the next pass looks at other rows first. It never counts as checked. */
async function markFailed(connectionId: string, sessionId: string): Promise<void> {
  try {
    await prisma.instantSessionCheck.upsert({
      where: { connectionId },
      create: { connectionId, sessionId, state: 'failed' },
      update: { sessionId, state: 'failed', checkedAt: new Date() },
    });
  } catch (error) {
    console.error('[Instant] Could not write a failed try down:', error instanceof Error ? error.message : 'unknown');
  }
}

/** One bounded pass over ready-made connections that have no checked session yet (or whose session changed). Safe to run again and again. */
export async function denyInstantOnSessions(limit = 50, adapter: ReadyMadeAdapter | null = getAdapter()): Promise<SessionSweep> {
  const out: SessionSweep = { checked: 0, alreadyDenied: 0, denied: 0, gone: 0, failed: 0, remaining: 0 };
  const instant = adapter?.instant;
  if (!instant) return out;
  const rows = await prisma.appConnection.findMany({ where: { source: 'ready_made' }, select: { id: true, serverUrl: true } });
  const checks = await prisma.instantSessionCheck.findMany();
  const done = new Map(checks.filter((row) => row.state !== 'failed').map((row) => [row.connectionId, row.sessionId]));
  const triedAt = new Map(checks.map((row) => [row.connectionId, row.checkedAt.getTime()]));
  const todo = rows
    .filter((row) => {
      const id = sessionIdOfLink(row.serverUrl);
      return !id || done.get(row.id) !== id;
    })
    // A row that failed goes to the back of the line, oldest try first, so rows that keep failing never crowd out the rest
    .sort((a, b) => (triedAt.get(a.id) ?? 0) - (triedAt.get(b.id) ?? 0));
  for (const row of todo.slice(0, limit)) {
    const sessionId = sessionIdOfLink(row.serverUrl);
    if (!sessionId) {
      out.failed += 1;
      await markFailed(row.id, '');
      continue;
    }
    try {
      let state = await instant.sessionInstant(sessionId);
      if (state === 'allowed') {
        // Only a session that reads back as denied counts as denied
        state = await instant.denySessionInstant(sessionId);
        if (state === 'denied') out.denied += 1;
      } else if (state === 'denied') out.alreadyDenied += 1;
      if (state === 'gone') out.gone += 1;
      out.checked += 1;
      await prisma.instantSessionCheck.upsert({
        where: { connectionId: row.id },
        create: { connectionId: row.id, sessionId, state: state === 'gone' ? 'gone' : 'denied' },
        update: { sessionId, state: state === 'gone' ? 'gone' : 'denied', checkedAt: new Date() },
      });
    } catch (error) {
      out.failed += 1;
      console.error('[Instant] Could not check a session:', error instanceof Error ? error.message : 'unknown');
      await markFailed(row.id, sessionId);
    }
  }
  out.remaining = Math.max(0, todo.length - out.checked);
  return out;
}

/** How many ready-made connections have a checked session and how many do not. Reads only. */
export async function sessionCheckStatus(): Promise<{ total: number; checked: number; unchecked: number }> {
  const rows = await prisma.appConnection.findMany({ where: { source: 'ready_made' }, select: { id: true, serverUrl: true } });
  const done = new Map((await prisma.instantSessionCheck.findMany({ where: { state: { not: 'failed' } } })).map((row) => [row.connectionId, row.sessionId]));
  const checked = rows.filter((row) => {
    const id = sessionIdOfLink(row.serverUrl);
    return id !== null && done.get(row.id) === id;
  }).length;
  return { total: rows.length, checked, unchecked: rows.length - checked };
}
