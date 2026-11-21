'use strict';
// Self-test of the fake service on its own (no Orbit): node --test selftest/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGateway } = require('../core');
const { definitionFor } = require('../definition');

const TEST = { authorization: 'Bearer sk_test_abcdefgh12345678' };
const LIVE = { authorization: 'Bearer sk_live_abcdefgh12345678' };
const CONTROL = { 'x-control-token': 'control-token-0123456789' };

function setup() {
  const clock = { t: Date.parse('2026-11-20T09:00:00Z') };
  const sent = [];
  const gw = createGateway({ now: () => clock.t, publicUrl: 'https://fake.example.org', controlToken: 'control-token-0123456789', send: async (url, body) => (sent.push({ url, body }), 200) });
  const make = (extra = {}, headers = TEST) => gw.handle({ method: 'POST', path: '/v2/charges', headers, json: { amount: 4.5, currency: 'KWD', description: 'A mug', redirect: { url: 'https://orbit.example.org/pay/done?o=o1' }, reference: { order: 'o1', idempotent: 'o1' }, post: { url: 'https://orbit.example.org/api/app-pay/notice/o1' }, ...extra } });
  const look = (id, headers = TEST) => gw.handle({ method: 'GET', path: `/v2/charges/${id}`, headers });
  const control = (method, path, json) => gw.handle({ method, path, headers: CONTROL, json });
  return { clock, sent, gw, make, look, control };
}

test('makes a payment, once per idempotent key, and a key only sees payments of its own kind', () => {
  const { make, look } = setup();
  const a = make();
  const b = make();
  assert.equal(a.status, 200);
  assert.equal(a.body.id, b.body.id);
  assert.equal(a.body.transaction.url, `https://fake.example.org/pay/${a.body.id}`);
  assert.equal(look(a.body.id).body.status, 'INITIATED');
  assert.equal(look(a.body.id, LIVE).status, 404);
  assert.equal(look(a.body.id, { authorization: 'Bearer nope' }).status, 401);
  assert.equal(make({ amount: 0 }).status, 400);
});

test('Pay captures, a notice goes to Orbit, Cancel ends it, and a finished payment cannot be changed', async () => {
  const { make, look, gw, sent } = setup();
  const paid = make().body.id;
  assert.equal(gw.handle({ method: 'GET', path: `/pay/${paid}`, headers: {} }).status, 200);
  const pay = gw.handle({ method: 'POST', path: `/pay/${paid}/pay`, headers: {} });
  assert.equal(pay.status, 303);
  assert.match(pay.redirect, /fake_status=captured/);
  assert.equal(look(paid).body.status, 'CAPTURED');
  await gw.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { id: paid, status: 'CAPTURED', reference: { order: 'o1' } });
  gw.handle({ method: 'POST', path: `/pay/${paid}/cancel`, headers: {} });
  assert.equal(look(paid).body.status, 'CAPTURED');
  const cancelled = make({ reference: { order: 'o2', idempotent: 'o2' } }).body.id;
  gw.handle({ method: 'POST', path: `/pay/${cancelled}/cancel`, headers: {} });
  assert.equal(look(cancelled).body.status, 'CANCELLED');
});

test('a late payment completes by the clock only after the buyer pressed Pay, and says so twice when asked to', async () => {
  const { make, look, gw, sent, clock } = setup();
  const id = make({ description: 'Mug [fake late=45 dup]' }).body.id;
  gw.handle({ method: 'POST', path: `/pay/${id}/pay`, headers: {} });
  assert.equal(look(id).body.status, 'INITIATED');
  clock.t += 44 * 60_000;
  assert.equal(look(id).body.status, 'INITIATED');
  clock.t += 2 * 60_000;
  assert.equal(look(id).body.status, 'CAPTURED');
  await gw.tick();
  assert.equal(sent.length, 2);
});

test('unreadable looks: each kind, for a time, then readable again; a payment made is not affected', () => {
  const { make, look, control, clock } = setup();
  const id = make().body.id;
  for (const [mode, status] of [['5xx', 503], ['401', 401], ['garbage', 200], ['empty', 200]]) {
    control('POST', '/control/unreadable', { mode, seconds: 60 });
    assert.equal(look(id).status, status, mode);
  }
  assert.equal(control('POST', '/control/unreadable', { mode: 'drop', seconds: 60 }).body.unreadable.mode, 'drop');
  assert.equal(look(id).drop, true);
  assert.ok(look(id).status === undefined);
  clock.t += 61_000;
  assert.equal(look(id).body.status, 'INITIATED');
  assert.equal(control('POST', '/control/unreadable', { mode: 'nonsense' }).status, 400);
});

test('a payment made with the answer lost is still made, and asking again gives the same one', () => {
  const { make, control, look } = setup();
  control('POST', '/control/create-fault', { mode: '5xx', times: 1, made: true });
  assert.equal(make().status, 503);
  const again = make();
  assert.equal(again.status, 200);
  assert.equal(look(again.body.id).body.status, 'INITIATED');
});

test('mismatches show only once captured: amount, currency, live and another order', () => {
  const { make, look, control } = setup();
  for (const [flag, expected] of [['amount=1', { amount: 1 }], ['currency=USD', { currency: 'USD' }], ['live', { live_mode: true }], ['order', { reference: { order: 'other-order' } }]]) {
    const id = make({ description: `x [fake ${flag}]`, reference: { order: `m-${flag}`, idempotent: `m-${flag}` } }).body.id;
    assert.equal(look(id).body.amount, 4.5);
    control('POST', `/control/payments/${id}`, { action: 'capture' });
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map((k) => [k, look(id).body[k]])), expected, flag);
  }
});

test('the control API needs its token, and the definition is valid for its own address', () => {
  const { gw } = setup();
  assert.equal(gw.handle({ method: 'GET', path: '/control/state', headers: {} }).status, 401);
  assert.equal(gw.handle({ method: 'GET', path: '/control/state', headers: { 'x-control-token': 'wrong-token-0123456789' } }).status, 401);
  const open = createGateway({ publicUrl: 'https://x.example.org' });
  assert.equal(open.handle({ method: 'GET', path: '/control/state', headers: { 'x-control-token': '' } }).status, 401);
  const def = definitionFor('https://fake.example.org/');
  assert.equal(def.origin, 'https://fake.example.org');
  assert.deepEqual(def.payment.checkoutHosts, ['fake.example.org']);
  assert.equal(gw.handle({ method: 'GET', path: '/definition', headers: {} }).body.origin, 'https://fake.example.org');
});

test('snapshot and restore keep payments across a restart', () => {
  const { make, gw, look } = setup();
  const id = make().body.id;
  const copy = createGateway({ now: gw.now, publicUrl: 'https://fake.example.org' });
  copy.restore(gw.snapshot());
  assert.equal(copy.handle({ method: 'GET', path: `/v2/charges/${id}`, headers: TEST }).body.id, id);
  assert.equal(look(id).body.id, id);
});
