import { createGateway } from '../lib/egress/gateway';
import { DEFAULT_PORTS, defaultPolicy, normalizeHost, type PolicyConfig } from '../lib/egress/policy';

/**
 * Starts Universe's egress gateway (see lib/egress/gateway.ts). Settings, all from the environment:
 *   EGRESS_GATEWAY_SECRET   the secret Orbit signs computers' keys with (the same value as on Orbit). Required.
 *   ORBIT_URL               Orbit's address, where the names of the Universe AI providers are read (GET /api/egress/deny). Optional: without it only the built-in names are refused.
 *   EGRESS_PORT             where it listens (default 3128)
 *   EGRESS_ALLOWED_PORTS    comma list of ports a job may reach (default 22,80,443,8080,8443,9418)
 *   EGRESS_DENY_HOSTS       extra names to refuse, comma list
 *   EGRESS_DENY_CIDRS       our own servers' addresses to refuse, comma list of IPv4 or IPv4/prefix
 */
const secret = (process.env.EGRESS_GATEWAY_SECRET ?? '').trim();
if (secret.length < 24) {
  console.error('[Egress] EGRESS_GATEWAY_SECRET is missing or too short: the gateway does not start');
  process.exit(1);
}

const list = (value: string | undefined) => (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
const port = Number(process.env.EGRESS_PORT ?? 3128);
const allowedPorts = list(process.env.EGRESS_ALLOWED_PORTS).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
const fixed: PolicyConfig = {
  ...defaultPolicy(),
  allowedPorts: allowedPorts.length > 0 ? allowedPorts : DEFAULT_PORTS,
  denyNames: list(process.env.EGRESS_DENY_HOSTS).map((name) => normalizeHost(name)).filter((name): name is string => !!name),
  denyCidrs: list(process.env.EGRESS_DENY_CIDRS),
};
let fromOrbit: string[] = [];
const policy = (): PolicyConfig => ({ ...fixed, denyNames: [...fixed.denyNames, ...fromOrbit] });

/** The providers' names are asked of Orbit every five minutes; an answer that cannot be had leaves the last good one in place. */
async function refresh() {
  const base = (process.env.ORBIT_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) return;
  try {
    const response = await fetch(`${base}/api/egress/deny`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Orbit answered ${response.status}`);
    const body = (await response.json()) as { names?: unknown };
    if (Array.isArray(body.names)) fromOrbit = body.names.filter((name): name is string => typeof name === 'string').map((name) => normalizeHost(name)).filter((name): name is string => !!name);
  } catch (error) {
    console.error('[Egress] The provider names could not be read from Orbit:', error instanceof Error ? error.message : 'unknown');
  }
}

void refresh();
setInterval(() => void refresh(), 5 * 60 * 1000).unref();

const counts = new Map<string, number>();
const gateway = createGateway({
  secret,
  policy,
  log: (event, detail) => {
    // Counted and said once a minute at most per reason: the names of what was refused, never what was sent
    const key = `${event}:${detail.reason ?? ''}`;
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    if (seen === 0 || seen % 100 === 0) console.log(`[Egress] ${event}`, JSON.stringify(detail), `(${seen + 1} so far)`);
  },
});

gateway.server.listen(port, '0.0.0.0', () => console.log(`[Egress] The gateway listens on ${port}`));
const stop = () => {
  gateway.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
