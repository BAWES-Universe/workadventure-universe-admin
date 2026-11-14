import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';
import type { LinkAnswer } from '@/lib/app-adapter/types';
import type { FetchLike } from '@/lib/github/api';
import { gitHubToken, gitHubTokenRefused, GITHUB_SOURCE } from '@/lib/github/connection';
import { GITHUB_TOOLS, isGitHubTool, runGitHubTool } from '@/lib/github/tools';

/**
 * A person's GitHub, answered by Orbit itself as an app link (game #2041): the bot server sends it the same messages it sends any
 * app (POST /api/ready-made/link), and Orbit runs the tool with the person's own token, which never leaves Orbit.
 */

export type GitHubLinkOutcome = { status: 'done'; answer: LinkAnswer } | { status: 'gone' | 'not_owner' | 'already_asked' | 'unavailable' | 'refused' };

const METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);

/**
 * A call sent twice never runs twice (a second "merge" or a second issue), on any Orbit server and after a restart: the call is
 * written to the meter first, under an id taken from the call's own id, and a second write of the same id is refused. GitHub costs
 * nothing, so the row counts no use and no money (quantity 0, cost 0) and is paid by the person (their own GitHub); it is only the
 * record that this call was asked.
 */
async function firstTime(input: { botId: string; ownerId: string; connectionId: string; callId: string; tool: string }): Promise<boolean> {
  const written = await recordMeterEvent({
    eventId: `github:${input.botId}:${input.callId}`,
    kind: 'app_use',
    pool: 'chat',
    occurredAt: new Date(),
    personKey: personKeyOf({ personId: input.ownerId }),
    personId: input.ownerId,
    botId: input.botId,
    brick: true,
    payerKind: 'person',
    payerPersonId: input.ownerId,
    // Not 'app': that route is what Composio's calls are counted by
    route: 'github',
    jobId: null,
    quantity: 0,
    unit: 'use',
    costMicros: 0,
    basis: 'measured',
    sourceRef: null,
    detail: { toolkit: 'github', tool: input.tool, connectionId: input.connectionId },
  });
  return written.recorded;
}

const rpc = (id: unknown, result: unknown, status = 200): LinkAnswer => ({
  status,
  contentType: 'application/json',
  sessionId: null,
  body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }),
});

export async function linkGitHub(
  input: { botId: string; connectionId: string; ownerId: string; message: Record<string, unknown>; callId: string | null },
  fetchImpl: FetchLike = fetch,
): Promise<GitHubLinkOutcome> {
  const method = typeof input.message.method === 'string' ? input.message.method : '';
  if (!METHODS.has(method)) return { status: 'refused' };
  const connection = await prisma.appConnection.findFirst({ where: { id: input.connectionId, ownerId: input.ownerId, source: GITHUB_SOURCE }, select: { id: true } });
  if (!connection) return { status: 'gone' };
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true } });
  if (!bot || bot.roomId !== null || bot.ownerId !== input.ownerId) return { status: 'not_owner' };

  const id = input.message.id;
  switch (method) {
    case 'initialize': {
      const params = (input.message.params ?? {}) as { protocolVersion?: unknown };
      return {
        status: 'done',
        answer: rpc(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'github', title: 'GitHub', version: '1.0.0' },
        }),
      };
    }
    case 'notifications/initialized':
      return { status: 'done', answer: { status: 202, contentType: null, sessionId: null, body: '' } };
    case 'tools/list': {
      // Not signed in (or the sign-in was lost): no tools, so the Brick does not offer what it cannot do
      const token = await gitHubToken(input.connectionId, fetchImpl);
      if (token.status === 'unavailable') return { status: 'unavailable' };
      return { status: 'done', answer: rpc(id, { tools: token.status === 'ok' ? GITHUB_TOOLS : [] }) };
    }
    default: {
      const params = (input.message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string' || !isGitHubTool(params.name) || !input.callId) return { status: 'refused' };
      // The token first: when none can be had (or the owner must sign in again) nothing runs and nothing is kept, so the same call
      // may be asked again once it can work
      const token = await gitHubToken(input.connectionId, fetchImpl);
      if (token.status === 'unavailable') return { status: 'unavailable' };
      if (token.status === 'reconnect') {
        return { status: 'done', answer: rpc(id, { content: [{ type: 'text', text: 'GitHub needs the owner to sign in again (Apps, GitHub, Reconnect).' }], isError: true }) };
      }
      if (!(await firstTime({ botId: input.botId, ownerId: input.ownerId, connectionId: input.connectionId, callId: input.callId, tool: params.name }))) {
        return { status: 'already_asked' };
      }
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const result = await runGitHubTool(token.token, params.name, args, fetchImpl);
      if (result.unauthorized) await gitHubTokenRefused(input.connectionId, token.token);
      return { status: 'done', answer: rpc(id, { content: [{ type: 'text', text: result.text }], isError: result.isError }) };
    }
  }
}
