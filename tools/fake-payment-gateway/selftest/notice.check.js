'use strict';
// A notice goes only to an origin that was listed, redirects included: node --test selftest/
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseOrigins, allowedUrl, createNoticeSender } = require('../notice');

/** A server on a free port that keeps what it was asked, answering with `answer(req, res)`. */
function listen(answer) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      answer(req, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, origin: `http://127.0.0.1:${server.address().port}` })));
}
const close = (...servers) => Promise.all(servers.map((s) => new Promise((resolve) => s.server.close(resolve))));
const quiet = () => undefined;

test('reads origins from a list, and only origins: no path, no login, no other scheme', () => {
  assert.deepEqual(parseOrigins('https://orbit.example.org, http://127.0.0.1:3000/path https://orbit.example.org'), ['https://orbit.example.org', 'http://127.0.0.1:3000']);
  assert.deepEqual(parseOrigins('ftp://x.example.org file:///etc/passwd nope https://u:p@orbit.example.org'), []);
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins(undefined), []);
});

test('allows an address only when its origin is listed, with no login in it', () => {
  const origins = ['https://orbit.example.org'];
  assert.ok(allowedUrl('https://orbit.example.org/api/app-pay/notice/o1', origins));
  assert.equal(allowedUrl('https://orbit.example.org.evil.example/x', origins), null);
  assert.equal(allowedUrl('https://evil.example/https://orbit.example.org/', origins), null);
  assert.equal(allowedUrl('http://orbit.example.org/x', origins), null);
  assert.equal(allowedUrl('https://orbit.example.org:8443/x', origins), null);
  assert.equal(allowedUrl('https://orbit.example.org@evil.example/x', origins), null);
  assert.equal(allowedUrl('https://u:p@orbit.example.org/x', origins), null);
  assert.equal(allowedUrl('http://localhost:8080/admin', origins), null);
  assert.equal(allowedUrl('http://169.254.169.254/latest/meta-data', origins), null);
  assert.equal(allowedUrl('not an address', origins), null);
  assert.equal(allowedUrl('', origins), null);
});

test('sends a notice to a listed origin, as it always did, and gives back what Orbit answered', async () => {
  const orbit = await listen((req, res) => res.writeHead(204).end());
  try {
    const send = createNoticeSender({ origins: [orbit.origin], log: quiet });
    assert.equal(await send(`${orbit.origin}/api/app-pay/notice/o1`, { id: 'chg_1', status: 'CAPTURED' }), 204);
    assert.equal(orbit.hits.length, 1);
    assert.equal(orbit.hits[0].method, 'POST');
    assert.equal(orbit.hits[0].url, '/api/app-pay/notice/o1');
    assert.deepEqual(JSON.parse(orbit.hits[0].body), { id: 'chg_1', status: 'CAPTURED' });
  } finally {
    await close(orbit);
  }
});

test('contacts nothing that is not listed, and says so once: a loopback or internal address named by whoever made the payment gets no request', async () => {
  const orbit = await listen((req, res) => res.writeHead(204).end());
  const internal = await listen((req, res) => res.writeHead(200).end());
  try {
    const logs = [];
    const send = createNoticeSender({ origins: [orbit.origin], log: (line) => logs.push(line) });
    assert.equal(await send(`${internal.origin}/admin`, { id: 'chg_1' }), 0);
    assert.equal(await send(`${internal.origin}/other`, { id: 'chg_2' }), 0);
    assert.equal(await send('http://169.254.169.254/latest/meta-data', { id: 'chg_3' }), 0);
    assert.equal(await send('', { id: 'chg_4' }), 0);
    assert.equal(await send('file:///etc/passwd', { id: 'chg_5' }), 0);
    assert.equal(internal.hits.length, 0);
    assert.equal(orbit.hits.length, 0);
    // once for each origin, not once for each notice
    assert.equal(logs.filter((line) => line.includes(internal.origin)).length, 1);
    // with nothing listed at all, nothing is ever sent
    const none = createNoticeSender({ origins: [], log: quiet });
    assert.equal(await none(`${orbit.origin}/x`, {}), 0);
    assert.equal(orbit.hits.length, 0);
  } finally {
    await close(orbit, internal);
  }
});

test('does not follow a redirect to an address that is not listed, whatever the code', async () => {
  const internal = await listen((req, res) => res.writeHead(200).end());
  const orbit = await listen((req, res) => res.writeHead(Number(req.url.slice(1)), { location: `${internal.origin}/secret` }).end());
  try {
    const send = createNoticeSender({ origins: [orbit.origin], log: quiet });
    for (const code of [301, 302, 303, 307, 308]) assert.equal(await send(`${orbit.origin}/${code}`, { id: 'chg_1' }), code);
    assert.equal(internal.hits.length, 0);
    assert.equal(orbit.hits.length, 5);
  } finally {
    await close(orbit, internal);
  }
});

test('follows a 307 or 308 to another listed address with the same method and body, and not a 301, 302 or 303, and stops after three hops', async () => {
  const second = await listen((req, res) => res.writeHead(200).end());
  const first = await listen((req, res) => {
    if (req.url === '/loop') return res.writeHead(307, { location: '/loop' }).end();
    if (req.url === '/gone') return res.writeHead(302, { location: `${second.origin}/moved` }).end();
    return res.writeHead(308, { location: `${second.origin}/moved` }).end();
  });
  try {
    const send = createNoticeSender({ origins: [first.origin, second.origin], log: quiet });
    assert.equal(await send(`${first.origin}/start`, { id: 'chg_1' }), 200);
    assert.deepEqual(second.hits.map((hit) => [hit.method, hit.url, JSON.parse(hit.body).id]), [['POST', '/moved', 'chg_1']]);
    assert.equal(await send(`${first.origin}/gone`, { id: 'chg_2' }), 302);
    assert.equal(second.hits.length, 1);
    // a redirect that leads to itself ends: the last answer is what is given back
    first.hits.length = 0;
    assert.equal(await send(`${first.origin}/loop`, { id: 'chg_3' }), 307);
    assert.equal(first.hits.length, 4);
  } finally {
    await close(first, second);
  }
});

test('gives up on an Orbit that does not answer, within the time given, and the line is closed', async () => {
  const slow = await listen(() => undefined);
  try {
    const send = createNoticeSender({ origins: [slow.origin], timeoutMs: 100, log: quiet });
    await assert.rejects(send(`${slow.origin}/x`, {}));
  } finally {
    slow.server.closeAllConnections();
    await close(slow);
  }
});
