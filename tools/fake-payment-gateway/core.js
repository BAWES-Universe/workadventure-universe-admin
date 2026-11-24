'use strict';
/**
 * A FAKE payment service, for the staging journeys of Universe page payments. Test infrastructure only: it is never part of the product (not in the
 * app image, no environment variable of the product refers to it). It speaks the gateway setup in `definition.js`: make a payment link, look a
 * payment up, keys that start with sk_test_ or sk_live_, a hosted checkout page with Pay and Cancel, and a notice to Orbit when a payment completes.
 *
 * Everything is on demand: a small control API (see README.md) and a few words in a payment's description (`[fake late=45 dup]`) switch what the
 * service does for the next payment or the next looks. This file has no server in it (`handle` takes a request and gives an answer), so the same code
 * runs under `server.js` and inside the product's tests.
 */
const crypto = require('node:crypto');
const { definitionFor } = require('./definition');

const KEY_MODES = { sk_test_: 'test', sk_live_: 'live' };
const FAILURES = new Set(['5xx', 'timeout', 'drop', '401', 'garbage', 'empty']);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (status, body, extra = {}) => ({ status, body, ...extra });
const page = (status, html, extra = {}) => ({ status, html, ...extra });

function fresh() {
  return {
    seq: 0,
    payments: {},
    // The same idempotent key (or order reference) again gives the first payment, as a real gateway does
    byKey: {},
    // Lookups that cannot be read: { mode, until } (until: a time, or null for until it is switched off)
    unreadable: null,
    // The next payments are made as this says
    next: { lateMinutes: null, duplicateNotice: 0, mismatch: null, autoPay: null, pending: false },
    // Faults on making a payment: { mode, times, made }
    createFault: null,
    notices: [],
  };
}

/** The words in a description that switch what happens to that one payment: [fake late=45 dup amount=1 currency=USD live order pending pay cancel] */
function parseFlags(description) {
  const found = typeof description === 'string' ? description.match(/\[fake([^\]]*)\]/i) : null;
  const flags = {};
  if (!found) return flags;
  for (const word of found[1].trim().split(/\s+/).filter(Boolean)) {
    const [name, value] = word.split('=');
    flags[name.toLowerCase()] = value === undefined ? true : value;
  }
  return flags;
}

