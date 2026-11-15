import { definitionSchema, hashDefinition, type Definition } from '@/lib/app-direct/definition';

/**
 * Services we ship tested definitions for. A convenience, not a limit: any other service works the same way from a draft the
 * owner confirms (game #2044), and nobody has to approve either.
 *
 * `verified: true` marks an operation we classified ourselves, so it keeps that classification. Every operation of a draft is
 * unverified, whatever its method.
 */
/**
 * Services we could ship tested setups for. The list is empty on purpose: payment services differ by country and owner (Stripe,
 * MyFatoorah, UPayments, Hesabi and others), so no one service is built in. Any service works the same way from a draft the
 * owner's own Brick writes from that service's docs and the owner confirms (game #2044); nobody has to approve it. A shipped
 * setup, if one is ever added, goes in `SHIPPED`.
 *
 * `verified: true` marks an operation we classified ourselves, so it keeps that classification. Every operation of a draft is
 * unverified, whatever its method.
 */
const SHIPPED: Definition[] = [];

export interface CatalogEntry {
  service: string;
  name: string;
  short: string;
  origin: string;
}

/** The three reads of a list of shipped setups. A function so the tests can read a list of their own. */
export function makeCatalog(shipped: Definition[]) {
  const list = shipped.map((definition) => definitionSchema.parse(definition));
  const listCatalog = (): CatalogEntry[] => list.map((definition) => ({ service: definition.service, name: definition.name, short: definition.short, origin: definition.origin }));
  /** A copy of a shipped definition, or null. A copy: nothing that reads it can change the list. */
  const catalogDefinition = (service: string): Definition | null => {
    const found = list.find((definition) => definition.service === service);
    return found ? (structuredClone(found) as Definition) : null;
  };
  const catalogHash = (service: string): string | null => {
    const found = catalogDefinition(service);
    return found ? hashDefinition(found) : null;
  };
  return { listCatalog, catalogDefinition, catalogHash };
}

export const { listCatalog, catalogDefinition, catalogHash } = makeCatalog(SHIPPED);
