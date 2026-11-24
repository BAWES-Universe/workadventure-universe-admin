import { isIP } from 'node:net';
import { Resolver } from 'node:dns/promises';

/**
 * How the outgoing guards ask for a name: with the resolver library's own network client (c-ares), never `dns.lookup`. `dns.lookup` runs getaddrinfo on libuv's
 * few shared worker threads, only two of which may be on slow I/O at a time, so two names whose servers never answer would leave every other lookup of the
 * process waiting for them. c-ares uses no worker thread, and it ends each try by itself (a time and a number of tries), so a name that never answers frees
 * what it holds. The connection is made to the address that was checked, so it does not matter that this skips the system's hosts file and name-service
 * switch: the guards refuse names that are not public (localhost, internal and local names) before any lookup, and an address a hosts file gave for a public
 * name would not be a public one to connect to.
 */
const TRY_MS = 2_000;
const TRIES = 2;
let resolver: Resolver | null = null;

export async function resolveHost(host: string): Promise<{ address: string; family: number }[]> {
  // An address written out is its own answer (as `dns.lookup` gave it): the resolver library would not know it as a name
  const written = isIP(host);
  if (written) return [{ address: host, family: written }];
  resolver ??= new Resolver({ timeout: TRY_MS, tries: TRIES });
  const [four, six] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const found = [
    ...(four.status === 'fulfilled' ? four.value.map((address) => ({ address, family: 4 })) : []),
    ...(six.status === 'fulfilled' ? six.value.map((address) => ({ address, family: 6 })) : []),
  ];
  if (found.length === 0) throw four.status === 'rejected' ? four.reason : new Error('No address');
  return found;
}
