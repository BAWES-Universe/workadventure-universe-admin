/**
 * The host side of a paying page on the public share link (game #2044): it must speak what the game's window speaks, so the same published
 * page is told the same things in both. These run without a browser: the frame, the fetch and the clock are stand-ins.
 */
import { createPagePaymentsHost, safeCheckout, type PayLine } from '@/lib/page-payments-host';

const ORIGIN = 'https://orbit.example.org';
const ART = 'art-1';

type Call = { url: string; init: RequestInit | undefined; body: Record<string, unknown> };

function setup(answers: (call: Call) => { status?: number; body: Record<string, unknown> } | 'lost', withStorage = true) {
  jest.useFakeTimers();
  const frame = { postMessage: jest.fn() } as unknown as Window;
  const calls: Call[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, init, body: init?.body ? JSON.parse(init.body as string) : {} };
    calls.push(call);
    const answer = answers(call);
    if (answer === 'lost') throw new Error('network');
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body } as Response;
  });
  const store = new Map<string, string>();
  const popup = { opener: 'x', closed: false, close: jest.fn(), location: { href: '' } } as unknown as Window;
  let n = 0;
  const host = createPagePaymentsHost({
    artifactId: ART,
    frame: () => frame,
    openWindow: () => popup,
    fetch: fetchMock as unknown as typeof fetch,
    storage: withStorage ? { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) } : null,
    randomId: (length) => `${'r'.repeat(length - String(++n).length)}${n}`,
    origin: ORIGIN,
  });
  const lines: PayLine[] = [];
  host.subscribe((line) => lines.push(line));
  const told = () => (frame.postMessage as jest.Mock).mock.calls.map((call) => call[0]);
  const tap = (data: Record<string, unknown>, source: unknown = frame) => host.onMessage({ source, data: { universe: 'use-app', app: 'shop', ...data } });
  return { host, frame, calls, lines, told, tap, popup, store, fetchMock };
}

const started = { orderId: 'o-1', checkoutUrl: 'https://checkout.examplepay.com/?t=1', app: 'ExamplePay', buyer: 'guest' };
const flush = () => jest.advanceTimersByTimeAsync(0);

