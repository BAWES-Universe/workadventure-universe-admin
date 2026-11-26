import type { AppConnection } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * A person's own copy of an App comes first (Khalid, 26 Nov 2026): when a Brick has the person's own Exa (added by its link, or with their
 * key) and the ready-made Exa too, the ready-made one is not offered, not suggested and not picked, so their own account and free plan is
 * what runs and Universe never pays for, counts or limits it. This file is the ONE rule for "the same App", used by Orbit everywhere
 * (suggestions, the list the bot server reads, Instant, the computer's route) so no two places decide it differently.
 *
 * Own: an App that costs Universe nothing to use: added by its link (`source: link`), from the list a super admin keeps (`listed`) or with
 * the person's key (`kind: direct`). Universe's own GitHub (`github`) and a ready-made App (`ready_made`) are not.
 *
 * Two Apps are the same when:
 *  - their names are the same, read loosely ("Google Calendar", "google_calendar" and "googlecalendar" are one), or
 *  - the other App's key or name is the name the own App's address is registered under ("https://mcp.exa.ai/mcp" is Exa, "api.tavily.com" is
 *    Tavily). Only that one whole name counts: never a part of the host before it ("slack.mycorp.com" is mycorp, not Slack), never a part of
 *    a name with a hyphen ("linear-algebra.example.com" is example), never the address's ending, a word every address has ("mcp", "api") or a
 *    name shorter than 3 letters. An address on a hosting service ("my-tool.vercel.app", "user.github.io", "x.supabase.co") is registered
 *    under the name before the service's, never the service's own ("mytool", not Vercel).
 *
 * Only an own copy that works counts (connected, switched on for this Brick, the Brick owner's own): a broken own copy never hides the
 * ready-made one, so the Brick is never left with neither.
 */

/** A name read loosely: lower case, letters and digits only. */
export const looseName = (value: string | null | undefined): string => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const SAYS_NOTHING = new Set(['www', 'api', 'apis', 'mcp', 'app', 'apps', 'server', 'servers', 'service', 'services', 'gateway', 'com', 'net', 'org', 'edge', 'remote', 'cloud']);
const SHORTEST_WORD = 3;

/** Endings of two parts (".co.uk", ".com.kw"): the name an address is registered under is the part before both. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/** Hosting services: an address under one of these is registered under the name before it, never the service's own. */
const HOSTED = [
  'vercel.app', 'netlify.app', 'github.io', 'gitlab.io', 'supabase.co', 'supabase.in', 'herokuapp.com', 'onrender.com', 'up.railway.app', 'railway.app',
  'fly.dev', 'workers.dev', 'pages.dev', 'trycloudflare.com', 'glitch.me', 'repl.co', 'replit.app', 'replit.dev', 'ngrok.app', 'ngrok.io', 'ngrok-free.app', 'ngrok.dev',
  'azurewebsites.net', 'cloudfunctions.net', 'appspot.com', 'run.app', 'amazonaws.com', 'on.aws', 'deno.dev', 'modal.run', 'smithery.ai', 'web.app', 'firebaseapp.com',
  'pipedream.net', 'val.run', 'vercel.sh', 'koyeb.app', 'northflank.app', 'azurecontainerapps.io', 'cloudrun.dev', 'hf.space',
];

/** The name an address is registered under, read loosely, as the only word of it that can name an App ([] when it names nothing). */
export function addressWords(address: string | null | undefined): string[] {
  let host: string;
  try {
    host = new URL(address ?? '').hostname.toLowerCase();
  } catch {
    return [];
  }
  // A bare address (an IP, localhost) names nothing
  if (!host.includes('.') || /^[0-9.]+$/.test(host) || host.startsWith('[')) return [];
  const labels = host.split('.');
  // On a hosting service the person's own name is the part right before the service's (and the deeper parts of a cloud's address say nothing)
  const hosted = HOSTED.find((suffix) => host.endsWith(`.${suffix}`));
  const ending = hosted
    ? hosted.split('.').length
    : labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2])
      ? 2
      : 1;
  if (labels.length <= ending) return [];
  const registered = looseName(labels[labels.length - 1 - ending]);
  return registered.length >= SHORTEST_WORD && !SAYS_NOTHING.has(registered) ? [registered] : [];
}

export interface OwnAppLike {
  name: string;
  serverUrl: string | null;
}

export interface OtherAppLike {
  /** The App's key (a ready-made App's toolkit, a listed App's key). */
  key?: string | null;
  name?: string | null;
}

