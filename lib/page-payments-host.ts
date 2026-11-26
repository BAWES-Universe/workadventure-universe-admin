/**
 * The host side of a page that takes payments, for Orbit's public share link (game #2044). It speaks exactly what the game's window speaks
 * (see `PagePayments.ts` in the game), so the same published page behaves the same in both:
 *
 *   page → host   { universe: 'use-app', app, request, session }                  start a checkout
 *   page → host   { universe: 'use-app', app, request, session, restore: true }  get back a purchase this buyer already made
 *   host → page   { universe: 'app-result', status, request, session, test? }
 *
 * `request` is a short id the page makes up for that tap, and every answer carries it back, so a page (a reloaded one, or one that asked
 * twice) never takes the result of another checkout as its own. Statuses: started · paid · not_paid · cant_confirm · unavailable · limit ·
 * busy (another request is on its way) · none (a restore found no purchase). `test: true` rides with `paid` for a test payment, so a page can
 * show a test preview and never unlock live goods. A page that sends no valid request id, or no valid session, is never answered with a bare
 * status: the host's own line says the page needs an update and still offers Check payment. That is the policy for pages made before this
 * protocol (they exist only on dev, the screen is in the approved mock M1 §4): they are made again with the current instructions, and such a
 * message never starts a checkout, because there would be no way to tell whose answer is whose.
 *
 * `session` is a random id (the same plain-id rule as `request`) that the page's document gives itself when its scripts start, and sends with
 * every message. It binds a request to that document, whatever the frame does meanwhile (a load before the page was shown, a reload, another
 * version): every answer carries it back, the page ignores any answer that carries another document's session, and the host tells nothing
 * once another document has spoken. A frame's documents cannot be told apart from outside in any other way (the window is the same across
 * loads), which is why it is required.
 *
 * Everything real is decided by Orbit: the amount and the service are the owner's (a message carries neither), the page hears back only a
 * status, never an address, a key, an order or a recovery code. The purchase wish (`intentId`) is made here per tap, never by the page, and a
 * guest's recovery code lives only in this browser (and in the receipt link they keep).
 *
 * No React in here, so it can be tested on its own; `components/page-payments-bridge.tsx` only draws what `line` says.
 */

/** The id a page gives its request: short and plain, so it can only be echoed back and never carry anything else. */
export const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `not_published`: the owner set the page's payment on a version newer than the one this link shows; nothing was made (the page is told `unavailable`). */
export type PayProblem = 'unavailable' | 'not_published' | 'limit' | 'not_paid' | 'cant_confirm' | 'still_checking' | 'long_unconfirmed' | 'none';

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
  /** This browser could not keep the guest's code anywhere that survives a reload: the receipt link must be saved now, before the payment is confirmed. */
  keepReceipt: boolean;
  /** Who the buyer is as far as Orbit has said: signed in, or a guest of this browser (or its receipt link). */
  buyer: 'account' | 'guest' | null;
  /** The payment was found again (a reload, a new device, a receipt link) and was not made just now; `paidAt` says when, when known. */
  restored: { paidAt: string | null } | null;
  /** The page asked for its purchase back and nothing was found by itself: Restore purchase is offered, quietly (it can be closed). */
  offerRestore: boolean;
}

export const NO_PAY_LINE: PayLine = {
  checking: false,
  slow: false,
  problem: null,
  resume: null,
  paid: null,
  needsUpdate: false,
  canCheck: false,
  receipt: null,
  keepReceipt: false,
  buyer: null,
  restored: null,
  offerRestore: false,
};

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
/** How long Check payment and Restore may wait for Orbit before the host says it could not ask (and can be pressed again). */
const ASK_FOR_MS = 30_000;

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

