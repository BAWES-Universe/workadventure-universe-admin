/**
 * The host side of a page that takes payments, for Orbit's public share link (game #2044). It speaks exactly what the game's window speaks
 * (see `PagePayments.ts` in the game), so the same published page behaves the same in both:
 *
 *   page → host   { universe: 'use-app', app, request }                  start a checkout
 *   page → host   { universe: 'use-app', app, request, restore: true }  get back a purchase this buyer already made
 *   host → page   { universe: 'app-result', status, request, test? }
 *
 * `request` is a short id the page makes up for that tap, and every answer carries it back, so a page (a reloaded one, or one that asked
 * twice) never takes the result of another checkout as its own. Statuses: started · paid · not_paid · cant_confirm · unavailable · limit ·
 * busy (another request is on its way) · none (a restore found no purchase). `test: true` rides with `paid` for a test payment, so a page can
 * show a test preview and never unlock live goods. A page that sends no valid request id is never answered with a bare status: the host's own
 * line says the page needs an update and still offers Check payment.
 *
 * Everything real is decided by Orbit: the amount and the service are the owner's (a message carries neither), the page hears back only a
 * status, never an address, a key, an order or a recovery code. The purchase wish (`intentId`) is made here per tap, never by the page, and a
 * guest's recovery code lives only in this browser (and in the receipt link they keep).
 *
 * No React in here, so it can be tested on its own; `components/page-payments-bridge.tsx` only draws what `line` says.
 */

/** The id a page gives its request: short and plain, so it can only be echoed back and never carry anything else. */
export const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PayProblem = 'unavailable' | 'limit' | 'not_paid' | 'cant_confirm' | 'none';

/** What the host says under the page while a payment is on its way. */
export interface PayLine {
  /** A payment was started (or is being found again) and has not ended. */
  checking: boolean;
  /** The start of the checkout is taking longer than usual: the page has been told nothing yet. */
  slow: boolean;
  problem: PayProblem | null;
  /** Where to go on when the pop-up was blocked or closed: the same checkout, in a new tab. */
  resume: { url: string; app: string } | null;
  /** A payment was confirmed; `test` when it was made with a test key. */
  paid: { test: boolean } | null;
  /** The page sends requests this host cannot answer (no request id): it needs to be made again with the current instructions. */
  needsUpdate: boolean;
  /** Check payment can be offered: the look ran out, the start answer was lost, or the page cannot ask for itself. */
  canCheck: boolean;
  /** For a guest: the link to keep, which holds the recovery code (in its fragment, so no server ever receives it). */
  receipt: string | null;
}

export const NO_PAY_LINE: PayLine = { checking: false, slow: false, problem: null, resume: null, paid: null, needsUpdate: false, canCheck: false, receipt: null };

/** How an order is asked about, and for how long. The server's own `pollAfterMs` hint says how far apart (3 seconds at first, slowing to 15). */
const FIRST_POLL_MS = 3_000;
const LEAST_POLL_MS = 1_000;
const MOST_POLL_MS = 30_000;
const POLL_FOR_MS = 20 * 60_000;
/** How long the start of a checkout may wait before the host says it is taking longer (to the buyer only), and how long in all. */
const START_FOR_MS = 30_000;
const STALLED_START_FOR_MS = 120_000;
/** A start whose answer was lost on the way is sent again with the same wish this many times, so one order is made and never two. */
const START_TRIES = 3;
const TRY_AGAIN_MS = 1_000;
const TAB_WATCH_MS = 1_000;

