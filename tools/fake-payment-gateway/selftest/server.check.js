'use strict';
// The server as it runs: node --test selftest/
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const KEY = { authorization: 'Bearer sk_test_abcdefgh12345678', 'content-type': 'application/json' };
const CONTROL = 'control-token-0123456789';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

async function start(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, PORT: String(port), CONTROL_TOKEN: CONTROL, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  // `require.main === module` is what listens: run it as the main file
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${url}/health`);
      return { url, port, child };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  child.kill();
  throw new Error('the server did not start');
}
const stop = ({ child }) => new Promise((resolve) => {
  child.once('exit', resolve);
  child.kill();
});
const charge = (server, headers = {}, extra = {}) => fetch(`${server.url}/v2/charges`, { method: 'POST', headers: { ...KEY, ...headers }, body: JSON.stringify({ amount: 4.5, currency: 'KWD', description: 'A mug', redirect: { url: 'https://orbit.example.org/pay/done' }, reference: { order: 'o1' }, ...extra }) }).then((r) => r.json());

test('with no BASE_URL, the address of a checkout is the one of the request that makes it, not of whichever request came first', async () => {
  const server = await start({});
  try {
    // a direct request with no forwarded headers (a local health probe) comes first and must fix nothing
    await fetch(`${server.url}/health`);
    const one = await charge(server, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'fake-pay.example.org' }, { reference: { order: 'o1', idempotent: 'o1' } });
    assert.equal(one.transaction.url, `https://fake-pay.example.org/pay/${one.id}`);
    // another address answers with its own, and the payment is the same one everywhere (the state is shared)
    const two = await charge(server, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'other.example.org' }, { reference: { order: 'o2', idempotent: 'o2' } });
    assert.equal(two.transaction.url, `https://other.example.org/pay/${two.id}`);
    const seen = await fetch(`${server.url}/v2/charges/${one.id}`, { headers: KEY }).then((r) => r.json());
    assert.equal(seen.id, one.id);
    // a request with no forwarded headers gets the local address, for itself only
    const direct = await charge(server, {}, { reference: { order: 'o3', idempotent: 'o3' } });
    assert.equal(direct.transaction.url, `http://127.0.0.1:${server.port}/pay/${direct.id}`);
    const again = await charge(server, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'fake-pay.example.org' }, { reference: { order: 'o4', idempotent: 'o4' } });
    assert.equal(again.transaction.url, `https://fake-pay.example.org/pay/${again.id}`);
  } finally {
    await stop(server);
  }
});

test('with BASE_URL, every checkout uses it whatever the request says', async () => {
  const server = await start({ BASE_URL: 'https://fake-pay.example.org/' });
  try {
    await fetch(`${server.url}/health`);
    const made = await charge(server, { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example.org' });
    assert.equal(made.transaction.url, `https://fake-pay.example.org/pay/${made.id}`);
    const definition = await fetch(`${server.url}/definition`, { headers: { host: 'evil.example.org' } }).then((r) => r.text());
    assert.ok(definition.includes('https://fake-pay.example.org'));
    assert.ok(!definition.includes('evil.example.org'));
  } finally {
    await stop(server);
  }
});

test('a notice goes to Orbit when it is listed, and a payment made with an invented key and any address gets no request to that address', async () => {
  const hits = { orbit: [], internal: [] };
  const mk = (list) => http.createServer((req, res) => {
    list.push(req.url);
    res.writeHead(204).end();
  });
  const orbit = mk(hits.orbit);
  const internal = mk(hits.internal);
  await Promise.all([orbit, internal].map((s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))));
  const origin = (s) => `http://127.0.0.1:${s.address().port}`;
  const server = await start({ BASE_URL: 'https://fake-pay.example.org', NOTICE_ORIGINS: origin(orbit) });
  try {
    const good = await charge(server, {}, { reference: { order: 'good', idempotent: 'good' }, post: { url: `${origin(orbit)}/api/app-pay/notice/good` } });
    const bad = await charge(server, {}, { reference: { order: 'bad', idempotent: 'bad' }, post: { url: `${origin(internal)}/admin` } });
    for (const id of [good.id, bad.id]) {
      await fetch(`${server.url}/pay/${id}/pay`, { method: 'POST', redirect: 'manual' });
    }
    for (let i = 0; i < 60 && hits.orbit.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(hits.orbit, ['/api/app-pay/notice/good']);
    // the notice for the other address was given its turn (the clock ticks every second) and nothing came
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(hits.internal, []);
    const notices = await fetch(`${server.url}/control/notices`, { headers: { 'x-control-token': CONTROL } }).then((r) => r.json());
    assert.ok(JSON.stringify(notices).includes(bad.id));
  } finally {
    await stop(server);
    await Promise.all([orbit, internal].map((s) => new Promise((resolve) => s.close(resolve))));
  }
});
