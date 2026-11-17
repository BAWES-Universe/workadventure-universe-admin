import { isIP } from 'node:net';
import { BASE_DENIED_NAMES, isInternalAddress, mintEgressKey, normalizeHost } from '@/lib/egress/policy';
import type { NetworkPolicy } from '@/lib/agent37/client';

/**
 * Where Orbit says a Brick computer's internet is: the egress gateways (lib/egress/gateway.ts). Every computer's network rule is an allow
 * list of these addresses and nothing else, and its proxy settings point at them. Two settings:
 *   EGRESS_GATEWAYS         the gateways, comma list of `address:port` (a bare `address` means port 3128). An address is a public IPv4 (Agent37
 *                           lets those through on any port) or a name (Agent37 lets names through on port 443 only, so a name needs :443).
 *   EGRESS_GATEWAY_SECRET   the secret each computer's key is signed with; the gateways hold the same value.
 * Without both, no computer is made and none is made ready: the network rule is never left open (it fails closed), and the readiness page says why.
 */

export interface Gateway {
  host: string;
  port: number;
}

export interface EgressConfig {
  gateways: Gateway[];
  secret: string;
}

const MAX_GATEWAYS = 8;
const DEFAULT_PORT = 3128;

/** The gateways that are written down, or null when none is usable (a malformed entry makes the whole setting unusable, so a typo is never half-applied). */
export function egressConfig(env: NodeJS.ProcessEnv = process.env): EgressConfig | null {
  const secret = (env.EGRESS_GATEWAY_SECRET ?? '').trim();
  if (secret.length < 24) return null;
  const entries = (env.EGRESS_GATEWAYS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_GATEWAYS) return null;
  const gateways: Gateway[] = [];
  for (const entry of entries) {
    const colon = entry.lastIndexOf(':');
    const rawHost = colon > 0 && !entry.endsWith(']') && /^\d+$/.test(entry.slice(colon + 1)) ? entry.slice(0, colon) : entry;
    const port = rawHost === entry ? DEFAULT_PORT : Number(entry.slice(colon + 1));
    const host = normalizeHost(rawHost);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    // Only IPv4 is in Agent37's allow list for other ports, and a gateway on a private address cannot be reached from a computer
    if (isIP(host) === 6) return null;
    if (isIP(host) === 4 && isInternalAddress(host)) return null;
    if (isIP(host) === 0 && port !== 443) return null;
    if (!gateways.some((gateway) => gateway.host === host && gateway.port === port)) gateways.push({ host, port });
  }
  return { gateways, secret };
}

/** The reason there is no usable gateway setting, in words for the team's readiness page. Never the secret. */
export function egressProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (egressConfig(env)) return null;
  if ((env.EGRESS_GATEWAY_SECRET ?? '').trim().length < 24) return 'EGRESS_GATEWAY_SECRET is not set (or shorter than 24 characters)';
  return 'EGRESS_GATEWAYS is not set to usable gateways (a public IPv4 address with a port, or a name on port 443)';
}

/** The allow list a computer gets: the gateways' addresses, once each, and nothing else. */
export function networkFor(config: EgressConfig): { allow: string[] } {
  return { allow: [...new Set(config.gateways.map((gateway) => gateway.host))] };
}

const stored = (entry: string): string => {
  const lower = entry.trim().toLowerCase();
  // Agent37 keeps a bare address as /32
  return isIP(lower) === 4 ? `${lower}/32` : lower;
};

/** Whether what Agent37 says a machine may reach is exactly this allow list (it lowercases names and writes a bare address as /32). Anything else, or nothing said, is not. */
export function sameNetwork(actual: NetworkPolicy | null | undefined, wanted: { allow: string[] }): boolean {
  if (!actual || typeof actual !== 'object' || !Array.isArray(actual.allow)) return false;
  const have = new Set(actual.allow.map((entry) => stored(String(entry))));
  const want = new Set(wanted.allow.map(stored));
  return have.size === want.size && [...want].every((entry) => have.has(entry));
}

/** The key a computer's forwarder presents to the gateways. One computer, a few days; written to the machine again every time it is made ready. */
export function keyFor(config: EgressConfig, ref: string, now: number = Date.now()) {
  return mintEgressKey(config.secret, ref, now);
}

/** The names written to a computer's hosts file as an extra layer (it does not stop a program that asks a gateway by name; the gateway does). */
export function hostsBlockNames(providers: readonly string[]): string[] {
  const names = new Set<string>(['backend.composio.dev', 'app.composio.dev', 'platform.composio.dev', 'composio.dev']);
  for (const name of [...BASE_DENIED_NAMES, ...providers]) {
    const clean = normalizeHost(name);
    // Only whole names a program could ask for, one per line, never a range
    if (clean && isIP(clean) === 0 && /^[a-z0-9.-]+$/.test(clean) && names.size < 60) names.add(clean);
  }
  return [...names].sort();
}

/**
 * The command Orbit runs, as root, on a computer to put its gateway settings in place (`universe-egress apply`, in the image). The settings
 * travel in the command (it crosses Agent37's TLS exec call, as the model key does), never in a file Orbit leaves anywhere.
 */
export function applyCommand(config: EgressConfig, ref: string, hostNames: readonly string[], now: number = Date.now()): string {
  const key = keyFor(config, ref, now);
  const body = JSON.stringify({ gateways: config.gateways.map((gateway) => `${gateway.host}:${gateway.port}`), user: key.user, pass: key.pass, expires: Math.floor(key.expiresAt / 1000) });
  // The names are plain letters, digits, dots and hyphens (checked above), so they need no quoting
  const names = hostNames.filter((name) => /^[a-z0-9.-]+$/.test(name)).join(' ');
  return `universe-egress apply ${names} <<'EGRESS_JSON'\n${body}\nEGRESS_JSON`;
}
