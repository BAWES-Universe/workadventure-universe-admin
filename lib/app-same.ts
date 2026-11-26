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
 *    name shorter than 3 letters.
 */

/** A name read loosely: lower case, letters and digits only. */
export const looseName = (value: string | null | undefined): string => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const SAYS_NOTHING = new Set(['www', 'api', 'apis', 'mcp', 'app', 'apps', 'server', 'servers', 'service', 'services', 'gateway', 'com', 'net', 'org', 'edge', 'remote', 'cloud']);
const SHORTEST_WORD = 3;

/** Endings of two parts (".co.uk", ".com.kw"): the name an address is registered under is the part before both. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

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
  const ending = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 2 : 1;
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

/** This bot's own Apps that are switched on for it: what a ready-made copy of the same App gives way to. */
export async function ownGrantsOf(botId: string): Promise<OwnGrant[]> {
  const rows = await prisma.botMcpServer.findMany({
    where: { botId, enabled: true, NOT: { connectionId: null } },
    select: { id: true, name: true, connection: { select: { name: true, serverUrl: true, source: true, kind: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.flatMap((row) => (row.connection && isOwnApp(row.connection) ? [{ serverId: row.id, name: row.connection.name || row.name, serverUrl: row.connection.serverUrl }] : []));
}

/** The first own grant that is the same App as this one, or null. */
export function ownCopyOf(own: readonly OwnGrant[], other: OtherAppLike): OwnGrant | null {
  return own.find((grant) => sameApp(grant, other)) ?? null;
}