/** Only a plain https address is ever opened. */
export function safeCheckout(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

interface Answer {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * Which opening a request came from. A page's scripts run, and may ask, before its frame's `load` event; that event then bumps the opening
 * count. A request that came in the moment before a load belongs to the document that is loading (not to the one that just went), so such a
 * ticket is moved to the new opening at the load; any other ticket stays with the opening it was made in.
 */
interface Ticket {
  from: number;
  at: number;
}
/** How close to a load a request must have come to be taken for the loading document's own. */
const LOADING_MS = 2_000;

export interface PagePaymentsHostOptions {
  artifactId: string;
  /** The window of the artifact's frame, as it is now: a message from any other window is ignored. */
  frame: () => Window | null | undefined;
  /** Opens the checkout's window straight from the tap's moment; null when the browser blocked it. */
  openWindow?: () => Window | null;
  fetch?: typeof fetch;
  /** Where this browser keeps a guest's recovery code (localStorage); none means it lives only as long as this page. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Random plain characters of a length (for wishes and recovery codes). */
  randomId?: (length: number) => string;
  /** This host's own address, for the receipt link. */
  origin?: string;
}

export interface PagePaymentsHost {
  subscribe: (run: (line: PayLine) => void) => () => void;
  /** Every message the window receives goes here; only the artifact's frame is heard. */
  onMessage: (event: { source: unknown; data: unknown }) => void;
  /** The artifact's frame (re)loaded: the page that asked is gone, so nothing it asked is told to the page that is there now. */
  frameLoaded: () => void;
  /** The buyer pressed Check payment. */
  checkPayment: () => void;
  destroy: () => void;
}

const defaultRandom = (length: number): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
};

const waitFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPagePaymentsHost(options: PagePaymentsHostOptions): PagePaymentsHost {
  const ask = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const random = options.randomId ?? defaultRandom;
  const storageKey = `universe-pay-recovery:${options.artifactId}`;
  const base = `/api/pay/${encodeURIComponent(options.artifactId)}`;
  const listeners = new Set<(line: PayLine) => void>();
  let line: PayLine = NO_PAY_LINE;
  let destroyed = false;
  let busy = false;
  /** The id the page gave the request that is on its way, and the opening it came from. */
  let activeRequest = '';
  let activeTicket: Ticket | null = null;
  let opening = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let tabWatch: ReturnType<typeof setInterval> | undefined;
  let startInFlight: { abort: AbortController; clear: () => void } | undefined;
  /** What Check payment asks about: the wish of the last checkout (when there is one), and who asked for it. */
  let target: { intentId: string | null; request: string; ticket: Ticket } | null = null;
  let guest = false;
  let memoryCode: string | null = null;

  const publish = (update: Partial<PayLine>, keep = false) => {
    line = { ...(keep ? line : { ...NO_PAY_LINE, receipt: line.receipt }), ...update };
    listeners.forEach((run) => run(line));
  };

  /** The recovery code of this browser for this page: made once, kept, and never given to the page. */
  const recoveryCode = (): string => {
    // A code already made in this page's life is the code, whether or not the browser would keep it (no storage, or storage that refuses)
    if (memoryCode) return memoryCode;
    try {
      const stored = options.storage?.getItem(storageKey);
      if (stored && /^[A-Za-z0-9_-]{32,128}$/.test(stored)) {
        memoryCode = stored;
        return stored;
      }
      memoryCode = random(43);
      options.storage?.setItem(storageKey, memoryCode);
    } catch {
      memoryCode = memoryCode ?? random(43);
    }
    return memoryCode;
  };

  /** The link of an order that is still open, when the answer holds one the host may open (plain https only). */
  const resumeOf = (body: Record<string, unknown> | null): { url: string; app: string; popup: Window | null } | null => {
    const url = safeCheckout(typeof body?.checkoutUrl === 'string' ? body.checkoutUrl : null);
    return url ? { url, app: '', popup: null } : null;
  };

  const receiptFor = (): string | null => (guest && options.origin ? `${options.origin}/pay/receipt/${encodeURIComponent(options.artifactId)}#${recoveryCode()}` : null);

  const post = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> => {
    const response = await ask(base, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, recoveryCode: recoveryCode() }), signal });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (json && json.buyer === 'guest') guest = true;
    if (json && json.buyer === 'account') guest = false;
    return { ok: response.ok, status: response.status, body: json };
  };

  const tellRequest = (status: string, request: string, test = false) =>
    options.frame()?.postMessage({ universe: 'app-result', status, request, ...(test ? { test: true } : {}) }, '*');

  // How a checkout ended is told to the page that asked, in the opening it asked in, and to no other
  const end = (update: Partial<PayLine>, status: string, request: string, ticket: Ticket, test = false) => {
    busy = false;
    activeRequest = '';
    publish({ ...update, receipt: receiptFor() });
    if (opening === ticket.from) tellRequest(status, request, test);
  };

  const stopTimers = () => {
    if (timer) clearTimeout(timer);
    if (deadline) clearTimeout(deadline);
    if (tabWatch) clearInterval(tabWatch);
    timer = deadline = tabWatch = undefined;
  };

  /** Asks about an order until it ends. The deadline has its own clock; a closed checkout tab gets its link back. */
  const watch = (orderId: string, checkout: { url: string; app: string; popup: Window | null } | null, request: string, ticket: Ticket) => {
    let over = false;
    let linkBack = false;
    const finish = (update: Partial<PayLine>, status: string, test = false) => {
      if (over || destroyed) return;
      over = true;
      stopTimers();
      end(update, status, request, ticket, test);
    };
    // Twenty minutes without an answer: said plainly, never a silent end. The order may still be counted later, which Check payment finds.
    deadline = setTimeout(() => finish({ problem: 'cant_confirm', canCheck: true }, 'cant_confirm'), POLL_FOR_MS);
    if (checkout?.popup) {
      tabWatch = setInterval(() => {
        if (over || destroyed || linkBack || checkout.popup?.closed !== true) return;
        linkBack = true;
        if (tabWatch) clearInterval(tabWatch);
        if (line.checking) publish({ resume: { url: checkout.url, app: checkout.app } }, true);
      }, TAB_WATCH_MS);
    }
    const poll = async () => {
      if (over || destroyed) return;
      let next = FIRST_POLL_MS;
      try {
        const response = await ask(`${base}?order=${encodeURIComponent(orderId)}`, { cache: 'no-store' });
        const body = response.ok ? ((await response.json()) as { status?: string; testPayment?: boolean; pollAfterMs?: number }) : null;
        if (over || destroyed) return;
        if (body?.pollAfterMs && Number.isFinite(body.pollAfterMs)) next = Math.min(MOST_POLL_MS, Math.max(LEAST_POLL_MS, body.pollAfterMs));
        if (body?.status === 'paid') return finish({ paid: { test: body.testPayment === true } }, 'paid', body.testPayment === true);
        if (body?.status === 'not_paid') return finish({ problem: 'not_paid', canCheck: true }, 'not_paid');
        if (body?.status === 'cant_confirm') return finish({ problem: 'cant_confirm', canCheck: true }, 'cant_confirm');
      } catch {
        // Try again on the next turn
      }
      if (!over && !destroyed) timer = setTimeout(() => void poll(), next);
    };
    timer = setTimeout(() => void poll(), FIRST_POLL_MS);
  };

  const adopt = (orderId: string, checkout: { url: string; app: string; popup: Window | null } | null, request: string, ticket: Ticket) => {
    busy = true;
    activeRequest = request;
    activeTicket = ticket;
    publish({ checking: true, resume: checkout && !checkout.popup ? { url: checkout.url, app: checkout.app } : null, receipt: receiptFor() });
    watch(orderId, checkout, request, ticket);
  };

  const begin = (request: string, ticket: Ticket) => {
    busy = true;
    activeRequest = request;
    activeTicket = ticket;
    stopTimers();
    // The wish for this tap: made here, never by the page. A start sent again after a lost answer carries the same one, so it finds the order it made
    const intentId = random(24);
    target = { intentId, request, ticket };
    // Opened now, in the same moment as the page's tap, so a blocked pop-up is the only thing left that can go wrong
    let popup: Window | null = null;
    try {
      popup = options.openWindow?.() ?? null;
      if (popup) popup.opener = null;
    } catch {
      popup = null;
    }
    void (async () => {
      const abort = new AbortController();
      const slowTimer = setTimeout(() => {
        popup?.close();
        popup = null;
        if (!destroyed) publish({ checking: true, slow: true });
      }, START_FOR_MS);
      const giveUpTimer = setTimeout(() => abort.abort(), STALLED_START_FOR_MS);
      const mine = {
        abort,
        clear: () => {
          clearTimeout(slowTimer);
          clearTimeout(giveUpTimer);
        },
      };
      startInFlight = mine;
      try {
        let answer: Answer | null = null;
        for (let attempt = 0; attempt < START_TRIES && !answer; attempt += 1) {
          try {
            answer = await post({ intentId }, abort.signal);
          } catch (error) {
            if (abort.signal.aborted || destroyed) throw error;
            if (attempt + 1 < START_TRIES) await waitFor(TRY_AGAIN_MS);
          }
        }
        mine.clear();
        if (destroyed) return popup?.close();
        // No answer ever came: an order may or may not have been made. The same wish can be asked about with Check payment.
        if (!answer) {
          popup?.close();
          return end({ problem: 'unavailable', canCheck: true }, 'unavailable', request, ticket);
        }
        const url = safeCheckout(typeof answer.body?.checkoutUrl === 'string' ? answer.body.checkoutUrl : null);
        const orderId = typeof answer.body?.orderId === 'string' ? answer.body.orderId : '';
        if (!answer.ok || !orderId || !url) {
          popup?.close();
          const limit = answer.status === 429 || answer.body?.code === 'limit';
          return end({ problem: limit ? 'limit' : 'unavailable' }, limit ? 'limit' : 'unavailable', request, ticket);
        }
        if (popup) popup.location.href = url;
        adopt(orderId, { url, app: typeof answer.body?.app === 'string' ? answer.body.app : '', popup }, request, ticket);
        if (opening === ticket.from) tellRequest('started', request);
      } catch {
        popup?.close();
        if (destroyed) return;
        // Dropped for good after two minutes without an answer: said once, and Check payment can ask about the same wish
        end({ problem: 'unavailable', canCheck: true }, 'unavailable', request, ticket);
      } finally {
        mine.clear();
        if (startInFlight === mine) startInFlight = undefined;
      }
    })();
  };

  /** A page asking for a purchase this buyer already made (a reload, a reopened version): found by the buyer, never by anything the page chose. */
  const restore = (request: string, ticket: Ticket) => {
    busy = true;
    activeRequest = request;
    activeTicket = ticket;
    void (async () => {
      try {
        const answer = await post({ restore: true });
        if (destroyed) return;
        const status = answer.body?.status;
        if (answer.ok && status === 'paid') return end({ paid: { test: answer.body?.testPayment === true } }, 'paid', request, ticket, answer.body?.testPayment === true);
        if (answer.ok && status === 'none') return end({}, 'none', request, ticket);
        if (answer.ok && status === 'checking' && typeof answer.body?.orderId === 'string') {
          // An order of theirs is still open: it is watched like a new checkout, and the page hears how it ends under this request. Its own
          // link is offered, so a reload or a lost pop-up goes on with the SAME order and does not need a second one
          target = { intentId: null, request, ticket };
          return adopt(answer.body.orderId, resumeOf(answer.body), request, ticket);
        }
        end({ problem: 'unavailable', canCheck: true }, 'unavailable', request, ticket);
      } catch {
        if (!destroyed) end({ problem: 'unavailable', canCheck: true }, 'unavailable', request, ticket);
      }
    })();
  };

  const onMessage = (event: { source: unknown; data: unknown }) => {
    const frame = options.frame();
    if (destroyed || !frame || event.source !== frame) return;
    const data = event.data as { universe?: unknown; app?: unknown; request?: unknown; restore?: unknown } | null;
    if (!data || data.universe !== 'use-app' || typeof data.app !== 'string') return;
    // A request without a valid id of its own is never answered: there would be no way to tell whose answer it is. The buyer is told so on
    // the host's own line, and can still check a payment (a bare status would be taken for whichever checkout the page is waiting on)
    if (typeof data.request !== 'string' || !REQUEST_ID.test(data.request)) {
      publish({ needsUpdate: true, canCheck: true }, true);
      return;
    }
    if (busy) {
      // The same tap heard twice, in the same opening, is the same request. Anything else while a checkout is on its way (or its start is
      // still waiting for an answer, however long it takes) is told so under its own id, and the checkout on its way keeps its own
      if (data.request !== activeRequest || activeTicket?.from !== opening) tellRequest('busy', data.request);
      return;
    }
    const ticket: Ticket = { from: opening, at: Date.now() };
    if (data.restore === true) return restore(data.request, ticket);
    begin(data.request, ticket);
  };

  const checkPayment = () => {
    if (destroyed || busy) return;
    const asked = target ?? { intentId: null, request: '', ticket: { from: -1, at: 0 } };
    busy = true;
    activeRequest = asked.request;
    activeTicket = asked.ticket;
    publish({ checking: true });
    void (async () => {
      try {
        // The wish of the last checkout when there is one; otherwise (a page that cannot ask, or a reload) whatever this buyer has bought
        const answer = await post(asked.intentId ? { check: true, intentId: asked.intentId } : { restore: true });
        if (destroyed) return;
        const status = answer.body?.status;
        const test = answer.body?.testPayment === true;
        const request = asked.request;
        const done = (update: Partial<PayLine>, told: string, isTest = false) => {
          busy = false;
          activeRequest = '';
          publish({ ...update, receipt: receiptFor() });
          if (request && opening === asked.ticket.from) tellRequest(told, request, isTest);
        };
        if (answer.ok && status === 'paid') return done({ paid: { test } }, 'paid', test);
        if (answer.ok && status === 'checking' && typeof answer.body?.orderId === 'string') return adopt(answer.body.orderId, resumeOf(answer.body), request, asked.ticket);
        if (answer.ok && (status === 'not_paid' || status === 'cant_confirm')) return done({ problem: status, canCheck: true }, status);
        if (answer.ok && status === 'none') return done({ problem: 'none', canCheck: true }, 'none');
        if (answer.status === 404) return done({ problem: 'none', canCheck: true }, 'none');
        done({ problem: 'unavailable', canCheck: true }, 'unavailable');
      } catch {
        if (destroyed) return;
        busy = false;
        activeRequest = '';
        publish({ problem: 'unavailable', canCheck: true });
      }
    })();
  };

  return {
    subscribe(run) {
      listeners.add(run);
      run(line);
      return () => listeners.delete(run);
    },
    onMessage,
    frameLoaded() {
      // Every load is a new opening: the page appearing, a reload or another version. What an earlier opening asked is never told to the
      // page that is there now, except a request that came in the moment before this load: a page asks as its scripts run, before its frame
      // says it has loaded, so that one is the loading document's own and is moved to the new opening
      opening += 1;
      if (busy && activeTicket && Date.now() - activeTicket.at < LOADING_MS) activeTicket.from = opening;
    },
    checkPayment,
    destroy() {
      destroyed = true;
      startInFlight?.abort.abort();
      startInFlight?.clear();
      stopTimers();
      listeners.clear();
    },
  };
}
