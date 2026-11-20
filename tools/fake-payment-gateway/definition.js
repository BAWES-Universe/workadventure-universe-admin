'use strict';
/**
 * The setup of the fake payment service, in the shape Orbit reads (the same shape an owner's Brick writes from a gateway's own docs): two keys (test and
 * live), make a payment link, look a payment up, and what a page may do with it. `definitionFor(origin)` points it at wherever the service is deployed.
 *
 * Register it in Orbit staging as a DRAFT (see README.md): POST /api/me/apps/key-forms { draft: <this>, source: "fake-payment-gateway" }.
 */
function definitionFor(origin) {
  const url = new URL(origin);
  return {
    version: 1,
    service: 'fakepay',
    name: 'Fake Pay',
    short: 'Fake Pay',
    origin: url.origin,
    placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
    keyHint: 'Starts with sk_test_ to try it out, or sk_live_ (a second kind of key, still no money moves)',
    helpUrl: `${url.origin}/docs`,
    modes: { test: 'sk_test_', live: 'sk_live_' },
    operations: [
      {
        id: 'lookUpPayment',
        label: 'Look up a payment',
        method: 'GET',
        path: '/v2/charges/{chargeId}',
        params: [{ name: 'chargeId', type: 'string', in: 'path', required: true, maxLength: 80, description: 'The payment id, like chg_...' }],
        returns: ['id', 'status', 'amount', 'currency', 'description', 'live_mode', 'reference.order', 'transaction.created'],
        category: 'lookUp',
        verified: false,
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
          { name: 'idempotentKey', type: 'string', in: 'body', required: false, maxLength: 80, description: 'The same value again returns the first answer instead of making a second payment' },
          { name: 'notifyUrl', type: 'string', in: 'body', required: false, maxLength: 500 },
        ],
        body: {
          amount: { $param: 'amount' },
          currency: { $param: 'currency' },
          description: { $param: 'description' },
          customer: { first_name: { $param: 'customerName' } },
          redirect: { url: { $param: 'returnUrl' } },
          reference: { order: { $param: 'orderRef' }, idempotent: { $param: 'idempotentKey' } },
          post: { url: { $param: 'notifyUrl' } },
        },
        returns: ['id', 'status', 'amount', 'currency', 'transaction.url', 'reference.order'],
        category: 'make',
        verified: false,
      },
    ],
    payment: {
      create: { operation: 'makePaymentLink', amount: 'amount', currency: 'currency', orderRef: 'orderRef', idempotentKey: 'idempotentKey', returnUrl: 'returnUrl', notifyUrl: 'notifyUrl', customerName: 'customerName', idPath: 'id', checkoutUrlPath: 'transaction.url' },
      checkoutHosts: [url.hostname],
      lookup: {
        operation: 'lookUpPayment',
        idParam: 'chargeId',
        statusPath: 'status',
        successStates: ['CAPTURED'],
        pendingStates: ['INITIATED', 'IN_PROGRESS', 'PENDING'],
        failedStates: ['ABANDONED', 'CANCELLED', 'FAILED', 'DECLINED', 'VOID', 'TIMEDOUT'],
        amountPath: 'amount',
        currencyPath: 'currency',
        orderPath: 'reference.order',
        livePath: 'live_mode',
      },
    },
    check: { operation: 'lookUpPayment', arguments: { chargeId: 'chg_universe_key_check' }, rejected: [401, 403] },
  };
}

module.exports = { definitionFor };