afterEach(() => {
  jest.useRealTimers();
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
    expect(told()).toEqual([{ universe: 'app-result', status: 'started', request: 'req_1' }]);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(told()).toEqual([
      { universe: 'app-result', status: 'started', request: 'req_1' },
      { universe: 'app-result', status: 'paid', request: 'req_1' },
    ]);
    host.destroy();
  });

  it('tells a test payment as a test: `test: true` goes with `paid`, and a live one carries no such flag', async () => {
    const test = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: true } }));
    test.tap({ request: 'req_1' });
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(test.told().at(-1)).toEqual({ universe: 'app-result', status: 'paid', request: 'req_1', test: true });
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
      { universe: 'app-result', status: 'busy', request: 'b' },
      { universe: 'app-result', status: 'started', request: 'a' },
    ]);
    host.destroy();
  });

  it('gives the same request id from a new opening a truthful busy, never silence, and tells the old result to nobody', async () => {
    const { tap, told, host } = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: false } }));
    tap({ request: 'a' });
    await flush();
    // The page was open and the buyer was paying for a while before it reloaded
    await jest.advanceTimersByTimeAsync(2_500);
    host.frameLoaded();
    tap({ request: 'a' });
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'busy', request: 'a' });
    // The checkout of the earlier opening ends: its page is gone, so no status is sent to the one that is there
    const before = told().length;
    await jest.advanceTimersByTimeAsync(3_000);
    expect(told()).toHaveLength(before);
    host.destroy();
  });

  it('tells a page that asked while it was still loading, before its frame’s load event: its first request is its own', async () => {
    const { tap, told, host } = setup((call) => ({ body: call.body.restore ? { status: 'paid', testPayment: false, orderId: 'o-1' } : started }));
    // A page's scripts run, and may ask to restore, before the frame says it has loaded
    tap({ request: 'r1', restore: true });
    host.frameLoaded();
    await flush();
    expect(told()).toEqual([{ universe: 'app-result', status: 'paid', request: 'r1' }]);
    host.destroy();
  });

  it('tells a checkout started while the page was loading, and never one that was started long before a reload', async () => {
    const early = setup((call) => (call.init?.method === 'POST' ? { body: started } : { body: { status: 'paid', testPayment: false } }));
    early.tap({ request: 'a' });
    early.host.frameLoaded();
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(early.told()).toEqual([
      { universe: 'app-result', status: 'started', request: 'a' },
      { universe: 'app-result', status: 'paid', request: 'a' },
    ]);
    early.host.destroy();
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
    expect(told()).toEqual([{ universe: 'app-result', status: 'started', request: 'a' }]);
    host.destroy();
  });

  it('after every try is lost, says unavailable once and offers Check payment for the same wish', async () => {
    const { tap, calls, told, lines, host } = setup((call) => (call.body.check ? { body: { status: 'paid', testPayment: false, orderId: 'o-1' } } : 'lost'));
    tap({ request: 'a' });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(told()).toEqual([{ universe: 'app-result', status: 'unavailable', request: 'a' }]);
    expect(lines.at(-1)).toMatchObject({ problem: 'unavailable', canCheck: true });
    const wish = calls[0].body.intentId;
    expect(calls.every((call) => call.body.intentId === wish)).toBe(true);
    host.checkPayment();
    await flush();
    expect(calls.at(-1)?.body).toMatchObject({ check: true, intentId: wish });
    // Found: the page that asked, in the opening it asked in, hears it under its own request
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'paid', request: 'a' });
    host.destroy();
  });

  it('does not tell a payment found later to a page of another opening', async () => {
    const { tap, told, host, lines } = setup((call) => (call.body.check ? { body: { status: 'paid', testPayment: false } } : 'lost'));
    tap({ request: 'a' });
    await jest.advanceTimersByTimeAsync(10_000);
    host.frameLoaded();
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
    expect(told()).toEqual([{ universe: 'app-result', status: 'paid', request: 'r1', test: true }]);
    host.destroy();
  });

  it('tells a page "none" when a restore finds nothing, and watches an order of theirs that is still open', async () => {
    const none = setup(() => ({ body: { status: 'none', testPayment: false, orderId: null } }));
    none.tap({ request: 'r1', restore: true });
    await flush();
    expect(none.told()).toEqual([{ universe: 'app-result', status: 'none', request: 'r1' }]);
    none.host.destroy();
    const open = setup((call) => (call.body.restore ? { body: { status: 'checking', orderId: 'o-2' } } : { body: { status: 'paid', testPayment: false } }));
    open.tap({ request: 'r2', restore: true });
    await flush();
    expect(open.told()).toEqual([]);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(open.told()).toEqual([{ universe: 'app-result', status: 'paid', request: 'r2' }]);
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
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'cant_confirm', request: 'a' });
    expect(lines.at(-1)).toMatchObject({ problem: 'cant_confirm', canCheck: true, checking: false });
    host.destroy();
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
    expect(lines.at(-1)?.receipt).toBe(`${ORIGIN}/pay/receipt/${ART}#${code}`);
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
    expect(lines.at(-1)?.receipt).toBe(`${ORIGIN}/pay/receipt/${ART}#${calls[0].body.recoveryCode}`);
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
      origin: ORIGIN,
    });
    host.onMessage({ source: frame, data: { universe: 'use-app', app: 'shop', request: 'r1', restore: true } });
    await flush();
    host.onMessage({ source: frame, data: { universe: 'use-app', app: 'shop', request: 'r2', restore: true } });
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
    expect(limit.told()).toEqual([{ universe: 'app-result', status: 'limit', request: 'a' }]);
    limit.host.destroy();
    const bad = setup(() => ({ body: { ...started, checkoutUrl: 'http://checkout.examplepay.com/x' } }));
    bad.tap({ request: 'a' });
    await flush();
    expect(bad.told()).toEqual([{ universe: 'app-result', status: 'unavailable', request: 'a' }]);
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
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'not_paid', request: 'a' });
    expect(lines.at(-1)).toMatchObject({ problem: 'not_paid', canCheck: true });
    host.checkPayment();
    await flush();
    expect(told().at(-1)).toEqual({ universe: 'app-result', status: 'paid', request: 'a' });
    // Never a status without a request id
    expect(told().every((message) => typeof message.request === 'string' && message.request.length > 0)).toBe(true);
    host.destroy();
  });
});