/** Which document a request came from: the session id that document gave itself (the host never guesses it from the frame's loads). */
interface Ticket {
  session: string | null;
}

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
  /** The address of the shared page, for the receipt link (the code rides in its fragment: `#receipt=<code>`). */
  pageUrl?: string;
  /** Where tabs take turns when the browser has no Web Locks (IndexedDB: a transaction is atomic across tabs); none means this browser has no such place. */
  indexedDB?: Pick<IDBFactory, 'open'> | null;
  /** This tab's own storage (sessionStorage: it survives a reload of the tab and is never shared with another tab). Only a code that nothing could coordinate lives here. */
  tabStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export interface PagePaymentsHost {
  subscribe: (run: (line: PayLine) => void) => () => void;
  /** Every message the window receives goes here; only the artifact's frame is heard. */
  onMessage: (event: { source: unknown; data: unknown }) => void;
  /** The buyer pressed Check payment. */
  checkPayment: () => void;
  /** The buyer pressed Restore purchase. */
  restorePurchase: () => void;
  /** The buyer closed a line that can be closed (Restore purchase, or "no purchase found"). */
  dismiss: () => void;
  /** The shared page was opened with a receipt link: its code is kept for finding the purchases made under it, never for making new ones. False when it is not a code. */
  useReceiptCode: (code: string) => boolean;
  destroy: () => void;
}

const RECOVERY_CODE = /^[A-Za-z0-9_-]{32,128}$/;

const defaultRandom = (length: number): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
};

