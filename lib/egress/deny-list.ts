import { prisma } from '@/lib/db';
import { isIpLiteral, normalizeHost } from '@/lib/egress/policy';

/**
 * The names the gateway refuses besides its built-in ones (lib/egress/policy.ts): the API address of every provider Universe AI itself runs
 * on (the server's own providers, never a person's key). They are read here, from Orbit's own list, so a provider added on the Universe AI
 * page is refused by the gateway within minutes without anyone telling the gateway. A computer reaches those providers only through Orbit,
 * which reserves the cost first.
 */
export async function deniedProviderNames(): Promise<string[]> {
  const rows = await prisma.botsAiProvider.findMany({ where: { ownerId: null, NOT: { endpoint: null } }, select: { endpoint: true } });
  const names = new Set<string>();
  for (const row of rows) {
    if (!row.endpoint) continue;
    let host: string | null = null;
    try {
      host = normalizeHost(new URL(row.endpoint).hostname);
    } catch {
      host = null;
    }
    // A provider on an address or on this machine is not a name to refuse here: nothing outside reaches it by name
    if (host && !isIpLiteral(host) && host !== 'localhost') names.add(host);
  }
  return [...names].sort();
}
