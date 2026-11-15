import type { Definition } from '@/lib/app-direct/definition';
import { definitionSchema } from '@/lib/app-direct/definition';

/**
 * A made-up payment gateway for the tests of key apps. Nothing ships with one: the engine reads any service's setup the same
 * way, and this stands in for a setup an owner's Brick wrote from a gateway's own docs.
 */
const RAW: Definition = {
  version: 1,
  service: 'examplepay',
  name: 'Example Pay',
  short: 'Example',
  origin: 'https://api.examplepay.com',
  placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
  keyHint: 'Starts with sk_test_ to try it out, or sk_live_ for real payments',
  helpUrl: 'https://docs.examplepay.com/api-keys',
  modes: { test: 'sk_test_', live: 'sk_live_' },
  operations: [
    {
      id: 'lookUpPayment',
      label: 'Look up a payment',
      method: 'GET',
      path: '/v2/charges/{chargeId}',
      params: [{ name: 'chargeId', type: 'string', in: 'path', required: true, maxLength: 80, description: 'The payment id, like chg_TS01...' }],
      returns: ['id', 'status', 'amount', 'currency', 'description', 'live_mode', 'reference.order', 'reference.transaction', 'transaction.created', 'response.code', 'response.message'],
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
        { name: 'idempotentKey', type: 'string', in: 'body', required: false, maxLength: 80, description: 'The same value again within 24 hours returns the first answer instead of making a second payment' },
        { name: 'notifyUrl', type: 'string', in: 'body', required: false, maxLength: 500 },
      ],
      body: {
        amount: { $param: 'amount' },
        currency: { $param: 'currency' },
        description: { $param: 'description' },
        threeDSecure: true,
        customer: { first_name: { $param: 'customerName' } },
        source: { id: 'src_all' },
        redirect: { url: { $param: 'returnUrl' } },
        reference: { order: { $param: 'orderRef' }, idempotent: { $param: 'idempotentKey' } },
        post: { url: { $param: 'notifyUrl' } },
      },
      // Where the buyer pays comes back as transaction.url
      returns: ['id', 'status', 'amount', 'currency', 'transaction.url', 'reference.order'],
      category: 'make',
      verified: true,
    },
  ],
  // What a page may do with it: open the gateway's own hosted checkout for a fixed amount, and learn whether it was paid. Paid only when the gateway's own
  // record of the payment says CAPTURED for this order, amount, currency and mode (a notice from the gateway only makes us ask).
  payment: {
    create: { operation: 'makePaymentLink', amount: 'amount', currency: 'currency', orderRef: 'orderRef', idempotentKey: 'idempotentKey', returnUrl: 'returnUrl', notifyUrl: 'notifyUrl', customerName: 'customerName', idPath: 'id', checkoutUrlPath: 'transaction.url' },
    checkoutHosts: ['examplepay.com'],
    lookup: {
      operation: 'lookUpPayment',
      idParam: 'chargeId',
      statusPath: 'status',
      successStates: ['CAPTURED'],
      pendingStates: ['INITIATED', 'IN_PROGRESS', 'PENDING'],
      failedStates: ['ABANDONED', 'CANCELLED', 'FAILED', 'DECLINED', 'RESTRICTED', 'VOID', 'TIMEDOUT'],
      amountPath: 'amount',
      currencyPath: 'currency',
      orderPath: 'reference.order',
      livePath: 'live_mode',
    },
  },
  // A look-up of a payment that does not exist: a key the gateway accepts answers "not found" (or "bad request"), one it does not answers 401
  check: { operation: 'lookUpPayment', arguments: { chargeId: 'chg_universe_key_check' }, rejected: [401, 403] },
};

export const EXAMPLE_GATEWAY: Definition = definitionSchema.parse(RAW);

/** For `jest.mock('@/lib/app-direct/catalog', () => require('../helpers/example-gateway').catalogWithExample())`. */
export const catalogWithExample = () => {
  const actual = jest.requireActual('@/lib/app-direct/catalog') as typeof import('@/lib/app-direct/catalog');
  return { ...actual, ...actual.makeCatalog([EXAMPLE_GATEWAY]) };
};