/** How long a browser without Web Locks waits, after writing its first code, before reading back which code the storage holds. */
const waitFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The promise's answer, or a rejection as soon as the signal aborts (whichever comes first). */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function createPagePaymentsHost(options: PagePaymentsHostOptions): PagePaymentsHost {
  const ask = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const random = options.randomId ?? defaultRandom;
  const storageKey = `universe-pay-recovery:${options.artifactId}`;
  /** The code of a receipt link, kept apart from the browser's own: it only ever finds the purchases made under it, and no new purchase is made under it. */
  const receiptKey = `universe-pay-receipt:${options.artifactId}`;
  /** Where a tab keeps the code of its own when nothing could make tabs take turns (this tab's storage only, so a reload of the tab finds it). */
  const tabKey = `universe-pay-tab:${options.artifactId}`;
  const base = `/api/pay/${encodeURIComponent(options.artifactId)}`;
  const listeners = new Set<(line: PayLine) => void>();
  let line: PayLine = NO_PAY_LINE;
  let destroyed = false;
  let busy = false;
  /** The id the page gave the request that is on its way, and the document it came from. */
  let activeRequest = '';
  let activeTicket: Ticket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let tabWatch: ReturnType<typeof setInterval> | undefined;
  let startInFlight: { abort: AbortController; clear: () => void } | undefined;
  /** What Check payment asks about: the wish of the last checkout (when there is one), and who asked for it. */
  let target: { intentId: string | null; request: string; ticket: Ticket } | null = null;
  let buyer: 'account' | 'guest' | null = null;
  /** The last restore the page itself asked for: a Restore purchase that finds the purchase is told to the page under it. */
  let lastRestore: { request: string; ticket: Ticket } | null = null;
  let memoryCode: string | null = null;
  let memoryReceipt: string | null = null;
  /** The code is kept somewhere that survives a reload (the storage, IndexedDB or this tab's storage); false only when nothing in this browser would keep it. */
  let durable = true;
  /** The id the document that spoke last gave itself (null when it gave none): another one speaking means another document. */
  let lastSession: string | null = null;
  /** A Restore from a document that spoke while a checkout was on its way (it was told `busy`): if the checkout ends paid, that page hears it too. */
  let owedRestore: { request: string; session: string } | null = null;

  const publish = (update: Partial<PayLine>, keep = false) => {
    line = { ...(keep ? line : { ...NO_PAY_LINE, receipt: line.receipt }), buyer, ...update };
    line.keepReceipt = buyer === 'guest' && !!memoryCode && !durable;
    listeners.forEach((run) => run(line));
  };

  /** The recovery code of this browser for this page: made once, kept, and never given to the page. */
  const recoveryCode = (): string => {
    // A code already made in this page's life is the code, whether or not the browser would keep it (no storage, or storage that refuses)
    if (memoryCode) return memoryCode;
    try {
      const stored = options.storage?.getItem(storageKey);
      if (stored && RECOVERY_CODE.test(stored)) {
        memoryCode = stored;
        return stored;
      }
      memoryCode = random(43);
      if (!options.storage) durable = false;
      options.storage?.setItem(storageKey, memoryCode);
    } catch {
      durable = false;
      memoryCode = memoryCode ?? random(43);
    }
    return memoryCode;
  };

  const indexedDBFactory = () => (options.indexedDB === undefined ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : options.indexedDB);

  /** The first code of this browser for this page, claimed atomically (the winner of the race, whichever tab); null when IndexedDB is not there or refuses. */
  const claimFirstCode = (candidate: string): Promise<string | null> =>
    new Promise((resolve) => {
      const factory = indexedDBFactory();
      if (!factory) return resolve(null);
      try {
        const open = factory.open('universe-pay', 1);
        open.onupgradeneeded = () => void open.result.createObjectStore('codes');
        open.onerror = () => resolve(null);
        open.onblocked = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          let winner: string | null = null;
          try {
            const tx = db.transaction('codes', 'readwrite');
            const store = tx.objectStore('codes');
            const read = store.get(storageKey);
            read.onsuccess = () => {
              const kept: unknown = read.result;
              if (typeof kept === 'string' && RECOVERY_CODE.test(kept)) winner = kept;
              else {
                winner = candidate;
                store.put(candidate, storageKey);
              }
            };
            tx.oncomplete = () => {
              db.close();
              resolve(winner);
            };
            tx.onerror = tx.onabort = () => {
              db.close();
              resolve(null);
            };
          } catch {
            db.close();
            resolve(null);
          }
        };
      } catch {
        resolve(null);
      }
    });

  let codeReady: Promise<string> | null = null;
  /**
   * Settles this browser's code before anything is sent with it. Two tabs that both find the storage empty would each make a code and the last
   * write would win, leaving the other tab buying under a code that is no longer kept: so the making is serialised across tabs (Web Locks,
   * where the browser has them) and the storage is read again inside the lock, so every tab ends up with the one that was written first. A
   * browser without locks claims the first code in IndexedDB (atomic across tabs); one with neither keeps a code of its own in the page only, never in the shared storage, and its receipt link is the way back.
   */
  const settleCode = (): Promise<string> => {
    if (memoryCode) return Promise.resolve(memoryCode);
    codeReady ??= (async () => {
      // A code this tab made for itself when nothing could coordinate is the code it bought under, and it stays so across a reload of the tab
      try {
        const own = options.tabStorage?.getItem(tabKey);
        if (own && RECOVERY_CODE.test(own)) return (memoryCode = own);
      } catch {
        // No tab storage
      }
      let stored: string | null = null;
      const readStored = () => {
        try {
          const value = options.storage?.getItem(storageKey);
          stored = value && RECOVERY_CODE.test(value) ? value : null;
        } catch {
          stored = null;
        }
      };
      /**
       * IndexedDB is the one place that decides, whichever way the tab got here (with the lock, or without): its transaction (read, and write only
       * if empty) is atomic across tabs. A code the storage already holds goes in first when IndexedDB has none, so an older code is never lost;
       * and the storage is only ever given a code when it holds none, never replaced.
       */
      const viaIndexedDB = async (): Promise<string | null> => {
        readStored();
        const claimed = await claimFirstCode(stored ?? random(43));
        if (!claimed) return null;
        memoryCode = claimed;
        try {
          const now = options.storage?.getItem(storageKey);
          if (!now || !RECOVERY_CODE.test(now)) options.storage?.setItem(storageKey, claimed);
        } catch {
          // The code lives in this page and in IndexedDB
        }
        return claimed;
      };
      /**
       * Nothing could make this tab take turns with the others (or IndexedDB, which decides for them all, is there but failed for this tab).
       * A code the storage already holds is used as it is (nothing is written); otherwise the code is this tab's own, in its own tab storage:
       * never in the shared storage, where it could replace the code another tab bought under.
       */
      const tabOnly = (): string => {
        readStored();
        if (stored) return (memoryCode = stored);
        memoryCode = random(43);
        try {
          if (!options.tabStorage) throw new Error('none');
          options.tabStorage.setItem(tabKey, memoryCode);
        } catch {
          // Nothing in this browser keeps it: the line asks the buyer to save the receipt link before the payment is confirmed
          durable = false;
        }
        return memoryCode;
      };
      const locks = (globalThis as { navigator?: { locks?: { request: <T>(name: string, run: () => T | Promise<T>) => Promise<T> } } }).navigator?.locks;
      if (locks?.request) {
        try {
          // One tab at a time. Inside the turn IndexedDB decides when it is there; when it is there but failed for this tab, the storage is NOT
          // written (another tab may have claimed a different code there); with no IndexedDB in this browser, the turn alone keeps the tabs apart
          return await locks.request(storageKey, async () => (await viaIndexedDB()) ?? (indexedDBFactory() ? tabOnly() : recoveryCode()));
        } catch {
          // The turn could not be taken: the code is settled the next way, never by an uncoordinated write
        }
      }
      const claimed = await viaIndexedDB();
      if (claimed) return claimed;
      return tabOnly();
    })();
    return codeReady;
  };

  /** The code of a receipt link this browser opened (kept for asking only), or null. */
  const receiptCode = (): string | null => {
    if (memoryReceipt) return memoryReceipt;
    try {
      const stored = options.storage?.getItem(receiptKey);
      if (stored && RECOVERY_CODE.test(stored)) memoryReceipt = stored;
    } catch {
      // No code kept
    }
    return memoryReceipt;
  };

  /** The link of an order that is still open, when the answer holds one the host may open (plain https only). */
  const resumeOf = (body: Record<string, unknown> | null): { url: string; app: string; popup: Window | null } | null => {
    const url = safeCheckout(typeof body?.checkoutUrl === 'string' ? body.checkoutUrl : null);
    return url ? { url, app: '', popup: null } : null;
  };

  const restoredOf = (body: Record<string, unknown> | null): { paidAt: string | null } => ({ paidAt: typeof body?.paidAt === 'string' ? body.paidAt : null });

  // Only a code already settled (under the lock, or claimed) is ever put in a receipt: making one here could write it outside the lock
  const receiptFor = (): string | null => (buyer === 'guest' && options.pageUrl && memoryCode ? `${options.pageUrl.split('#')[0]}#receipt=${memoryCode}` : null);

  /** Check payment and Restore each have a deadline of their own, and are cancelled when the host is destroyed: a stalled ask never blocks the next one for good. */
  const asking = new Set<AbortController>();
  const bounded = async <T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ASK_FOR_MS);
    asking.add(abort);
    try {
      return await run(abort.signal);
    } finally {
      clearTimeout(timer);
      asking.delete(abort);
    }
  };

  const post = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> => {
    // A receipt link's code goes only with a question (Restore, Check payment), never with the start of a purchase
    // Making the code may wait for another tab (Web Locks): that wait is part of what the deadline covers, so a held lock never keeps `busy` set
    const own = await untilAborted(settleCode(), signal);
    const link = body.restore || body.check ? receiptCode() : null;
    const response = await ask(base, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, recoveryCode: own, ...(link && link !== own ? { receiptCode: link } : {}) }), signal });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (json && (json.buyer === 'guest' || json.buyer === 'account')) buyer = json.buyer;
    return { ok: response.ok, status: response.status, body: json };
  };

  const tellRequest = (status: string, request: string, test = false, session: string | null = null) =>
    options.frame()?.postMessage({ universe: 'app-result', status, request, ...(session ? { session } : {}), ...(test ? { test: true } : {}) }, '*');

  /**
   * Whether the document that spoke last is the one that asked. A request is bound to the session its document gave itself: the answer carries
   * the session back (the page checks it is its own), and it is told only while no other document has spoken since.
   */
  const isAsker = (ticket: Ticket) => ticket.session !== null && lastSession === ticket.session;

  /**
   * A purchase that is found paid is also told to the page whose Restore was turned away while the checkout was on its way, when that page is the
   * one on show (it spoke last): else it would keep its pay button for a purchase that was made. Nothing else is ever told to it, and the
   * request that asked is not told twice.
   */
  const tellOwed = (paid: boolean, test: boolean, asked: { request: string; ticket: Ticket }) => {
    const owed = owedRestore;
    owedRestore = null;
    if (!paid || !owed || lastSession !== owed.session) return;
    if (asked.ticket.session === owed.session && asked.request === owed.request && isAsker(asked.ticket)) return;
    tellRequest('paid', owed.request, test, owed.session);
  };

  // How a checkout ended is told to the page that asked, and to no other document that has spoken since
  const end = (update: Partial<PayLine>, status: string, request: string, ticket: Ticket, test = false) => {
    busy = false;
    activeRequest = '';
    publish({ ...update, receipt: receiptFor() });
    if (isAsker(ticket)) tellRequest(status, request, test, ticket.session);
    tellOwed(!!update.paid, test, { request, ticket });
  };

  const stopTimers = () => {
    if (timer) clearTimeout(timer);
    if (deadline) clearTimeout(deadline);
    if (tabWatch) clearInterval(tabWatch);
    timer = deadline = tabWatch = undefined;
  };

  /** Asks about an order until it ends. The deadline has its own clock; a closed checkout tab gets its link back. */
  const watch = (orderId: string, checkout: { url: string; app: string; popup: Window | null } | null, request: string, ticket: Ticket, byReceipt = false) => {
    let over = false;
    let linkBack = false;
    // The look that is out now: a look that hangs is ended (after its own deadline, never later than the end of the watch), and none outlives the watch
    let looking: AbortController | undefined;
    const finish = (update: Partial<PayLine>, status: string, test = false) => {
      if (over || destroyed) return;
      over = true;
      stopTimers();
      looking?.abort();
      end(update, status, request, ticket, test);
    };
    const endsAt = Date.now() + POLL_FOR_MS;
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
      // A look is never started at the end of the watch or after it
      const left = endsAt - Date.now();
      if (left <= 0) return;
      let next = FIRST_POLL_MS;
      const look = new AbortController();
      looking = look;
      asking.add(look);
      const limit = setTimeout(() => look.abort(), Math.min(ASK_FOR_MS, left));
      try {
        const response = await ask(`${base}?order=${encodeURIComponent(orderId)}`, { cache: 'no-store', signal: look.signal });
        // Orbit answers an order as "not there" when it is not this buyer's any more (another account signed in on this device while the checkout
        // was on its way) or the page is no longer shared: the line of the one that left is cleared, and nothing of it is told to the one that came
        if (response.status === 404) {
          if (over || destroyed) return;
          return finish({}, 'unavailable');
        }
        const body = response.ok ? ((await response.json()) as { status?: string; testPayment?: boolean; pollAfterMs?: number }) : null;
        if (over || destroyed) return;
        if (body?.pollAfterMs && Number.isFinite(body.pollAfterMs)) next = Math.min(MOST_POLL_MS, Math.max(LEAST_POLL_MS, body.pollAfterMs));
        // An order found through a receipt link is "back", never a new purchase of this browser: no receipt of its own is offered for it, because
        // this browser's code would not bring it back
        if (body?.status === 'paid') return finish({ paid: { test: body.testPayment === true }, ...(byReceipt ? { restored: { paidAt: null } } : {}) }, 'paid', body.testPayment === true);
        // Closed, and the service has not had the last word: still being checked (there is no link to go on with), told to the page as one that could not be confirmed yet
        // More than 90 days past the late window: not "still checking" for ever, but told to contact the page's owner (the looks go on, and Check payment still asks)
        if ((body as { longWaitOver?: boolean } | null)?.longWaitOver === true) return finish({ problem: 'long_unconfirmed', canCheck: true }, 'cant_confirm');
        if (body?.status === 'checking' && (body as { longWait?: boolean }).longWait === true) return finish({ problem: 'still_checking', canCheck: true }, 'cant_confirm');
        if (body?.status === 'not_paid') return finish({ problem: 'not_paid', canCheck: true }, 'not_paid');
        if (body?.status === 'cant_confirm') return finish({ problem: 'cant_confirm', canCheck: true }, 'cant_confirm');
      } catch {
        // Try again on the next turn
      } finally {
        clearTimeout(limit);
        asking.delete(look);
        if (looking === look) looking = undefined;
      }
      if (!over && !destroyed) timer = setTimeout(() => void poll(), next);
    };
    timer = setTimeout(() => void poll(), FIRST_POLL_MS);
  };

  const adopt = (orderId: string, checkout: { url: string; app: string; popup: Window | null } | null, request: string, ticket: Ticket, byReceipt = false) => {
    busy = true;
    activeRequest = request;
    activeTicket = ticket;
    publish({ checking: true, resume: checkout && !checkout.popup ? { url: checkout.url, app: checkout.app } : null, receipt: receiptFor() });
    watch(orderId, checkout, request, ticket, byReceipt);
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
            const got = await post({ intentId }, abort.signal);
            // The service had trouble: the order may exist, so the same wish is sent again (it finds the order it made), like a lost answer
            if (got.status >= 500 && attempt + 1 < START_TRIES) {
              await waitFor(TRY_AGAIN_MS);
              continue;
            }
            answer = got;
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
          // Trouble on the way (a 5xx, a refusal that says `unsure`, or a good answer that holds nothing usable) may have left an order behind: Check payment asks about the same
          // wish. A definite answer (the page is gone, the owner stopped it, too many tries) does not
          const unsure = !limit && (answer.status >= 500 || answer.body?.unsure === true || (answer.ok && (!orderId || !url)));
          // The owner changed the payment on a version this link does not show yet: definite, nothing was made, and the line says why
          const unpublished = !limit && !unsure && answer.body?.code === 'not_published';
          return end({ problem: limit ? 'limit' : unpublished ? 'not_published' : 'unavailable', canCheck: unsure }, limit ? 'limit' : 'unavailable', request, ticket);
        }
        if (popup) popup.location.href = url;
        adopt(orderId, { url, app: typeof answer.body?.app === 'string' ? answer.body.app : '', popup }, request, ticket);
        if (isAsker(ticket)) tellRequest('started', request, false, ticket.session);
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
  /** An answer for this browser's own start that never finished and cannot be carried on yet: no link, and Restore has to be asked again later. */
  const stillStarting = (body: Record<string, unknown> | null, byWish = false): boolean =>
    body?.status === 'checking' && (byWish || body.via === 'own') && !body.checkoutUrl && typeof body.orderId === 'string';
  const askAgainIn = (body: Record<string, unknown> | null): number =>
    typeof body?.pollAfterMs === 'number' && Number.isFinite(body.pollAfterMs) ? Math.min(MOST_POLL_MS, Math.max(LEAST_POLL_MS, body.pollAfterMs)) : FIRST_POLL_MS;

  const restore = (request: string, ticket: Ticket) => {
    busy = true;
    activeRequest = request;
    activeTicket = ticket;
    lastRestore = { request, ticket };
    stopTimers();
    const attempt = async (since: number): Promise<void> => {
      try {
        const answer = await bounded((signal) => post({ restore: true }, signal));
        if (destroyed) return;
        const status = answer.body?.status;
        if (answer.ok && status === 'paid') return end({ paid: { test: answer.body?.testPayment === true }, restored: restoredOf(answer.body) }, 'paid', request, ticket, answer.body?.testPayment === true);
        // An order of theirs that closed while the service has still not had the last word: it may have been paid, so it is never "no purchase found" and
        // never waited on for twenty minutes (there is no link), and a new purchase is not held up by it
        // This Restore is now the ask Check payment follows (what it asks, and the request the page hears the answer under), not the wish of an earlier checkout
        if (answer.ok && status === 'checking' && answer.body?.longWait === true) {
          target = { intentId: null, request, ticket };
          return end({ problem: answer.body?.longWaitOver === true ? 'long_unconfirmed' : 'still_checking', canCheck: true }, 'cant_confirm', request, ticket);
        }
        // Their own start that never finished, not yet ready to be carried on: Orbit only does that when Restore is asked again after its wait,
        // so it is asked again, at the pace it gives, until the link comes, the purchase is found, or twenty minutes have passed
        if (answer.ok && stillStarting(answer.body)) {
          if (Date.now() - since >= POLL_FOR_MS) return end({ problem: 'cant_confirm', canCheck: true }, 'cant_confirm', request, ticket);
          publish({ checking: true });
          timer = setTimeout(() => void attempt(since), askAgainIn(answer.body));
          return;
        }
        // Nothing found by itself (a new phone, a cleared browser): the page is told so, and the buyer is offered Restore purchase, quietly
        if (answer.ok && status === 'none') return end({ offerRestore: true }, 'none', request, ticket);
        if (answer.ok && status === 'checking' && typeof answer.body?.orderId === 'string') {
          // An order of theirs is still open: it is watched like a new checkout, and the page hears how it ends under this request. Its own
          // link is offered, so a reload or a lost pop-up goes on with the SAME order and does not need a second one
          target = { intentId: null, request, ticket };
          return adopt(answer.body.orderId, resumeOf(answer.body), request, ticket, answer.body.via === 'receipt');
        }
        end({ problem: 'unavailable', canCheck: true }, 'unavailable', request, ticket);
      } catch {
        if (!destroyed) end({ problem: 'unavailable', canCheck: true }, 'unavailable', request, ticket);
      }
    };
    void attempt(Date.now());
  };

  const onMessage = (event: { source: unknown; data: unknown }) => {
    const frame = options.frame();
    if (destroyed || !frame || event.source !== frame) return;
    const data = event.data as { universe?: unknown; app?: unknown; request?: unknown; restore?: unknown; session?: unknown } | null;
    if (!data || data.universe !== 'use-app' || typeof data.app !== 'string') return;
    // A request without a valid id of its own, or without its document's session, is never answered: there would be no way to tell whose answer
    // it is. The buyer is told so on the host's own line, and can still check a payment (a bare status would be taken for whichever checkout
    // the page is waiting on)
    // While a checkout is on its way (a start, a check or a watch) the line is that checkout's, with its own link and actions: a message like
    // this one never replaces it, and is not told to anyone
    if (typeof data.request !== 'string' || !REQUEST_ID.test(data.request) || typeof data.session !== 'string' || !REQUEST_ID.test(data.session)) {
      if (!busy) publish({ needsUpdate: true, canCheck: true }, true);
      return;
    }
    const session = data.session;
    lastSession = session;
    if (busy) {
      // The same tap heard twice, from the same document, is the same request. Anything else while a checkout is on its way (or its start is
      // still waiting for an answer, however long it takes) is told so under its own id, and the checkout on its way keeps its own
      if (data.request !== activeRequest || !activeTicket || !isAsker(activeTicket)) {
        tellRequest('busy', data.request, false, session);
        // A Restore turned away is owed the end of this checkout if it is paid (the newest one only)
        if (data.restore === true) owedRestore = { request: data.request, session };
      }
      return;
    }
    const ticket: Ticket = { session };
    if (data.restore === true) return restore(data.request, ticket);
    begin(data.request, ticket);
  };

  /**
   * Asks Orbit again. Check payment asks about the wish of the last checkout when there is one; otherwise (a reload, or a page that cannot ask)
   * about whatever this buyer has bought, which is also all Restore purchase asks. A purchase found that way is "back", not made just now.
   */
  const askAgain = (restoring: boolean) => {
    if (destroyed || busy) return;
    // Check payment asks about the wish of the last checkout; with none (a load restore that failed, a reload) it asks as Restore does, and a
    // purchase it finds is told under that restore's request and session, so the page that asked hears it and does not keep its pay button
    const lastAsk = lastRestore ? { intentId: null, ...lastRestore } : { intentId: null, request: '', ticket: { session: null } };
    const asked = restoring ? lastAsk : target ?? lastAsk;
    busy = true;
    activeRequest = asked.request;
    activeTicket = asked.ticket;
    publish({ checking: true });
    stopTimers();
    const attempt = async (since: number): Promise<void> => {
      try {
        const answer = await bounded((signal) => post(asked.intentId ? { check: true, intentId: asked.intentId } : { restore: true }, signal));
        if (destroyed) return;
        const status = answer.body?.status;
        const test = answer.body?.testPayment === true;
        const request = asked.request;
        const done = (update: Partial<PayLine>, told: string, isTest = false) => {
          busy = false;
          activeRequest = '';
          publish({ ...update, receipt: receiptFor() });
          if (request && isAsker(asked.ticket)) tellRequest(told, request, isTest, asked.ticket.session);
          tellOwed(!!update.paid, isTest, { request, ticket: asked.ticket });
        };
        if (answer.ok && status === 'paid') return done({ paid: { test }, restored: asked.intentId ? null : restoredOf(answer.body) }, 'paid', test);
        // Closed, and the service has not had the last word: still being checked, never waited on (there is no link) and never "not paid"
        if (answer.ok && status === 'checking' && answer.body?.longWait === true) {
          // An explicit Restore becomes the ask Check payment follows; Check payment itself stays on the wish it asked by
          if (restoring) target = { intentId: null, request: asked.request, ticket: asked.ticket };
          return done({ problem: answer.body?.longWaitOver === true ? 'long_unconfirmed' : 'still_checking', canCheck: true }, 'cant_confirm');
        }
        // A closed order more than 90 days past its late window: told to contact the page's owner (the looks go on), never "not paid yet" or "still checking"
        if (answer.ok && answer.body?.longWaitOver === true && (status === 'not_paid' || status === 'cant_confirm')) return done({ problem: 'long_unconfirmed', canCheck: true }, 'cant_confirm');
        // This browser's own start that never finished and cannot be carried on yet (it may still be in flight, or its wait is not over): Orbit
        // resumes it only when it is asked about again by its wish (Check payment) or by Restore, never when an order is polled. So the same ask is
        // made again, at the pace the server gives, until the link comes (then it is adopted as any other), the purchase is found, or twenty
        // minutes pass. Check payment answers by the wish, so what it says carries no `via`: the wish is the buyer's own proof
        if (answer.ok && stillStarting(answer.body, !!asked.intentId)) {
          if (Date.now() - since >= POLL_FOR_MS) return done({ problem: 'cant_confirm', canCheck: true }, 'cant_confirm');
          timer = setTimeout(() => void attempt(since), askAgainIn(answer.body));
          return;
        }
        if (answer.ok && status === 'checking' && typeof answer.body?.orderId === 'string') return adopt(answer.body.orderId, resumeOf(answer.body), request, asked.ticket, answer.body.via === 'receipt');
        if (answer.ok && (status === 'not_paid' || status === 'cant_confirm')) return done({ problem: status, canCheck: true }, status);
        if (answer.ok && status === 'none') return done({ problem: 'none', canCheck: !restoring }, 'none');
        if (answer.status === 404) return done({ problem: 'none', canCheck: !restoring }, 'none');
        done({ problem: 'unavailable', canCheck: true }, 'unavailable');
      } catch {
        if (destroyed) return;
        // It never answered in time (or the network failed): said plainly, and pressed again when the buyer likes. The page hears it under its own
        // request, from its own document, and never otherwise
        busy = false;
        activeRequest = '';
        publish({ problem: 'unavailable', canCheck: true });
        if (asked.request && isAsker(asked.ticket)) tellRequest('unavailable', asked.request, false, asked.ticket.session);
        // A Restore turned away during this ask is owed nothing now: it is not told a later purchase under a request it has long moved on from
        tellOwed(false, false, { request: asked.request, ticket: asked.ticket });
      }
    };
    void attempt(Date.now());
  };

  return {
    subscribe(run) {
      listeners.add(run);
      run(line);
      return () => listeners.delete(run);
    },
    onMessage,
    checkPayment: () => askAgain(false),
    restorePurchase: () => askAgain(true),
    dismiss() {
      // Only a line that says nothing is going on can be closed: a payment on its way is never hidden
      if (destroyed || busy) return;
      publish({});
    },
    useReceiptCode(code) {
      if (destroyed || !RECOVERY_CODE.test(code)) return false;
      // Never this browser's own code: that one makes every new purchase, and a link someone sent must not make theirs the sender's
      memoryReceipt = code;
      try {
        options.storage?.setItem(receiptKey, code);
      } catch {
        // Kept for this page's life only
      }
      return true;
    },
    destroy() {
      destroyed = true;
      startInFlight?.abort.abort();
      startInFlight?.clear();
      asking.forEach((abort) => abort.abort());
      stopTimers();
      listeners.clear();
    },
  };
}
