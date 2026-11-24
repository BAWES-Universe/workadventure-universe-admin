/** @jest-environment jsdom */

// The day a purchase was made is shown in the buyer's own time zone: these tests fix the zone so "19 Nov" is the same on every machine
process.env.TZ = 'UTC';

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PagePaymentsBridge } from '@/components/page-payments-bridge';

const CODE = 'Q'.repeat(43);

/** The shared page: a frame the bridge talks to, and a fetch that answers like Orbit. */
function mount(hash: string, answer: Record<string, unknown> | ((method: string) => Record<string, unknown>)) {
  window.history.replaceState(null, '', `/a/k7Qm2xR9${hash}`);
  window.localStorage.clear();
  // A browser with Web Locks (one tab at a time): the first recovery code is made at once, as it is in every current browser
  let tail: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, run: () => unknown) => (tail = tail.then(() => run())) } });
  const frameWindow = { postMessage: jest.fn() };
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-artifact-frame', '');
  document.body.appendChild(iframe);
  Object.defineProperty(iframe, 'contentWindow', { value: frameWindow });
  const bodies: Array<Record<string, unknown>> = [];
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(init.body as string) : {});
    const body = typeof answer === 'function' ? answer(init?.method ?? 'GET') : answer;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  render(<PagePaymentsBridge artifactId="art-1" />);
  const ask = async (data: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { universe: 'use-app', app: 'shop', session: 's1', ...data }, source: frameWindow as unknown as Window }));
    });
  };
  return { ask, bodies, frameWindow, iframe };
}

afterEach(() => {
  jest.useRealTimers();
  delete (navigator as unknown as { locks?: unknown }).locks;
  document.body.innerHTML = '';
});

describe('the payment line on the shared page', () => {
  it('adopts a receipt link’s code, takes it out of the address, and brings the purchase back with the date', async () => {
    const { ask, bodies } = mount(`#receipt=${CODE}`, { status: 'paid', testPayment: false, buyer: 'guest', paidAt: '2026-11-19T10:00:00.000Z' });
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/a/k7Qm2xR9');
    await ask({ request: 'r1', restore: true });
    // Asked under the link's code, and the browser's own code is a different one
    expect(bodies[0].receiptCode).toBe(CODE);
    expect(bodies[0].recoveryCode).not.toBe(CODE);
    expect(screen.getByRole('status').textContent).toContain('Your purchase from 19 Nov is back.');
    // Found again, so no receipt to save and nothing to press
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('R5: an earlier payment that is still being checked says that a new Buy starts a new payment, beside Check payment', async () => {
    const { ask } = mount('', { status: 'cant_confirm', testPayment: false, buyer: 'guest' });
    await ask({ request: 'r1' });
    expect(screen.getByRole('status').textContent).toContain('We haven’t heard back about your payment yet.');
    expect(screen.getByTestId('pagePaymentsNote').textContent).toBe('This starts a new payment. Your earlier one is still being checked.');
    expect(screen.getByRole('button', { name: 'Check payment' })).toBeTruthy();
  });

  it('offers Restore purchase quietly when nothing is found, which can be closed, and points to the receipt link when tapped', async () => {
    const { ask } = mount('', { status: 'none', testPayment: false, buyer: 'guest' });
    await ask({ request: 'r1', restore: true });
    expect(screen.getByRole('status').textContent).toContain('Bought this before?');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Restore purchase' })));
    expect(screen.getByRole('status').textContent).toContain('No purchase found in this browser.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close' })));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('gives a guest who just paid a receipt link to copy, with the code in its fragment', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => void written.push(value) }, configurable: true });
    jest.useFakeTimers();
    const { ask } = mount('', (method) => (method === 'POST' ? { orderId: 'o-1', checkoutUrl: 'https://checkout.examplepay.com/?t=1', app: 'ExamplePay', buyer: 'guest' } : { status: 'paid', testPayment: false }));
    window.open = jest.fn(() => null);
    await ask({ request: 'r1' });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByRole('status').textContent).toContain('Paid. Thank you.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy private receipt link' })));
    expect(written[0]).toMatch(/^http:\/\/localhost(:\d+)?\/a\/k7Qm2xR9#receipt=[A-Za-z0-9_-]{32,128}$/);
    expect(screen.getByRole('status').textContent).toContain('Private receipt link copied.');
  });
  it('shows a selectable receipt link and says so when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
    jest.useFakeTimers();
    const { ask } = mount('', (method) => (method === 'POST' ? { orderId: 'o-1', checkoutUrl: 'https://checkout.examplepay.com/?t=1', app: 'ExamplePay', buyer: 'guest' } : { status: 'paid', testPayment: false }));
    window.open = jest.fn(() => null);
    await ask({ request: 'r1' });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy private receipt link' })));
    expect(screen.getByRole('status').textContent).toContain('Couldn’t copy it.');
    expect((screen.getByLabelText('Private receipt link') as HTMLInputElement).value).toMatch(/#receipt=[A-Za-z0-9_-]{32,128}$/);
    // Still not "copied": the button can be pressed again
    expect(screen.getByRole('button', { name: 'Copy private receipt link' })).toBeTruthy();
  });

  it('shows no copy fallback for a purchase a receipt link brought back, even after an earlier copy failed', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
    jest.useFakeTimers();
    let restoring = false;
    const { ask } = mount('', (method) =>
      method !== 'POST' ? { status: 'paid', testPayment: false } : restoring ? { status: 'paid', via: 'receipt', paidAt: '2026-11-01T10:00:00Z', testPayment: false, buyer: 'guest' } : { orderId: 'o-1', checkoutUrl: 'https://checkout.examplepay.com/?t=1', app: 'ExamplePay', buyer: 'guest' },
    );
    window.open = jest.fn(() => null);
    await ask({ request: 'r1' });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy private receipt link' })));
    expect(screen.getByLabelText('Private receipt link')).toBeTruthy();
    // A later purchase, brought back by someone's receipt link: no link of this browser's own is offered for it
    restoring = true;
    await ask({ request: 'r2', restore: true });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByRole('status').textContent).toContain('is back.');
    expect(screen.queryByLabelText('Private receipt link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy private receipt link' })).toBeNull();
  });
});
