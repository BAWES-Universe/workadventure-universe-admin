'use strict';
/**
 * How a notice reaches Orbit, and only Orbit. The notify address of a payment is written by whoever makes the payment (any caller with an invented
 * `sk_test_` key can name any address), so the service never sends to an address it was not told about: NOTICE_ORIGINS lists the origins it may notice
 * (Orbit staging's public address, e.g. `https://orbit.dev.example.org`), and nothing else is contacted, loopback and internal addresses included.
 * A redirect is never followed to somewhere else: only a 307 or 308 (which keep the method and the body) is followed, and only to an address that
 * passes the same check, at most three times.
 */

const MAX_HOPS = 3;

/** The origins in a list written as text (commas or spaces between them): `https://orbit.example.org`, no path, no login. Entries that are not an origin are left out. */
function parseOrigins(text) {
  const origins = [];
  for (const entry of String(text || '').split(/[\s,]+/).filter(Boolean)) {
    try {
      const url = new URL(entry);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      /* not an address: not an origin */
    }
  }
  return origins;
}

/** The address when it may be contacted (an http(s) address with no login whose origin is listed), else null. */
function allowedUrl(address, origins) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return origins.includes(url.origin) ? url : null;
}

/**
 * `send(url, body)` for the gateway: the status Orbit answered, or 0 when nothing was sent (the address is not an allowed one) or Orbit said nothing.
 * `fetchImpl` and `timeoutMs` are for tests.
 */
function createNoticeSender({ origins, fetchImpl = fetch, timeoutMs = 10_000, log = console.warn }) {
  const refused = new Set();
  return async function send(address, body) {
    let target = allowedUrl(address, origins);
    for (let hop = 0; target; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(target.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'manual' });
      } finally {
        clearTimeout(timer);
      }
      const location = response.headers && typeof response.headers.get === 'function' ? response.headers.get('location') : null;
      if ((response.status === 307 || response.status === 308) && location && hop < MAX_HOPS) {
        const next = allowedUrl(new URL(location, target).href, origins);
        if (!next) {
          log(`A notice was sent to an allowed address that redirected somewhere else: not followed (${response.status}).`);
          return response.status;
        }
        target = next;
        continue;
      }
      return response.status;
    }
    let host = 'an address that is not one';
    try {
      host = new URL(address).origin;
    } catch {
      /* keep the words above */
    }
    if (!refused.has(host)) {
      refused.add(host);
      log(`A notice for ${host} was not sent: it is not in NOTICE_ORIGINS.`);
    }
    return 0;
  };
}

module.exports = { parseOrigins, allowedUrl, createNoticeSender };