/** The own App and the other one are the same App. */
export function sameApp(own: OwnAppLike, other: OtherAppLike): boolean {
  const names = [looseName(other.key), looseName(other.name)].filter((name) => name.length > 0);
  if (names.length === 0) return false;
  const ownName = looseName(own.name);
  if (ownName && names.includes(ownName)) return true;
  const words = addressWords(own.serverUrl);
  return names.some((name) => name.length >= SHORTEST_WORD && words.includes(name));
}

/** The App costs Universe nothing: the person's own link, a listed App they signed in to, or their own key. */
export const isOwnApp = (connection: Pick<AppConnection, 'source' | 'kind'> | null | undefined): boolean =>
  !!connection && (connection.kind === 'direct' || ((connection.kind ?? 'mcp') === 'mcp' && (connection.source === 'link' || connection.source === 'listed')));

/** A ready-made App (paid for by Universe at the provider's rate). */
export const isReadyMade = (connection: Pick<AppConnection, 'source'> | null | undefined): boolean => connection?.source === 'ready_made';

export interface OwnGrant {
  /** The grant's id (a link App's server id, or a key App's id as GET .../key-apps gives it). */
  serverId: string;
  name: string;
  serverUrl: string | null;
}

interface SeenByBotServer {
  /** `direct` for a key App: its "did not answer" is Orbit's own, from its last call, and only holds for a while (KEY_NO_ANSWER_HOLDS_MS). */
  kind?: string | null;
  signInLostAt?: Date | null;
  noAnswerAt?: Date | null;
}

/**
 * How long a key App that did not answer gives way to the ready-made copy of the same App. Nothing but a call to it can tell it answers again
 * (the bot server does not look at a key App between calls), so after this the person's own copy is the way again: if it is still down, that
 * call fails, is written again (lib/tool-signin.ts reportKeyNoAnswer), and the ready-made copy takes over for another while. The Brick is never
 * moved to a copy Universe pays for for good because of one bad moment.
 */
export const KEY_NO_ANSWER_HOLDS_MS = 15 * 60_000;

const stillNoAnswer = (one: SeenByBotServer, now: number): boolean =>
  !!one.noAnswerAt && (one.kind !== 'direct' || now - one.noAnswerAt.getTime() < KEY_NO_ANSWER_HOLDS_MS);

/**
 * The ONE rule for "the person's own copy works", used by every place that lets a ready-made copy give way to it: it is connected
 * (`connectedState(...).connected`, lib/app-connections.ts, passed in so this file needs nothing of it) and the bot server has not seen it
 * fail since (a refused sign-in or key, or a server that did not answer), on the App or on its grant on the Brick. A key App's "did not
 * answer" holds for KEY_NO_ANSWER_HOLDS_MS, then its next call tries it again. A link App with a key
 * counts as connected whatever its key does, so what the bot server saw is what tells a broken one: the Brick is never left with neither.
 */
export const ownCopyWorks = (connected: boolean, ...seen: (SeenByBotServer | null | undefined)[]): boolean => {
  const now = Date.now();
  return connected && seen.every((one) => !one || (!one.signInLostAt && !stillNoAnswer(one, now)));
};

/**
 * The Brick owner's own Apps that are switched on for their Brick and work (ownCopyWorks): what a ready-made copy of the same App gives
 * way to. None for a room bot (an App lent to a universe, or a universe's own, is not a person's own copy there) and none for an own App
 * whose sign-in or key stopped working or whose server stopped answering. `connected` is the caller's `connectedState(...).connected`.
 */
export async function ownGrantsOf(botId: string, connected: (connection: AppConnection) => boolean): Promise<OwnGrant[]> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true, roomId: true, deletedAt: true } });
  if (!bot?.ownerId || bot.roomId !== null || bot.deletedAt !== null) return [];
  const rows = await prisma.botMcpServer.findMany({
    where: { botId, enabled: true, connection: { ownerId: bot.ownerId } },
    include: { connection: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.flatMap((row) =>
    row.connection && isOwnApp(row.connection) && ownCopyWorks(connected(row.connection), row.connection, row) ? [{ serverId: row.id, name: row.connection.name || row.name, serverUrl: row.connection.serverUrl }] : [],
  );
}

/** The first own grant that is the same App as this one, or null. */
export function ownCopyOf(own: readonly OwnGrant[], other: OtherAppLike): OwnGrant | null {
  return own.find((grant) => sameApp(grant, other)) ?? null;
}
