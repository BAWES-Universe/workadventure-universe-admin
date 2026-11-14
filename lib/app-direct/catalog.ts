import { definitionSchema, hashDefinition, type Definition } from '@/lib/app-direct/definition';

/**
 * Services we ship tested definitions for. A convenience, not a limit: any other service works the same way from a draft the
 * owner confirms (game #2044), and nobody has to approve either.
 *
 * `verified: true` marks an operation we classified ourselves, so it keeps that classification. Every operation of a draft is
 * unverified, whatever its method.
 */
const TAP: Definition = {
  version: 1,
  service: 'tap',
  name: 'Tap Payments',
  short: 'Tap',
  origin: 'https://api.tap.company',
  placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
  keyHint: 'Starts with sk_test_ to try it out, or sk_live_ for real payments',
  helpUrl: 'https://developers.tap.company/docs/api-keys',
  modes: { test: 'sk_test_', live: 'sk_live_' },
  operations: [
    {
      id: 'lookUpPayment',
      label: 'Look up a payment',
      method: 'GET',
      path: '/v2/charges/{chargeId}',
      params: [{ name: 'chargeId', type: 'string', in: 'path', required: true, maxLength: 80, description: 'The payment id, like chg_TS01...' }],
      returns: ['id', 'status', 'amount', 'currency', 'description', 'reference.order', 'reference.transaction', 'transaction.created', 'response.code', 'response.message'],
      category: 'lookUp',
      verified: true,
    },
    {
      id: 'makePaymentLink',
      label: 'Make a payment link',
      method: 'POST',
      path: '/v2/charges',
      params: [
        { name: 'amount', type: 'number', in: 'body', required: true, description: 'The amount in the currency, like 4.500' },
        { name: 'currency', type: 'string', in: 'body', required: true, maxLength: 3, description: 'Three letters, like KWD' },
        { name: 'description', type: 'string', in: 'body', required: false, maxLength: 200 },
        { name: 'customerName', type: 'string', in: 'body', required: true, maxLength: 100 },
        { name: 'returnUrl', type: 'string', in: 'body', required: true, maxLength: 500, description: 'Where the buyer lands after paying' },
        { name: 'orderRef', type: 'string', in: 'body', required: false, maxLength: 80 },
      ],
      body: {
        amount: { $param: 'amount' },
        currency: { $param: 'currency' },
        description: { $param: 'description' },
        threeDSecure: true,
        customer: { first_name: { $param: 'customerName' } },
        source: { id: 'src_all' },
        redirect: { url: { $param: 'returnUrl' } },
        reference: { order: { $param: 'orderRef' } },
      },
      // Where the buyer pays comes back as transaction.url
      returns: ['id', 'status', 'amount', 'currency', 'transaction.url', 'reference.order'],
      category: 'make',
      verified: true,
    },
  ],
  // A look-up of a payment that does not exist: a key Tap accepts answers "not found" (or "bad request"), one it does not answers 401
  check: { operation: 'lookUpPayment', arguments: { chargeId: 'chg_universe_key_check' }, rejected: [401, 403] },
};

const LIST: Definition[] = [definitionSchema.parse(TAP)];

export interface CatalogEntry {
  service: string;
  name: string;
  short: string;
  origin: string;
}

export const listCatalog = (): CatalogEntry[] => LIST.map((definition) => ({ service: definition.service, name: definition.name, short: definition.short, origin: definition.origin }));

/** A copy of a shipped definition, or null. A copy: nothing that reads it can change the list. */
export function catalogDefinition(service: string): Definition | null {
  const found = LIST.find((definition) => definition.service === service);
  return found ? (structuredClone(found) as Definition) : null;
}

export const catalogHash = (service: string): string | null => {
  const found = catalogDefinition(service);
  return found ? hashDefinition(found) : null;
};