function createGateway(options = {}) {
  const now = options.now || Date.now;
  const clean = (address) => String(address).replace(/\/+$/, '');
  // The address the links of the request being answered are made from: the one given with the request (a server behind a proxy takes it from the
  // request), else the one the gateway was made with. It is set for the length of one `handle` call and nothing else reads it.
  const defaultPublicUrl = clean(options.publicUrl || 'http://localhost:8080');
  let publicUrl = defaultPublicUrl;
  const controlToken = options.controlToken || '';
  // How a notice reaches Orbit: (url, body) => status. Tests give their own; the server uses fetch.
  const send = options.send || (async () => 200);
  let state = fresh();

  const modeOf = (headers) => {
    const given = String(headers.authorization || headers.Authorization || '');
    const key = given.replace(/^Bearer\s+/i, '').trim();
    for (const [prefix, mode] of Object.entries(KEY_MODES)) if (key.startsWith(prefix) && key.length >= prefix.length + 8) return mode;
    return null;
  };

  const record = (payment) => {
    const mismatch = payment.scenario.mismatch || {};
    const captured = payment.status === 'CAPTURED';
    return {
      id: payment.id,
      status: mismatch.status && captured ? mismatch.status : payment.status,
      amount: captured && mismatch.amount !== undefined ? Number(mismatch.amount) : payment.amount,
      currency: captured && mismatch.currency ? mismatch.currency : payment.currency,
      description: payment.description,
      live_mode: captured && mismatch.live !== undefined ? mismatch.live === true : payment.mode === 'live',
      reference: { order: captured && mismatch.order ? mismatch.order : payment.order },
      transaction: { created: new Date(payment.createdAt).toISOString() },
    };
  };

  const complete = (payment, status) => {
    if (payment.status !== 'INITIATED') return false;
    payment.status = status;
    payment.finishedAt = now();
    payment.noticesDue = status === 'CAPTURED' ? Math.max(1, Number(payment.scenario.duplicateNotice) || 1) : 1;
    return true;
  };

  const returnUrl = (payment, outcome) => (payment.redirect ? `${payment.redirect}${payment.redirect.includes('?') ? '&' : '?'}fake_status=${outcome}` : `${publicUrl}/`);

  /** Applies what is due by the clock (a late capture) and sends the notices that are owed. Called often by the server, and by a test when it moves the clock. */
  async function tick() {
    let sent = 0;
    for (const payment of Object.values(state.payments)) {
      if (payment.status === 'INITIATED' && payment.captureAt !== null && now() >= payment.captureAt) complete(payment, 'CAPTURED');
      while (payment.noticesDue > 0 && payment.notifyUrl) {
        payment.noticesDue -= 1;
        const body = { id: payment.id, status: payment.status, reference: { order: payment.order } };
        let status = 0;
        try {
          status = Number(await send(payment.notifyUrl, body)) || 0;
        } catch {
          status = 0;
        }
        payment.noticesSent += 1;
        state.notices.push({ id: payment.id, at: now(), status, duplicate: payment.noticesSent > 1 });
        sent += 1;
      }
    }
    return sent;
  }

  const unreadableMode = () => {
    const u = state.unreadable;
    if (!u) return null;
    if (u.until !== null && now() >= u.until) {
      state.unreadable = null;
      return null;
    }
    return u.mode;
  };

  const failWith = (mode) => {
    if (mode === '5xx') return json(503, { error: 'The service is not available' });
    if (mode === '401') return json(401, { error: 'Not authorised' });
    if (mode === 'garbage') return { status: 200, raw: '<html><body>Maintenance</body></html>', type: 'text/html' };
    if (mode === 'empty') return json(200, {});
    if (mode === 'drop') return { drop: true };
    return { status: 504, hang: 60_000, body: { error: 'timeout' } };
  };

  function makePayment(request, mode) {
    const body = request.json || {};
    const amount = Number(body.amount);
    const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : '';
    const order = String(body.reference && body.reference.order ? body.reference.order : '');
    const idem = String((body.reference && body.reference.idempotent) || order || '');
    if (!(amount > 0) || !/^[A-Z]{3}$/.test(currency)) return json(400, { error: 'amount and currency are required' });
    const redirect = body.redirect && typeof body.redirect.url === 'string' ? body.redirect.url : '';
    if (!redirect) return json(400, { error: 'redirect.url is required' });
    const existing = idem ? state.byKey[`${mode}:${idem}`] : null;
    let payment = existing ? state.payments[existing] : null;
    if (!payment) {
      state.seq += 1;
      const flags = parseFlags(body.description);
      const base = { ...state.next };
      const scenario = {
        lateMinutes: flags.late !== undefined ? Number(flags.late) : base.lateMinutes,
        duplicateNotice: flags.dup ? 2 : base.duplicateNotice,
        mismatch: base.mismatch ? { ...base.mismatch } : null,
        autoPay: flags.pay ? 'pay' : flags.cancel ? 'cancel' : base.autoPay,
        pending: Boolean(flags.pending) || base.pending,
      };
      if (flags.amount !== undefined || flags.currency !== undefined || flags.live !== undefined || flags.order !== undefined) {
        scenario.mismatch = { ...(scenario.mismatch || {}), ...(flags.amount !== undefined ? { amount: Number(flags.amount) } : {}), ...(flags.currency !== undefined ? { currency: String(flags.currency).toUpperCase() } : {}), ...(flags.live !== undefined ? { live: mode !== 'live' } : {}), ...(flags.order !== undefined ? { order: 'other-order' } : {}) };
      }
      payment = {
        id: `chg_${crypto.randomBytes(6).toString('hex')}${String(state.seq).padStart(3, '0')}`,
        mode,
        amount,
        currency,
        description: typeof body.description === 'string' ? body.description : '',
        order,
        status: 'INITIATED',
        createdAt: now(),
        redirect,
        notifyUrl: body.post && typeof body.post.url === 'string' ? body.post.url : '',
        scenario,
        paidIntent: false,
        captureAt: null,
        noticesDue: 0,
        noticesSent: 0,
        finishedAt: null,
      };
      state.payments[payment.id] = payment;
      if (idem) state.byKey[`${mode}:${idem}`] = payment.id;
    }
    return payment;
  }

  const created = (payment) => json(200, { id: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency, transaction: { url: `${publicUrl}/pay/${payment.id}` }, reference: { order: payment.order } });

  function hosted(payment) {
    const finished = payment.status !== 'INITIATED';
    const note = payment.scenario.lateMinutes !== null && payment.scenario.lateMinutes !== undefined ? ` Scenario: this payment completes ${payment.scenario.lateMinutes} minutes after the order was made.` : '';
    const body = finished
      ? `<p>This payment is ${escapeHtml(payment.status.toLowerCase())}.</p><p><a href="${escapeHtml(returnUrl(payment, payment.status === 'CAPTURED' ? 'captured' : 'cancelled'))}">Return to the page</a></p>`
      : payment.paidIntent
        ? `<p>Thank you. Your payment is being processed.${escapeHtml(note)}</p><p><a href="${escapeHtml(returnUrl(payment, 'processing'))}">Return to the page</a></p>`
        : `<form method="post" action="/pay/${escapeHtml(payment.id)}/pay"><button type="submit">Pay</button></form><form method="post" action="/pay/${escapeHtml(payment.id)}/cancel"><button type="submit">Cancel</button></form>`;
    return page(
      200,
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake Pay</title><body style="font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem"><h1>Fake Pay</h1><p><strong>${escapeHtml(payment.amount)} ${escapeHtml(payment.currency)}</strong> <span style="border:1px solid #888;border-radius:4px;padding:0 .4rem">${payment.mode === 'live' ? 'LIVE' : 'TEST'}</span></p><p>${escapeHtml(payment.description)}</p>${body}<p style="color:#666;font-size:13px">A fake payment service for testing. No money moves.${escapeHtml(payment.scenario.lateMinutes !== null && payment.scenario.lateMinutes !== undefined && !payment.paidIntent ? note : '')}</p></body>`,
    );
  }

  const authorised = (request) => {
    if (!controlToken) return false;
    const given = String(request.headers['x-control-token'] || String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const a = Buffer.from(given);
    const b = Buffer.from(controlToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const summary = (payment) => ({ id: payment.id, mode: payment.mode, amount: payment.amount, currency: payment.currency, order: payment.order, status: payment.status, createdAt: new Date(payment.createdAt).toISOString(), captureAt: payment.captureAt === null ? null : new Date(payment.captureAt).toISOString(), paidIntent: payment.paidIntent, noticesDue: payment.noticesDue, noticesSent: payment.noticesSent, scenario: payment.scenario });

  function control(request, path) {
    if (!authorised(request)) return json(401, { error: 'A control token is needed' });
    const body = request.json || {};
    if (request.method === 'GET' && path === '/control/state') {
      return json(200, { now: new Date(now()).toISOString(), unreadable: state.unreadable, createFault: state.createFault, next: state.next, payments: Object.keys(state.payments).length, notices: state.notices.length });
    }
    if (request.method === 'GET' && path === '/control/payments') return json(200, { payments: Object.values(state.payments).map(summary) });
    if (request.method === 'GET' && path === '/control/notices') return json(200, { notices: state.notices });
    if (request.method === 'POST' && path === '/control/reset') {
      state = fresh();
      return json(200, { ok: true });
    }
    // Lookups that cannot be read, for a time or until switched off: { mode: '5xx'|'timeout'|'drop'|'401'|'garbage'|'empty', seconds? } · { off: true }
    if (request.method === 'POST' && path === '/control/unreadable') {
      if (body.off) {
        state.unreadable = null;
        return json(200, { unreadable: null });
      }
      if (!FAILURES.has(body.mode)) return json(400, { error: `mode is one of ${[...FAILURES].join(', ')}` });
      state.unreadable = { mode: body.mode, until: Number(body.seconds) > 0 ? now() + Number(body.seconds) * 1000 : null };
      return json(200, { unreadable: state.unreadable });
    }
    // Making a payment fails: { mode, times, made } (made: the payment IS made and only the answer is lost) · { off: true }
    if (request.method === 'POST' && path === '/control/create-fault') {
      if (body.off) {
        state.createFault = null;
        return json(200, { createFault: null });
      }
      if (!FAILURES.has(body.mode)) return json(400, { error: `mode is one of ${[...FAILURES].join(', ')}` });
      state.createFault = { mode: body.mode, times: Number(body.times) > 0 ? Number(body.times) : 1, made: body.made === true };
      return json(200, { createFault: state.createFault });
    }
    // What the NEXT payments do: { lateMinutes, duplicateNotice (2 = twice), mismatch: { amount, currency, live, order, status }, autoPay: 'pay'|'cancel', pending } · { clear: true }
    if (request.method === 'POST' && path === '/control/next') {
      if (body.clear) state.next = fresh().next;
      else for (const name of Object.keys(state.next)) if (Object.hasOwn(body, name)) state.next[name] = body[name];
      return json(200, { next: state.next });
    }
    const one = path.match(/^\/control\/payments\/([A-Za-z0-9_]+)$/);
    if (one && request.method === 'POST') {
      const payment = state.payments[one[1]];
      if (!payment) return json(404, { error: 'No such payment' });
      // capture: completes now (and notices are owed) · cancel · late: completes `minutes` after the order was made · notify: owes one more notice
      if (body.action === 'capture') complete(payment, 'CAPTURED');
      else if (body.action === 'cancel') complete(payment, 'CANCELLED');
      else if (body.action === 'late') {
        payment.scenario.lateMinutes = Number(body.minutes) || 0;
        payment.captureAt = payment.createdAt + payment.scenario.lateMinutes * 60_000;
      } else if (body.action === 'notify') payment.noticesDue += Math.max(1, Number(body.times) || 1);
      else if (body.action === 'mismatch') payment.scenario.mismatch = body.mismatch || null;
      else return json(400, { error: 'action is capture, cancel, late, notify or mismatch' });
      return json(200, { payment: summary(payment) });
    }
    return json(404, { error: 'No such control' });
  }

  /** One request in, one answer out. `request`: { method, path, query?, headers (lower case), json?, publicUrl? } */
  function handle(request) {
    publicUrl = typeof request.publicUrl === 'string' && request.publicUrl ? clean(request.publicUrl) : defaultPublicUrl;
    try {
      return handleRequest(request);
    } finally {
      publicUrl = defaultPublicUrl;
    }
  }

  function handleRequest(request) {
    const path = request.path;
    const method = request.method;
    if (path.startsWith('/control/')) return control(request, path);
    if (method === 'GET' && (path === '/' || path === '/health')) return json(200, { ok: true, service: 'fake-payment-gateway' });
    if (method === 'GET' && path === '/definition') return json(200, definitionFor(publicUrl));
    // The docs a Brick can read: plain words, and the setup as data
    if (method === 'GET' && path === '/docs') {
      return page(200, `<!doctype html><meta charset="utf-8"><title>Fake Pay API</title><body style="font:16px system-ui;max-width:48rem;margin:2rem auto;padding:0 1rem"><h1>Fake Pay API</h1><p>A fake payment service for testing. Keys start with <code>sk_test_</code> or <code>sk_live_</code>, sent as <code>Authorization: Bearer &lt;key&gt;</code>. No money moves.</p><ul><li><code>POST /v2/charges</code>: make a payment link (amount, currency, description, redirect.url, reference.order, reference.idempotent, post.url). Returns id, status, transaction.url.</li><li><code>GET /v2/charges/{id}</code>: look a payment up (status CAPTURED when paid; INITIATED while open; CANCELLED when cancelled).</li></ul><p>The same setup as data: <a href="${escapeHtml(publicUrl)}/definition">${escapeHtml(publicUrl)}/definition</a></p><pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(definitionFor(publicUrl), null, 2))}</pre></body>`);
    }

    if (method === 'POST' && path === '/v2/charges') {
      const mode = modeOf(request.headers);
      if (!mode) return json(401, { error: 'Not authorised' });
      const fault = state.createFault;
      if (fault && fault.times > 0 && !fault.made) {
        fault.times -= 1;
        if (fault.times === 0) state.createFault = null;
        return failWith(fault.mode);
      }
      const payment = makePayment(request, mode);
      if (!payment.id) return payment;
      if (fault && fault.times > 0 && fault.made) {
        fault.times -= 1;
        if (fault.times === 0) state.createFault = null;
        return failWith(fault.mode);
      }
      return created(payment);
    }

    const lookup = path.match(/^\/v2\/charges\/([A-Za-z0-9_]+)$/);
    if (method === 'GET' && lookup) {
      const mode = modeOf(request.headers);
      if (!mode) return json(401, { error: 'Not authorised' });
      const trouble = unreadableMode();
      if (trouble) return failWith(trouble);
      const payment = state.payments[lookup[1]];
      // A key sees only the payments made with a key of its own kind
      if (!payment || payment.mode !== mode) return json(404, { error: 'No such payment' });
      if (payment.status === 'INITIATED' && payment.captureAt !== null && now() >= payment.captureAt) complete(payment, 'CAPTURED');
      return json(200, record(payment));
    }

    const hostedPage = path.match(/^\/pay\/([A-Za-z0-9_]+)(?:\/(pay|cancel))?$/);
    if (hostedPage) {
      const payment = state.payments[hostedPage[1]];
      if (!payment) return page(404, '<!doctype html><title>Not found</title><p>No such payment.</p>');
      const act = hostedPage[2];
      const auto = payment.scenario.autoPay;
      const doPay = () => {
        payment.paidIntent = true;
        if (payment.scenario.pending) return;
        // Late: it completes `lateMinutes` after the order was made (at once when that time has already gone)
        payment.captureAt = payment.scenario.lateMinutes !== null && payment.scenario.lateMinutes !== undefined ? payment.createdAt + payment.scenario.lateMinutes * 60_000 : now();
        if (now() >= payment.captureAt) complete(payment, 'CAPTURED');
      };
      if (method === 'GET' && !act) {
        if (auto === 'pay' && payment.status === 'INITIATED' && !payment.paidIntent) doPay();
        else if (auto === 'cancel' && payment.status === 'INITIATED') complete(payment, 'CANCELLED');
        return payment.paidIntent || payment.status !== 'INITIATED' ? (auto ? { status: 303, redirect: returnUrl(payment, payment.status === 'CAPTURED' ? 'captured' : payment.status === 'CANCELLED' ? 'cancelled' : 'processing') } : hosted(payment)) : hosted(payment);
      }
      if (method === 'POST' && act === 'pay') {
        if (payment.status === 'INITIATED' && !payment.paidIntent) doPay();
        return { status: 303, redirect: returnUrl(payment, payment.status === 'CAPTURED' ? 'captured' : 'processing') };
      }
      if (method === 'POST' && act === 'cancel') {
        complete(payment, 'CANCELLED');
        return { status: 303, redirect: returnUrl(payment, 'cancelled') };
      }
    }
    return json(404, { error: 'Not found' });
  }

  return {
    handle,
    tick,
    now,
    // For a server that restarts: the whole state as plain data, and back
    snapshot: () => JSON.parse(JSON.stringify(state)),
    restore: (data) => {
      state = { ...fresh(), ...data };
    },
    reset: () => {
      state = fresh();
    },
  };
}

module.exports = { createGateway, parseFlags };
