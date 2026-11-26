/**
 * The host side of a paying page on the public share link (game #2044): it must speak what the game's window speaks, so the same published
 * page is told the same things in both. These run without a browser: the frame, the fetch and the clock are stand-ins.
 */
import { createPagePaymentsHost, safeCheckout, type PayLine } from '@/lib/page-payments-host';
import { describeLine } from '@/components/page-payments-words';

const PAGE = 'https://orbit.example.org/a/k7Qm2xR9';
const ART = 'art-1';

type Call = { url: string; init: RequestInit | undefined; body: Record<string, unknown> };

function setup(answers: (call: Call) => { status?: number; body: Record<string, unknown> } | 'lost' | 'hang', withStorage = true, shared?: Map<string, string>, withLocks = true, fill = 'r', indexedDB?: Pick<IDBFactory, 'open'> | null, tabStorage?: Map<string, string>) {
  jest.useFakeTimers();
  // A browser with Web Locks (one tab at a time per name) unless the test is about one without
  if (withLocks && !(globalThis as { navigator?: { locks?: unknown } }).navigator?.locks) {
    let tail: Promise<unknown> = Promise.resolve();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_name: string, run: () => unknown) => (tail = tail.then(() => run())) } } });
  }
  const frame = { postMessage: jest.fn() } as unknown as Window;
  const calls: Call[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, init, body: init?.body ? JSON.parse(init.body as string) : {} };
    calls.push(call);
    const answer = answers(call);
    if (answer === 'lost') throw new Error('network');
    // Never answers, until it is cancelled
    if (answer === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body } as Response;
  });
  const store = shared ?? new Map<string, string>();
  const popup = { opener: 'x', closed: false, close: jest.fn(), location: { href: '' } } as unknown as Window;
  let n = 0;
  const host = createPagePaymentsHost({
    artifactId: ART,
    frame: () => frame,
    openWindow: () => popup,
    fetch: fetchMock as unknown as typeof fetch,
    storage: withStorage ? { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) } : null,
    randomId: (length) => `${fill.repeat(length - String(++n).length)}${n}`,
    pageUrl: PAGE,
    indexedDB,
    tabStorage: tabStorage ? { getItem: (key) => tabStorage.get(key) ?? null, setItem: (key, value) => void tabStorage.set(key, value) } : undefined,
  });
  const lines: PayLine[] = [];
  host.subscribe((line) => lines.push(line));
  const told = () => (frame.postMessage as jest.Mock).mock.calls.map((call) => call[0]);
  // Every message of a page carries its request id and the session its document gave itself (one document unless a test says otherwise)
  const tap = (data: Record<string, unknown>, source: unknown = frame) => host.onMessage({ source, data: { universe: 'use-app', app: 'shop', session: 's1', ...data } });
  return { host, frame, calls, lines, told, tap, popup, store, fetchMock };
}

/** A stand-in for IndexedDB, shared by every tab of a test: its transactions run one at a time, as the real ones do across tabs. */
function fakeIndexedDB() {
  const data = new Map<string, unknown>();
  const open = () => {
    const request = {} as { result: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void };
    const db = {
      createObjectStore: () => undefined,
      close: () => undefined,
      transaction: () => {
        const tx = {} as { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown };
        let pending = 0;
        const settle = () => {
          if (--pending === 0) void Promise.resolve().then(() => tx.oncomplete?.());
        };
        const run = (work: () => unknown) => {
          const req = {} as { result: unknown; onsuccess?: () => void };
          pending++;
          void Promise.resolve().then(() => {
            req.result = work();
            req.onsuccess?.();
            settle();
          });
          return req;
        };
        tx.objectStore = () => ({ get: (key: string) => run(() => data.get(key)), put: (value: unknown, key: string) => run(() => void data.set(key, value)) });
        return tx;
      },
    };
    request.result = db;
    void Promise.resolve().then(() => {
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  };
  return { open } as unknown as Pick<IDBFactory, 'open'>;
}

const started = { orderId: 'o-1', checkoutUrl: 'https://checkout.examplepay.com/?t=1', app: 'ExamplePay', buyer: 'guest' };
const flush = () => jest.advanceTimersByTimeAsync(0);

afterEach(() => {
  jest.useRealTimers();
  delete (globalThis as { navigator?: unknown }).navigator;
});

describe('a paying page on the public share link', () => {
  it('starts a checkout under the page’s request id, with a wish and a recovery code of the host’s own making, and echoes the id', async () => {
    const { tap, calls, told, host, popup } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: false, pollAfterMs: 3000 } }));
    tap({ request: 'req_1' });
    await flush();
    expect(calls[0].url).toBe(`/api/pay/${ART}`);
    expect(calls[0].body.intentId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(calls[0].body.recoveryCode).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(popup.location.href).toBe(started.checkoutUrl);
    expect(told()).toEqual([{ universe: 'app-result', session: 's1', status: 'started', request: 'req_1' }]);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(told()).toEqual([
      { universe: 'app-result', session: 's1', status: 'started', request: 'req_1' },
      { universe: 'app-result', session: 's1', status: 'paid', request: 'req_1' },
    ]);
    host.destroy();
  });

  it('tells a test payment as a test: `test: true` goes with `paid`, and a live one carries no such flag', async () => {
    const test = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: true } }));
    test.tap({ request: 'req_1' });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(test.told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'paid', request: 'req_1', test: true });
    expect(test.lines.at(-1)?.paid).toEqual({ test: true });
    test.host.destroy();
  });

  it('never answers a page that sends no valid request id with a status: the line says it needs an update, and Check payment is offered', async () => {
    const { tap, told, lines, calls, host } = setup((call) => ({ body: call.body.restore ? { status: 'paid', testPayment: false, buyer: 'guest' } : started }));
    tap({});
    tap({ request: '' });
    tap({ request: 'has spaces' });
    tap({ request: 42 });
    tap({ request: 'x'.repeat(65) });
    await flush();
    expect(told()).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(lines.at(-1)).toMatchObject({ needsUpdate: true, canCheck: true, checking: false });
    // Check payment asks about this buyer's purchase: the page cannot be told (it has no id to be told under), the line says it
    host.checkPayment();
    await flush();
    expect(calls[0].body).toMatchObject({ restore: true });
    expect(lines.at(-1)?.paid).toEqual({ test: false });
    expect(told()).toEqual([]);
    host.destroy();
  });

  it('says busy, under its own id, to a second request while one is open, and ignores the same tap heard twice', async () => {
    const { tap, told, host, calls } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'checking' } }));
    tap({ request: 'a' });
    tap({ request: 'a' });
    tap({ request: 'b' });
    await flush();
    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(told()).toEqual([
      { universe: 'app-result', session: 's1', status: 'busy', request: 'b' },
      { universe: 'app-result', session: 's1', status: 'started', request: 'a' },
    ]);
    host.destroy();
  });

  it('tells a page that asks to restore as its scripts run: the request and its session are echoed', async () => {
    const { tap, told, host } = setup(() => ({ body: { status: 'paid', testPayment: false, orderId: 'o-1' } }));
    tap({ request: 'r1', restore: true, session: 's-one' });
    await flush();
    expect(told()).toEqual([{ universe: 'app-result', status: 'paid', request: 'r1', session: 's-one' }]);
    host.destroy();
  });

  it('gives a second document the same request id a truthful busy under its own session, and tells the first one’s result to nobody', async () => {
    const { tap, told, host, lines } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: false } }));
    tap({ request: 'a', session: 's-one' });
    await flush();
    await jest.advanceTimersByTimeAsync(500);
    // Document B (a reload, or another version) with a session of its own and the same request id
    tap({ request: 'a', session: 's-two' });
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'busy', request: 'a', session: 's-two' });
    const before = told().length;
    await jest.advanceTimersByTimeAsync(3_000);
    // A's payment was found, and nobody that is there now is told
    expect(lines.at(-1)?.paid).toEqual({ test: false });
    expect(told()).toHaveLength(before);
    host.destroy();
  });

  it('tells a newer page whose Restore was turned away while a checkout was on its way that the purchase was made, and nothing else', async () => {
    let order: 'paid' | 'not_paid' = 'paid';
    const { tap, told, host } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: order, testPayment: false } }));
    tap({ request: 'a', session: 's-one' });
    await flush();
    await jest.advanceTimersByTimeAsync(500);
    // A newer document asks to restore while the checkout is on its way: turned away with `busy`, and owed the end if it is paid
    tap({ request: 'r2', restore: true, session: 's-two' });
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'busy', request: 'r2', session: 's-two' });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'paid', request: 'r2', session: 's-two' });
    // The older document is not told (another has spoken since), and nothing is told twice
    expect(told().filter((message) => message.status === 'paid')).toHaveLength(1);
    host.destroy();
    // An ending that is not paid tells the turned-away Restore nothing: it asks again when the buyer likes
    order = 'not_paid';
    const other = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: order, testPayment: false } }));
    other.tap({ request: 'a', session: 's-one' });
    await flush();
    await jest.advanceTimersByTimeAsync(500);
    other.tap({ request: 'r2', restore: true, session: 's-two' });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(other.told().filter((message) => message.request === 'r2')).toEqual([{ universe: 'app-result', status: 'busy', request: 'r2', session: 's-two' }]);
    other.host.destroy();
  });

  it('a Restore turned away during a Check payment that then gives up is not told a later purchase', async () => {
    let check: 'hang' | 'paid' = 'hang';
    const { tap, host, told } = setup((call) => {
      if (call.body.check) return check === 'hang' ? 'hang' : { body: { status: 'paid', testPayment: false, orderId: 'o-1' } };
      return 'lost';
    });
    tap({ request: 'a', session: 's-one' });
    await jest.advanceTimersByTimeAsync(10_000);
    host.checkPayment();
    await flush();
    // Another document asks to restore while the check is waiting: turned away
    tap({ request: 'r2', restore: true, session: 's-two' });
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'busy', request: 'r2', session: 's-two' });
    // The check gives up (30 s), and a later check finds the purchase
    await jest.advanceTimersByTimeAsync(31_000);
    check = 'paid';
    host.checkPayment();
    await flush();
    expect(told().filter((message) => message.status === 'paid')).toEqual([]);
    host.destroy();
  });

  it('clears the line of a checkout that Orbit no longer answers for this buyer (another account signed in on the device), and tells the page nothing but that it is unavailable', async () => {
    let signedInElsewhere = false;
    const { tap, host, lines, told } = setup((call) => (call.init?.method === 'POST' ? { body: started } : signedInElsewhere ? { status: 404, body: { error: 'Not found' } } : { body: { status: 'checking', pollAfterMs: 3000 } }));
    tap({ request: 'a' });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(lines.at(-1)).toMatchObject({ checking: true });
    // Another account signs in on this device: the order is no longer this buyer's, and the previous account's status is gone
    signedInElsewhere = true;
    await jest.advanceTimersByTimeAsync(3_000);
    expect(lines.at(-1)).toMatchObject({ checking: false, paid: null, problem: null, canCheck: false, needsUpdate: false });
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'unavailable', request: 'a' });
    expect(told().some((message) => message.status === 'paid')).toBe(false);
    host.destroy();
  });

  it('a restored test purchase stays a test one for the page and the line, and a second restore of the same purchase starts nothing', async () => {
    const { tap, host, lines, told, calls } = setup((call) => (call.body.restore ? { body: { status: 'paid', testPayment: true, orderId: 'o-1', paidAt: '2026-11-19T10:00:00Z', via: 'own', buyer: 'guest' } } : 'lost'));
    tap({ request: 'r1', restore: true });
    await flush();
    expect(lines.at(-1)).toMatchObject({ paid: { test: true } });
    tap({ request: 'r2', restore: true });
    await flush();
    // Both are told a test payment, never a plain paid, and nothing but Restore was asked of Orbit (no start, no second purchase)
    expect(told()).toEqual([
      { universe: 'app-result', session: 's1', status: 'paid', request: 'r1', test: true },
      { universe: 'app-result', session: 's1', status: 'paid', request: 'r2', test: true },
    ]);
    expect(calls.every((call) => call.body.restore === true)).toBe(true);
    host.destroy();
  });

  it('answers the document that asked, and no other: the same document tapping again is the same request', async () => {
    const { tap, told, host } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: false } }));
    tap({ request: 'a', session: 's-one' });
    tap({ request: 'a', session: 's-one' });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(told()).toEqual([
      { universe: 'app-result', status: 'started', request: 'a', session: 's-one' },
      { universe: 'app-result', status: 'paid', request: 'a', session: 's-one' },
    ]);
    host.destroy();
  });

  it('never answers or starts anything for a request without a valid session (or request id): the line says the page needs an update', async () => {
    const { host, frame, calls, told, lines } = setup(() => ({ body: started }));
    const send = (data: Record<string, unknown>) => host.onMessage({ source: frame, data: { universe: 'use-app', app: 'shop', ...data } });
    send({ request: 'a' });
    send({ request: 'a', session: 'bad session!' });
    send({ request: 'a', session: '' });
    send({ session: 's1' });
    send({ request: 'a', session: 's1'.repeat(40) });
    await flush();
    expect(calls).toHaveLength(0);
    expect(told()).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ needsUpdate: true, canCheck: true, checking: false });
    host.destroy();
  });

  it('Check payment after a load restore that failed tells a purchase it finds to the page that asked, under its request and session', async () => {
    let answerAs: 'lost' | 'paid' = 'lost';
    const { tap, host, told, lines, calls } = setup(() => (answerAs === 'lost' ? 'lost' : { body: { status: 'paid', testPayment: false, orderId: 'o-1', paidAt: null, via: 'own', buyer: 'guest' } }));
    // The page's own load restore cannot be answered (offline), so it hears `unavailable` and nothing is on record for a wish
    tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(40_000);
    expect(told()).toEqual([{ universe: 'app-result', session: 's1', status: 'unavailable', request: 'r1' }]);
    expect(lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    // The buyer presses Check payment: the purchase is found, and the page that asked hears it (else it would keep its pay button)
    answerAs = 'paid';
    host.checkPayment();
    await flush();
    expect(calls.at(-1)?.body).toMatchObject({ restore: true });
    expect(lines.at(-1)).toMatchObject({ paid: { test: false } });
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'paid', request: 'r1' });
    host.destroy();
  });

  it('a message without a valid request or session never replaces the line of a checkout that is on its way', async () => {
    const { host, frame, tap, lines, told } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'checking', pollAfterMs: 3000 } }));
    tap({ request: 'a' });
    await flush();
    const before = lines.at(-1);
    expect(before).toMatchObject({ checking: true, needsUpdate: false });
    const send = (data: Record<string, unknown>) => host.onMessage({ source: frame, data: { universe: 'use-app', app: 'shop', ...data } });
    send({});
    send({ request: 'b' });
    send({ session: 's1' });
    await flush();
    // Still checking, with the checkout's own link, and nothing told to anyone
    expect(lines.at(-1)).toMatchObject({ checking: true, needsUpdate: false, canCheck: false });
    expect(lines.at(-1)?.resume).toEqual(before?.resume);
    expect(told().filter((message) => message.status !== 'started')).toEqual([]);
    host.destroy();
  });

  it('hears only the artifact’s own frame', async () => {
    const { tap, told, calls, host } = setup(() => ({ body: started }));
    tap({ request: 'a' }, {} as Window);
    tap({ request: 'a' }, null);
    await flush();
    expect(calls).toHaveLength(0);
    expect(told()).toEqual([]);
    host.destroy();
  });

  it('sends a start again with the SAME wish when its answer is lost, and tells the page once', async () => {
    let tries = 0;
    const { tap, calls, told, host } = setup((call) => {
      if (call.init?.method !== 'POST') return { body: { status: 'checking' } };
      tries += 1;
      return tries === 1 ? 'lost' : { body: started };
    });
    tap({ request: 'a' });
    await flush();
    await jest.advanceTimersByTimeAsync(1_000);
    const starts = calls.filter((call) => call.init?.method === 'POST');
    expect(starts).toHaveLength(2);
    expect(starts[1].body.intentId).toBe(starts[0].body.intentId);
    expect(told()).toEqual([{ universe: 'app-result', session: 's1', status: 'started', request: 'a' }]);
    host.destroy();
  });

  it('after every try is lost, says unavailable once and offers Check payment for the same wish', async () => {
    const { tap, calls, told, lines, host } = setup((call) => (call.body.check ? { body: { status: 'paid', testPayment: false, orderId: 'o-1' } } : 'lost'));
    tap({ request: 'a' });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(told()).toEqual([{ universe: 'app-result', session: 's1', status: 'unavailable', request: 'a' }]);
    expect(lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    const wish = calls[0].body.intentId;
    expect(calls.every((call) => call.body.intentId === wish)).toBe(true);
    host.checkPayment();
    await flush();
    expect(calls.at(-1)?.body).toMatchObject({ check: true, intentId: wish });
    // Found: the page that asked, in the opening it asked in, hears it under its own request
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'paid', request: 'a' });
    host.destroy();
  });

  it('does not tell a payment found later to a document that has spoken since', async () => {
    const { tap, told, host, lines } = setup((call) => (call.body.check ? { body: { status: 'paid', testPayment: false } } : call.body.restore ? { body: { status: 'none', testPayment: false } } : 'lost'));
    tap({ request: 'a', session: 's-one' });
    await jest.advanceTimersByTimeAsync(10_000);
    // Another document speaks (a reload that asks to restore)
    tap({ request: 'b', restore: true, session: 's-two' });
    await flush();
    const before = told().length;
    host.checkPayment();
    await flush();
    expect(told()).toHaveLength(before);
    expect(lines.at(-1)?.paid).toEqual({ test: false });
    host.destroy();
  });

  it('gets a purchase back for a page that loads and asks to restore, under its request, with the test flag', async () => {
    const { tap, calls, told, host } = setup(() => ({ body: { status: 'paid', testPayment: true, orderId: 'o-9', buyer: 'guest' } }));
    tap({ request: 'r1', restore: true });
    await flush();
    expect(calls[0].body).toMatchObject({ restore: true });
    expect(calls[0].body.intentId).toBeUndefined();
    expect(told()).toEqual([{ universe: 'app-result', session: 's1', status: 'paid', request: 'r1', test: true }]);
    host.destroy();
  });

  it('says a closed order the service has not had the last word about is "still being checked": never "no purchase found", never waited on, never "not paid"', async () => {
    const unresolved = { status: 'checking', longWait: true, orderId: 'o-9', checkoutUrl: null, testPayment: false, via: 'own', buyer: 'guest', pollAfterMs: 15_000 };
    // Restore (the page asks for its purchase back): one ask, no watching for twenty minutes, the page is told it could not be confirmed yet
    const restored = setup((call) => (call.body.restore ? { body: unresolved } : { body: { status: 'paid', testPayment: false } }));
    restored.tap({ request: 'r1', restore: true });
    await flush();
    expect(restored.lines.at(-1)).toMatchObject({ problem: 'still_checking', canCheck: true, checking: false, paid: null, offerRestore: false });
    expect(restored.told()).toEqual([{ universe: 'app-result', session: 's1', status: 'cant_confirm', request: 'r1' }]);
    // What the guest reads, and what can be pressed: Check payment, and not the sentence for a purchase that was never found
    const view = describeLine(restored.lines.at(-1)!, { copied: false });
    expect(view).toMatchObject({ title: 'We’re still checking your earlier payment.', closable: false, actions: [{ kind: 'check' }] });
    expect(JSON.stringify(view)).not.toMatch(/No purchase found|Not paid yet/);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(restored.calls).toHaveLength(1);
    restored.host.destroy();
    // Check payment by the wish of the last checkout says the same (the start's answer was lost, so the wish is on record)
    const checked = setup((call) => (call.body.check ? { body: unresolved } : 'lost'));
    checked.tap({ request: 'r2' });
    await jest.advanceTimersByTimeAsync(10_000);
    checked.host.checkPayment();
    await flush();
    expect(checked.calls.at(-1)?.body).toMatchObject({ check: true });
    expect(checked.lines.at(-1)).toMatchObject({ problem: 'still_checking', canCheck: true, checking: false });
    expect(describeLine(checked.lines.at(-1)!, { copied: false })?.title).toBe('We’re still checking your earlier payment.');
    expect(checked.told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'cant_confirm', request: 'r2' });
    checked.host.destroy();
  });

  it('more than 90 days past the late window the buyer is told to contact the page’s owner, never "still checking" for ever: Restore, Check payment and a polled order all say so, and Check payment can still be pressed (the looks go on)', async () => {
    const restoredOver = { status: 'checking', longWait: true, longWaitOver: true, orderId: 'o-9', checkoutUrl: null, testPayment: false, via: 'own', buyer: 'guest', pollAfterMs: 15_000 };
    const checkedOver = { status: 'not_paid', longWaitOver: true, orderId: 'o-9', checkoutUrl: null, testPayment: false, buyer: 'guest', pollAfterMs: 15_000 };
    const restored = setup((call) => (call.body.restore ? { body: restoredOver } : { body: { status: 'paid', testPayment: false } }));
    restored.tap({ request: 'r1', restore: true });
    await flush();
    expect(restored.lines.at(-1)).toMatchObject({ problem: 'long_unconfirmed', canCheck: true, checking: false, paid: null });
    expect(restored.told()).toEqual([{ universe: 'app-result', session: 's1', status: 'cant_confirm', request: 'r1' }]);
    const view = describeLine(restored.lines.at(-1)!, { copied: false });
    expect(view).toMatchObject({ title: 'We could not confirm your earlier payment.', closable: false, actions: [{ kind: 'check' }] });
    expect(view?.sub).toContain('contact the page’s owner with the time of the payment');
    // The page stops refreshing on this line, so the buyer is told how to get a later update: the Check payment button on it
    expect(view?.sub).toContain('press Check payment to see a later update');
    expect(JSON.stringify(view)).not.toMatch(/still checking|Not paid yet/);
    restored.host.destroy();
    const checked = setup((call) => (call.body.check ? { body: checkedOver } : 'lost'));
    checked.tap({ request: 'r2' });
    await jest.advanceTimersByTimeAsync(10_000);
    checked.host.checkPayment();
    await flush();
    expect(checked.lines.at(-1)).toMatchObject({ problem: 'long_unconfirmed', canCheck: true, checking: false });
    expect(describeLine(checked.lines.at(-1)!, { copied: false })?.title).toBe('We could not confirm your earlier payment.');
    checked.host.destroy();
  });

  it('a checkout that is polled and answers more than 90 days past the late window: the line says contact the owner, Check payment stays available, and the host sends no further polls (CodeRabbit nitpick: the polling path)', async () => {
    // A successful checkout (the POST), then the order's poll (the GET) answers as Orbit does for an order in the long wait past its words: closed, with `longWaitOver`
    const { tap, host, lines, told, calls } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'not_paid', longWaitOver: true, orderId: 'o-1', checkoutUrl: null, testPayment: false, buyer: 'guest', pollAfterMs: 15_000 } }));
    tap({ request: 'req_1' });
    await flush();
    const polls = () => calls.filter((call) => call.init?.method !== 'POST').length;
    expect(polls()).toBe(0);
    // The first poll
    await jest.advanceTimersByTimeAsync(3_000);
    expect(polls()).toBe(1);
    expect(calls.at(-1)?.url).toContain('?order=o-1');
    expect(lines.at(-1)).toMatchObject({ problem: 'long_unconfirmed', canCheck: true, checking: false, paid: null });
    const view = describeLine(lines.at(-1)!, { copied: false });
    expect(view).toMatchObject({ title: 'We could not confirm your earlier payment.', closable: false, actions: [{ kind: 'check' }] });
    expect(JSON.stringify(view)).not.toMatch(/still checking|Not paid yet/);
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'cant_confirm', request: 'req_1' });
    // The watch is over: not one more poll, however long the page stays open (the buyer presses Check payment for an update)
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(polls()).toBe(1);
    host.destroy();
  });

  it('after a Restore that finds an order still being checked, Check payment follows that Restore (its ask and its request), while Check payment by an earlier wish stays on that wish', async () => {
    const unresolved = { status: 'checking', longWait: true, orderId: 'o-9', checkoutUrl: null, testPayment: false, via: 'own', buyer: 'guest', pollAfterMs: 15_000 };
    const earlier = setup((call) => (call.body.restore || call.body.check ? { body: unresolved } : 'lost'));
    earlier.tap({ request: 'r1' });
    await jest.advanceTimersByTimeAsync(10_000);
    // The page then asks for its purchase back (request r2): still being checked, told under r2
    earlier.tap({ request: 'r2', restore: true });
    await flush();
    expect(earlier.told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'cant_confirm', request: 'r2' });
    // Check payment now asks as that Restore did, and the page hears it under r2 (not under r1, whose checkout is long over)
    earlier.host.checkPayment();
    await flush();
    expect(earlier.calls.at(-1)?.body).toMatchObject({ restore: true });
    expect(earlier.calls.at(-1)?.body.intentId).toBeUndefined();
    expect(earlier.told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'cant_confirm', request: 'r2' });
    earlier.host.destroy();
    // The explicit Restore purchase button does the same
    const button = setup((call) => (call.body.restore || call.body.check ? { body: unresolved } : 'lost'));
    button.tap({ request: 'r3' });
    await jest.advanceTimersByTimeAsync(10_000);
    button.host.restorePurchase();
    await flush();
    button.host.checkPayment();
    await flush();
    expect(button.calls.at(-1)?.body).toMatchObject({ restore: true });
    button.host.destroy();
  });

  it('tells a page "none" when a restore finds nothing, and watches an order of theirs that is still open', async () => {
    const none = setup(() => ({ body: { status: 'none', testPayment: false, orderId: null } }));
    none.tap({ request: 'r1', restore: true });
    await flush();
    expect(none.told()).toEqual([{ universe: 'app-result', session: 's1', status: 'none', request: 'r1' }]);
    none.host.destroy();
    const open = setup((call) => (call.body.restore ? { body: { status: 'checking', orderId: 'o-2' } } : { body: { status: 'paid', testPayment: false } }));
    open.tap({ request: 'r2', restore: true });
    await flush();
    expect(open.told()).toEqual([]);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(open.told()).toEqual([{ universe: 'app-result', session: 's1', status: 'paid', request: 'r2' }]);
    open.host.destroy();
    const link = setup((call) => (call.body.restore ? { body: { status: 'checking', orderId: 'o-3', checkoutUrl: started.checkoutUrl } } : { body: { status: 'checking' } }));
    link.tap({ request: 'r3', restore: true });
    await flush();
    // The open order's own link is on the line, so a reload does not need a second order
    expect(link.lines.at(-1)).toMatchObject({ checking: true, resume: { url: started.checkoutUrl } });
    link.host.destroy();
    const bad = setup((call) => (call.body.restore ? { body: { status: 'checking', orderId: 'o-4', checkoutUrl: 'http://not-secure.example/x' } } : { body: { status: 'checking' } }));
    bad.tap({ request: 'r4', restore: true });
    await flush();
    expect(bad.lines.at(-1)?.resume).toBeNull();
    bad.host.destroy();
    open.host.destroy();
  });

  it('follows the server’s wait between questions, and never faster than a second or slower than half a minute', async () => {
    let asked = 0;
    const { tap, host } = setup((call) => {
      if (call.init?.method === 'POST') return { body: started };
      asked += 1;
      return { body: { status: 'checking', pollAfterMs: asked === 1 ? 10_000 : 5 } };
    });
    tap({ request: 'a' });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(asked).toBe(1);
    await jest.advanceTimersByTimeAsync(9_000);
    expect(asked).toBe(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(asked).toBe(2);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(asked).toBe(3);
    host.destroy();
  });

  it('stops asking after twenty minutes, says it could not confirm, and offers Check payment', async () => {
    const { tap, told, lines, host } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'checking', pollAfterMs: 15_000 } }));
    tap({ request: 'a' });
    await flush();
    await jest.advanceTimersByTimeAsync(20 * 60_000 + 100);
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'cant_confirm', request: 'a' });
    expect(lines.at(-1)).toMatchObject({ problem: 'cant_confirm', canCheck: true, checking: false });
    host.destroy();
  });

  // The watch's end (from the 20 minute watch tests that came with the tree's bridge, now speaking the request-id protocol)
  describe('the end of the twenty minute watch', () => {
    const MIN = 60_000;
    const cantConfirm = { universe: 'app-result', session: 's1', status: 'cant_confirm', request: 'a' };

    it('ends at twenty minutes and says so, though a look at the order is still waiting for an answer, and ends that look', async () => {
      const looks: AbortSignal[] = [];
      const { tap, told, lines, host, calls } = setup((call) => {
        if (call.init?.method === 'POST') return { body: started };
        looks.push(call.init!.signal as AbortSignal);
        return 'hang';
      });
      tap({ request: 'a' });
      await flush();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(looks.length).toBe(1);
      await jest.advanceTimersByTimeAsync(20 * MIN + 1_000 - 3_000);
      expect(looks.every((signal) => signal.aborted)).toBe(true);
      expect(told()).toContainEqual(cantConfirm);
      expect(lines.at(-1)).toMatchObject({ problem: 'cant_confirm', canCheck: true, checking: false });
      // Nothing is asked after it ended
      const asked = calls.length;
      await jest.advanceTimersByTimeAsync(5 * MIN);
      expect(calls.length).toBe(asked);
      host.destroy();
    });

    it('does not ask again after a look that fails just before the end: no request goes out past it, and the end is on time', async () => {
      const startedAt = Date.now();
      const lookTimes: number[] = [];
      const { tap, told, host } = setup((call) => {
        if (call.init?.method === 'POST') return { body: started };
        lookTimes.push(Date.now() - startedAt);
        return 'lost';
      });
      tap({ request: 'a' });
      await flush();
      await jest.advanceTimersByTimeAsync(20 * MIN - 500);
      expect(told()).not.toContainEqual(cantConfirm);
      await jest.advanceTimersByTimeAsync(600);
      expect(told()).toContainEqual(cantConfirm);
      const looks = lookTimes.length;
      await jest.advanceTimersByTimeAsync(10_000);
      expect(lookTimes.length).toBe(looks);
      expect(Math.max(...lookTimes)).toBeLessThanOrEqual(20 * MIN);
      host.destroy();
    });

    it('never starts a look once the watch\'s time is up, even when every look before it answered at once', async () => {
      const startedAt = Date.now();
      const starts: number[] = [];
      const { tap, told, host } = setup((call) => {
        if (call.init?.method === 'POST') return { body: started };
        starts.push(Date.now() - startedAt);
        return { body: { status: 'checking' } };
      });
      tap({ request: 'a' });
      await flush();
      await jest.advanceTimersByTimeAsync(20 * MIN + 10_000);
      expect(starts.length).toBeGreaterThan(10);
      expect(starts.filter((at) => at >= 20 * MIN)).toEqual([]);
      expect(told()).toContainEqual(cantConfirm);
      host.destroy();
    });

    it('ends at the moment its twenty minutes are up, not at the next poll, when the last look answers just before the end', async () => {
      const startedAt = Date.now();
      const { tap, told, host, fetchMock } = setup(() => ({ body: {} }));
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
        const answer = { ok: true, status: 200, json: async () => (init?.method === 'POST' ? started : { status: 'checking' }) } as Response;
        const left = startedAt + 20 * MIN - Date.now();
        if (init?.method === 'POST' || left > 4_000) return answer;
        // The last look before the end answers half a second before it, and the next poll would only come three seconds after that
        return new Promise<Response>((resolve) => setTimeout(() => resolve(answer), left - 500));
      });
      tap({ request: 'a' });
      await flush();
      await jest.advanceTimersByTimeAsync(20 * MIN + 100);
      expect(told()).toContainEqual(cantConfirm);
      host.destroy();
    });

    it('limits a look that hangs to the time the watch has left, so the end is on time even for a look begun just before it', async () => {
      const startedAt = Date.now();
      const looks: Array<{ at: number; signal: AbortSignal }> = [];
      const { tap, told, host } = setup((call) => {
        if (call.init?.method === 'POST') return { body: started };
        // The first looks answer at once; the last one before the end hangs
        if (Date.now() - startedAt < 20 * MIN - 10_000) return { body: { status: 'checking', pollAfterMs: 9_000 } };
        looks.push({ at: Date.now() - startedAt, signal: call.init!.signal as AbortSignal });
        return 'hang';
      });
      tap({ request: 'a' });
      await flush();
      await jest.advanceTimersByTimeAsync(20 * MIN - 1);
      expect(looks.length).toBeGreaterThan(0);
      await jest.advanceTimersByTimeAsync(2);
      expect(looks.every((look) => look.signal.aborted)).toBe(true);
      expect(told()).toContainEqual(cantConfirm);
      host.destroy();
    });
  });

  it('keeps one recovery code per browser and page, never tells it to the page, and gives a guest a receipt link with it in the fragment', async () => {
    const { tap, calls, told, lines, store, host } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: false } }));
    tap({ request: 'a' });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    tap({ request: 'b' });
    await flush();
    const codes = new Set(calls.filter((call) => call.init?.method === 'POST').map((call) => call.body.recoveryCode));
    expect(codes.size).toBe(1);
    const code = [...codes][0] as string;
    expect(store.get(`universe-pay-recovery:${ART}`)).toBe(code);
    expect(JSON.stringify(told())).not.toContain(code);
    expect(lines.at(-1)?.receipt).toBe(`${PAGE}#receipt=${code}`);
    host.destroy();
  });

  it('keeps the same recovery code for the whole page life when the browser has no storage, so retries, checks and the receipt link agree', async () => {
    const { tap, calls, lines, host } = setup((call) => (call.init?.method === 'POST' && !call.body.check ? { body: started } : { body: { status: 'checking' } }), false);
    tap({ request: 'a' });
    await flush();
    host.destroy();
    const again = setup((call) => (call.body.intentId && !call.body.check ? 'lost' : { body: { status: 'paid', testPayment: false } }), false);
    again.tap({ request: 'a' });
    await jest.advanceTimersByTimeAsync(10_000);
    again.host.checkPayment();
    await flush();
    const codes = new Set(again.calls.map((call) => call.body.recoveryCode));
    expect(codes.size).toBe(1);
    expect(calls[0].body.recoveryCode).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(lines.at(-1)?.receipt).toBe(`${PAGE}#receipt=${calls[0].body.recoveryCode}`);
    again.host.destroy();
  });

  it('keeps the same recovery code when the browser’s storage refuses to be read or written', async () => {
    jest.useFakeTimers();
    const frame = { postMessage: jest.fn() } as unknown as Window;
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const host = createPagePaymentsHost({
      artifactId: ART,
      frame: () => frame,
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(init?.body ? JSON.parse(init.body as string) : {});
        return { ok: true, status: 200, json: async () => ({ status: 'none', testPayment: false, orderId: null, buyer: 'guest' }) } as Response;
      }) as unknown as typeof fetch,
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
      randomId: (length) => `${'q'.repeat(length - String(++n).length)}${n}`,
      pageUrl: PAGE,
    });
    host.onMessage({ source: frame, data: { universe: 'use-app', app: 'shop', request: 'r1', session: 's1', restore: true } });
    await flush();
    host.onMessage({ source: frame, data: { universe: 'use-app', app: 'shop', request: 'r2', session: 's1', restore: true } });
    await flush();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].recoveryCode).toBe(bodies[0].recoveryCode);
    host.destroy();
  });

  it('offers no receipt link to a signed-in buyer, who has an account to get back to', async () => {
    const { tap, lines, host } = setup((call) => (call.init?.method === 'POST' ? { body: { ...started, buyer: 'account' } } : { body: { status: 'checking' } }));
    tap({ request: 'a' });
    await flush();
    expect(lines.at(-1)?.receipt).toBeNull();
    host.destroy();
  });

  it('says limit and unavailable once, under the request, and an address that is not plain https is never opened', async () => {
    const limit = setup(() => ({ status: 429, body: { code: 'limit' } }));
    limit.tap({ request: 'a' });
    await flush();
    expect(limit.told()).toEqual([{ universe: 'app-result', session: 's1', status: 'limit', request: 'a' }]);
    limit.host.destroy();
    const bad = setup(() => ({ body: { ...started, checkoutUrl: 'http://checkout.examplepay.com/x' } }));
    bad.tap({ request: 'a' });
    await flush();
    expect(bad.told()).toEqual([{ universe: 'app-result', session: 's1', status: 'unavailable', request: 'a' }]);
    expect(bad.popup.location.href).toBe('');
    bad.host.destroy();
    expect([safeCheckout('https://a.example/x'), safeCheckout('https://u:p@a.example/'), safeCheckout(null)]).toEqual(['https://a.example/x', undefined, undefined]);
  });

  it('after "not paid" the page can still be told a late payment, by Check payment, under the request it was started for', async () => {
    let looks = 0;
    const { tap, told, lines, host } = setup((call) => {
      if (call.init?.method === 'POST' && call.body.check) return { body: { status: 'paid', testPayment: false } };
      if (call.init?.method === 'POST') return { body: started };
      looks += 1;
      return { body: { status: 'not_paid' } };
    });
    tap({ request: 'a' });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(looks).toBe(1);
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'not_paid', request: 'a' });
    expect(lines.at(-1)).toMatchObject({ problem: 'not_paid', canCheck: true });
    host.checkPayment();
    await flush();
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'paid', request: 'a' });
    // Never a status without a request id
    expect(told().every((message) => typeof message.request === 'string' && message.request.length > 0)).toBe(true);
    host.destroy();
  });
  it('marks a purchase found again as "back" (with its date) and one made just now as not, and offers Restore purchase when a page’s restore finds nothing', async () => {
    const back = setup(() => ({ body: { status: 'paid', testPayment: false, orderId: 'o-9', buyer: 'account', paidAt: '2026-11-19T08:00:00.000Z' } }));
    back.tap({ request: 'r1', restore: true });
    await flush();
    expect(back.lines.at(-1)).toMatchObject({ paid: { test: false }, restored: { paidAt: '2026-11-19T08:00:00.000Z' }, buyer: 'account', offerRestore: false });
    back.host.destroy();
    const fresh = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: false } }));
    fresh.tap({ request: 'r1' });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(fresh.lines.at(-1)).toMatchObject({ paid: { test: false }, restored: null });
    fresh.host.destroy();
    const none = setup(() => ({ body: { status: 'none', testPayment: false, orderId: null, buyer: 'guest' } }));
    none.tap({ request: 'r1', restore: true });
    await flush();
    expect(none.lines.at(-1)).toMatchObject({ offerRestore: true, buyer: 'guest', paid: null, problem: null });
    none.host.destroy();
  });

  it('Restore purchase asks as the buyer, tells the page under its last restore request when it finds the purchase, and says "none" plainly when it does not', async () => {
    let found = false;
    const { tap, host, lines, told, calls } = setup((call) => ({ body: call.body.restore && found ? { status: 'paid', testPayment: false, buyer: 'guest', paidAt: '2026-11-18T08:00:00.000Z' } : { status: 'none', testPayment: false, buyer: 'guest' } }));
    tap({ request: 'r1', restore: true });
    await flush();
    host.restorePurchase();
    await flush();
    expect(calls.at(-1)?.body).toMatchObject({ restore: true });
    expect(lines.at(-1)).toMatchObject({ problem: 'none', buyer: 'guest', canCheck: false });
    host.dismiss();
    expect(lines.at(-1)).toMatchObject({ problem: null, offerRestore: false, paid: null });
    found = true;
    host.restorePurchase();
    await flush();
    expect(lines.at(-1)).toMatchObject({ paid: { test: false }, restored: { paidAt: '2026-11-18T08:00:00.000Z' } });
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'paid', request: 'r1' });
    host.destroy();
  });

  it('never closes a payment that is on its way', async () => {
    const { tap, host, lines } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'checking' } }));
    tap({ request: 'a' });
    await flush();
    host.dismiss();
    expect(lines.at(-1)?.checking).toBe(true);
    host.destroy();
  });

  it('keeps a receipt link’s code apart from the browser’s own: it is sent only with Restore and Check payment, never stored over the own code, and never makes a purchase', async () => {
    const { host, tap, calls, store } = setup((call) => (call.init?.method === 'POST' && !call.body.restore && !call.body.check ? { body: started } : { body: { status: 'none', testPayment: false, buyer: 'guest' } }));
    const link = 'R'.repeat(43);
    expect(host.useReceiptCode('short')).toBe(false);
    expect(host.useReceiptCode('x'.repeat(40) + '!')).toBe(false);
    // The browser already has its own code
    tap({ request: 'r0', restore: true });
    await flush();
    const own = calls[0].body.recoveryCode as string;
    expect(host.useReceiptCode(link)).toBe(true);
    expect(store.get(`universe-pay-recovery:${ART}`)).toBe(own);
    expect(store.get(`universe-pay-receipt:${ART}`)).toBe(link);
    tap({ request: 'r1', restore: true });
    await flush();
    expect(calls[1].body).toMatchObject({ restore: true, recoveryCode: own, receiptCode: link });
    // A purchase made now is made under the browser's own code, and the link's code is not even sent with it
    tap({ request: 'r2' });
    await flush();
    const start = calls.at(-1)!;
    expect(start.body.intentId).toBeDefined();
    expect(start.body.recoveryCode).toBe(own);
    expect(start.body.receiptCode).toBeUndefined();
    host.destroy();
  });

  it('remembers a receipt link’s code for the next load of the page, since the address no longer holds it', async () => {
    const link = 'R'.repeat(43);
    const first = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }));
    first.host.useReceiptCode(link);
    const kept = new Map(first.store);
    first.host.destroy();
    const next = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }));
    kept.forEach((value, key) => next.store.set(key, value));
    next.tap({ request: 'r1', restore: true });
    await flush();
    expect(next.calls[0].body.receiptCode).toBe(link);
    next.host.destroy();
  });
  it('gives Check payment and Restore a deadline of their own: a stalled one is said plainly, the host is free again, and the page hears it under its request', async () => {
    let stall = true;
    const { tap, host, lines, told } = setup(() => (stall ? 'hang' : { body: { status: 'none', testPayment: false, buyer: 'guest' } }));
    tap({ request: 'r1', restore: true });
    await flush();
    expect(lines.at(-1)?.checking ?? false).toBe(false);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    expect(told().at(-1)).toEqual({ universe: 'app-result', session: 's1', status: 'unavailable', request: 'r1' });
    // Pressed again: it is not blocked, and a stalled one is cancelled too
    host.checkPayment();
    await flush();
    expect(lines.at(-1)?.checking).toBe(true);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    stall = false;
    host.restorePurchase();
    await flush();
    expect(lines.at(-1)).toMatchObject({ problem: 'none' });
    host.destroy();
  });

  it('keeps Check payment after trouble at the service or a good answer with nothing in it, tries the same wish again first, and not after a clear refusal', async () => {
    let calls = 0;
    const trouble = setup(() => {
      calls += 1;
      return { status: 503, body: {} };
    });
    trouble.tap({ request: 'a' });
    await flush();
    await jest.advanceTimersByTimeAsync(5_000);
    // Three tries with the SAME wish, then Check payment for it
    expect(calls).toBe(3);
    expect(new Set(trouble.calls.map((call) => call.body.intentId)).size).toBe(1);
    expect(trouble.lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    trouble.host.destroy();
    const empty = setup(() => ({ body: {} }));
    empty.tap({ request: 'a' });
    await flush();
    expect(empty.lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    empty.host.destroy();
    const refused = setup(() => ({ status: 409, body: { code: 'unavailable' } }));
    refused.tap({ request: 'a' });
    await flush();
    expect(refused.lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: false });
    refused.host.destroy();
    // A refusal that says an order may have been made (the start was unsure) keeps Check payment
    const unsure = setup(() => ({ status: 409, body: { code: 'unavailable', unsure: true } }));
    unsure.tap({ request: 'a' });
    await flush();
    expect(unsure.lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    unsure.host.destroy();
    // The owner changed the payment on a version this link does not show yet (O2): definite, the line says why, the page hears only unavailable
    const unpublished = setup(() => ({ status: 409, body: { code: 'not_published' } }));
    unpublished.tap({ request: 'a' });
    await flush();
    expect(unpublished.lines.at(-1)).toMatchObject({ problem: 'not_published', canCheck: false });
    expect(unpublished.told()).toEqual([{ universe: 'app-result', session: 's1', status: 'unavailable', request: 'a' }]);
    unpublished.host.destroy();
  });

  it('keeps asking Restore, not the order, while the buyer’s own unfinished start cannot be carried on yet, and takes its link when it comes', async () => {
    let restores = 0;
    const { tap, host, lines, calls } = setup((call) => {
      if (call.body.restore) {
        restores += 1;
        // An early reload: twice "still going on" with no link, then the wait is over and Orbit hands back the link
        return restores < 3 ? { body: { status: 'checking', orderId: 'o-7', via: 'own', checkoutUrl: null, pollAfterMs: 3000, buyer: 'guest' } } : { body: { status: 'checking', orderId: 'o-7', via: 'own', checkoutUrl: 'https://checkout.examplepay.com/?t=7', pollAfterMs: 3000, buyer: 'guest' } };
      }
      return { body: { status: 'checking', pollAfterMs: 3000 } };
    });
    tap({ request: 'r1', restore: true });
    await flush();
    expect(restores).toBe(1);
    expect(lines.at(-1)).toMatchObject({ checking: true, resume: null });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(restores).toBe(2);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(restores).toBe(3);
    // The link is on the line now, and the order is watched from here (it is asked about, never started again)
    expect(lines.at(-1)).toMatchObject({ checking: true, resume: { url: 'https://checkout.examplepay.com/?t=7' } });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(calls.some((call) => call.url.includes('order=o-7'))).toBe(true);
    host.destroy();
  });

  it('keeps asking Check payment (by its wish) while a start that was unsure cannot be carried on yet, and takes the link when it comes', async () => {
    let checks = 0;
    const { tap, host, lines, calls } = setup((call) => {
      if (call.body.check) {
        checks += 1;
        // The resume itself was unsure twice (the order stays "being made"), then it goes through and the link comes
        return checks < 3 ? { body: { status: 'checking', orderId: 'o-9', checkoutUrl: null, pollAfterMs: 3000, buyer: 'guest' } } : { body: { status: 'checking', orderId: 'o-9', checkoutUrl: 'https://checkout.examplepay.com/?t=9', pollAfterMs: 3000, buyer: 'guest' } };
      }
      return call.init?.method === 'POST' ? 'lost' : { body: { status: 'checking' } };
    });
    tap({ request: 'a' });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    host.checkPayment();
    await flush();
    expect(checks).toBe(1);
    expect(lines.at(-1)).toMatchObject({ checking: true, resume: null });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(checks).toBe(2);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(checks).toBe(3);
    expect(lines.at(-1)).toMatchObject({ checking: true, resume: { url: 'https://checkout.examplepay.com/?t=9' } });
    // Always the same wish, and from here the order is only asked about
    const wish = calls[0].body.intentId;
    expect(calls.filter((call) => call.body.check).every((call) => call.body.intentId === wish)).toBe(true);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(calls.some((call) => call.url.includes('order=o-9'))).toBe(true);
    host.destroy();
  });

  it('gives up asking Check payment for an unfinished start after twenty minutes and offers it again', async () => {
    const { tap, host, lines } = setup((call) => (call.body.check ? { body: { status: 'checking', orderId: 'o-10', checkoutUrl: null, pollAfterMs: 30000, buyer: 'guest' } } : 'lost'));
    tap({ request: 'a' });
    await jest.advanceTimersByTimeAsync(10_000);
    host.checkPayment();
    await flush();
    await jest.advanceTimersByTimeAsync(21 * 60_000);
    expect(lines.at(-1)).toMatchObject({ problem: 'cant_confirm', canCheck: true });
    host.destroy();
  });

  it('gives up asking Restore for an unfinished start after twenty minutes and offers Check payment', async () => {
    const { tap, host, lines } = setup((call) => ({ body: call.body.restore ? { status: 'checking', orderId: 'o-8', via: 'own', checkoutUrl: null, pollAfterMs: 30000, buyer: 'guest' } : { status: 'checking' } }));
    tap({ request: 'r1', restore: true });
    await flush();
    await jest.advanceTimersByTimeAsync(21 * 60_000);
    expect(lines.at(-1)).toMatchObject({ problem: 'cant_confirm', canCheck: true });
    host.destroy();
  });

  it('without Web Locks, a tab that is slow to write its first code can never replace the code another tab has bought under: IndexedDB decides', async () => {
    const shared = new Map<string, string>();
    const key = `universe-pay-recovery:${ART}`;
    const idb = fakeIndexedDB();
    // Tab one makes its code and buys under it before tab two even looks: tab two's view of the storage is old (it read it empty) and its write comes last
    let wrote = false;
    const staleView = { get: (name: string) => (wrote ? shared.get(name) : undefined), set: (name: string, value: string) => { wrote = true; shared.set(name, value); } } as unknown as Map<string, string>;
    const one = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, shared, false, 'a', idb);
    one.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(5_000);
    const codeOne = one.calls[0].body.recoveryCode;
    expect(codeOne).toBeDefined();
    const two = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, staleView, false, 'b', idb);
    two.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(two.calls[0].body.recoveryCode).toBe(codeOne);
    expect(shared.get(key)).toBe(codeOne);
    one.host.destroy();
    two.host.destroy();
  });

  it('with nothing that can make tabs take turns, writes no code to the shared storage: a slow tab can never replace the code another tab bought under, and each tab’s receipt link is its own', async () => {
    const shared = new Map<string, string>();
    const key = `universe-pay-recovery:${ART}`;
    let wrote = false;
    const staleView = { get: (name: string) => (wrote ? shared.get(name) : undefined), set: (name: string, value: string) => { wrote = true; shared.set(name, value); } } as unknown as Map<string, string>;
    const answer = (call: Call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: false, buyer: 'guest' } });
    const one = setup(answer, true, shared, false, 'a', null);
    one.tap({ request: 'r1' });
    await jest.advanceTimersByTimeAsync(5_000);
    const two = setup(answer, true, staleView, false, 'b', null);
    two.tap({ request: 'r1' });
    await jest.advanceTimersByTimeAsync(5_000);
    const codeOne = one.calls[0].body.recoveryCode;
    const codeTwo = two.calls[0].body.recoveryCode;
    expect(codeOne).toBeDefined();
    expect(codeTwo).toBeDefined();
    // Each tab bought under its own code, and the storage was never written to: neither can be replaced
    expect(codeOne).not.toBe(codeTwo);
    expect(shared.has(key)).toBe(false);
    expect(one.lines.at(-1)?.receipt).toBe(`${PAGE}#receipt=${codeOne}`);
    expect(two.lines.at(-1)?.receipt).toBe(`${PAGE}#receipt=${codeTwo}`);
    one.host.destroy();
    two.host.destroy();
  });

  it('uses the code a tab kept even with no way to take turns, and a failed IndexedDB claim writes nothing', async () => {
    const key = `universe-pay-recovery:${ART}`;
    const kept = 'k'.repeat(43);
    const shared = new Map<string, string>([[key, kept]]);
    const one = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, shared, false, 'a', null);
    one.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(one.calls[0].body.recoveryCode).toBe(kept);
    one.host.destroy();
    // An IndexedDB that refuses the open: nothing is written either
    const refusing = { open: () => { const request = {} as { onerror?: () => void }; void Promise.resolve().then(() => request.onerror?.()); return request; } } as unknown as Pick<IDBFactory, 'open'>;
    const empty = new Map<string, string>();
    const two = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, empty, false, 'c', refusing);
    two.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(two.calls[0].body.recoveryCode).toBeDefined();
    expect(empty.has(key)).toBe(false);
    two.host.destroy();
  });

  it('when taking the Web Locks turn fails, never falls back to an uncoordinated write: IndexedDB decides, and with none the code stays in the page', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: () => Promise.reject(new Error('refused')) } } });
    const key = `universe-pay-recovery:${ART}`;
    const shared = new Map<string, string>();
    const idb = fakeIndexedDB();
    const one = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, shared, true, 'a', idb);
    one.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    const claimed = one.calls[0].body.recoveryCode;
    expect(shared.get(key)).toBe(claimed);
    one.host.destroy();
    // Another tab, whose own storage view is empty and whose locks also refuse, gets the claimed code from IndexedDB
    const two = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, new Map(), true, 'b', idb);
    two.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(two.calls[0].body.recoveryCode).toBe(claimed);
    two.host.destroy();
    // And with no IndexedDB, nothing is written
    const bare = new Map<string, string>();
    const three = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, bare, true, 'd', null);
    three.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(three.calls[0].body.recoveryCode).toBeDefined();
    expect(bare.has(key)).toBe(false);
    three.host.destroy();
  });

  it('when one tab takes the Web Locks turn and another cannot, both settle on the code IndexedDB holds (the paths agree, whichever writes first)', async () => {
    let refuse = false;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_name: string, run: () => unknown) => (refuse ? Promise.reject(new Error('refused')) : Promise.resolve().then(run)) } } });
    const idb = fakeIndexedDB();
    const answer = () => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } });
    const holder = setup(answer, true, new Map(), true, 'a', idb);
    holder.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    refuse = true;
    // The other tab (its own view of the storage is empty) cannot take the turn
    const other = setup(answer, true, new Map(), true, 'b', idb);
    other.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(holder.calls[0].body.recoveryCode).toBeDefined();
    expect(other.calls[0].body.recoveryCode).toBe(holder.calls[0].body.recoveryCode);
    holder.host.destroy();
    other.host.destroy();
  });

  it('with nothing to coordinate with, the tab’s own code survives a reload of the tab (before any payment is confirmed) and is never shared with another tab', async () => {
    const shared = new Map<string, string>();
    const key = `universe-pay-recovery:${ART}`;
    const tabOne = new Map<string, string>();
    const answer = () => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } });
    const before = setup(answer, true, shared, false, 'a', null, tabOne);
    before.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    const code = before.calls[0].body.recoveryCode;
    before.host.destroy();
    // The same tab reloads: its tab storage is still there, so it asks under the code it bought under
    const reloaded = setup(answer, true, shared, false, 'z', null, tabOne);
    reloaded.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(reloaded.calls[0].body.recoveryCode).toBe(code);
    reloaded.host.destroy();
    // Another tab has its own tab storage and its own code, and the shared storage was never written
    const another = setup(answer, true, shared, false, 'c', null, new Map());
    another.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(another.calls[0].body.recoveryCode).not.toBe(code);
    expect(shared.has(key)).toBe(false);
    another.host.destroy();
  });

  it('a tab that has the Web Locks turn but whose IndexedDB claim failed writes nothing to the shared storage: another tab’s IndexedDB code is the one the storage ends up with', async () => {
    let refuse = false;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_name: string, run: () => unknown) => (refuse ? Promise.reject(new Error('refused')) : Promise.resolve().then(run)) } } });
    const key = `universe-pay-recovery:${ART}`;
    const shared = new Map<string, string>();
    const failing = { open: () => { const request = {} as { onerror?: () => void }; void Promise.resolve().then(() => request.onerror?.()); return request; } } as unknown as Pick<IDBFactory, 'open'>;
    const answer = () => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } });
    // Tab one has the turn, but IndexedDB failed for it
    const one = setup(answer, true, shared, true, 'a', failing, new Map());
    one.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(shared.has(key)).toBe(false);
    // Tab two cannot take the turn, and its IndexedDB works: its code is the one the storage ends up with
    refuse = true;
    const two = setup(answer, true, shared, true, 'b', fakeIndexedDB(), new Map());
    two.tap({ request: 'r1', restore: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(shared.get(key)).toBe(two.calls[0].body.recoveryCode);
    expect(one.calls[0].body.recoveryCode).not.toBe(two.calls[0].body.recoveryCode);
    one.host.destroy();
    two.host.destroy();
  });

  it('asks a guest to save the receipt link right away when nothing in the browser can keep the code, and not when something can', async () => {
    const answer = (call: Call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'checking' } });
    // Storage that refuses, no tab storage, no IndexedDB, no locks
    const lost = setup(answer, false, undefined, false, 'a', null);
    lost.tap({ request: 'r1' });
    await flush();
    expect(lost.lines.at(-1)).toMatchObject({ checking: true, keepReceipt: true });
    expect(lost.lines.at(-1)?.receipt).toBe(`${PAGE}#receipt=${lost.calls[0].body.recoveryCode}`);
    lost.host.destroy();
    // A tab storage that works keeps it across a reload: nothing to save in a hurry
    const kept = setup(answer, false, undefined, false, 'b', null, new Map());
    kept.tap({ request: 'r1' });
    await flush();
    expect(kept.lines.at(-1)).toMatchObject({ checking: true, keepReceipt: false });
    kept.host.destroy();
  });

  it('does not stay busy for ever when another tab holds the recovery code lock: the 30 s deadline covers the wait too', async () => {
    // A lock that is never given: the other tab holds it
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: () => new Promise(() => undefined) } } });
    const { tap, host, lines, calls, store } = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }));
    tap({ request: 'r1', restore: true });
    await flush();
    expect(lines.at(-1)?.checking ?? false).toBe(false);
    expect(calls).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    // The line that ends it offers no receipt, and nothing was written outside the lock
    expect(lines.at(-1)?.receipt).toBeNull();
    expect(store.size).toBe(0);
    // Not blocked: the buyer can ask again (and it is the lock that is still held, not the host)
    host.restorePurchase();
    await flush();
    expect(lines.at(-1)).toMatchObject({ checking: true });
    host.destroy();
  });

  it('offers no receipt of its own for a purchase a receipt link found: it is "back", and this browser’s code would not bring it back', async () => {
    const { tap, host, lines } = setup((call) => (call.body.restore ? { body: { status: 'checking', orderId: 'o-5', via: 'receipt', buyer: 'guest' } } : { body: { status: 'paid', testPayment: false } }));
    tap({ request: 'r1', restore: true });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(lines.at(-1)).toMatchObject({ paid: { test: false }, restored: { paidAt: null } });
    host.destroy();
    // Found with its own proof, the buyer's purchase is a normal one with a receipt
    const own = setup((call) => (call.body.restore ? { body: { status: 'checking', orderId: 'o-6', via: 'own', checkoutUrl: 'https://checkout.examplepay.com/?t=6', buyer: 'guest' } } : { body: { status: 'paid', testPayment: false } }));
    own.tap({ request: 'r1', restore: true });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(own.lines.at(-1)).toMatchObject({ paid: { test: false }, restored: null });
    expect(own.lines.at(-1)?.receipt).toBe(`${PAGE}#receipt=${own.calls[0].body.recoveryCode}`);
    own.host.destroy();
  });

  it('settles one recovery code for two tabs that find the storage empty at the same moment', async () => {
    const shared = new Map<string, string>();
    // Web Locks: one tab at a time, and the storage is read again inside the lock
    let tail: Promise<unknown> = Promise.resolve();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_name: string, run: () => unknown) => (tail = tail.then(() => run())) } } });
    try {
      const one = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, shared);
      const two = setup(() => ({ body: { status: 'none', testPayment: false, buyer: 'guest' } }), true, shared);
      one.tap({ request: 'r1', restore: true });
      two.tap({ request: 'r1', restore: true });
      await flush();
      expect(one.calls[0].body.recoveryCode).toBeDefined();
      expect(one.calls[0].body.recoveryCode).toBe(two.calls[0].body.recoveryCode);
      expect(shared.get(`universe-pay-recovery:${ART}`)).toBe(one.calls[0].body.recoveryCode);
      one.host.destroy();
      two.host.destroy();
    } finally {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});
