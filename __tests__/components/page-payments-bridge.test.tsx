/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PagePaymentsBridge } from '@/components/page-payments-bridge';

const CODE = 'Q'.repeat(43);

/** The shared page: a frame the bridge talks to, and a fetch that answers like Orbit. */
function mount(hash: string, answer: Record<string, unknown> | ((method: string) => Record<string, unknown>)) {
  window.history.replaceState(null, '', `/a/k7Qm2xR9${hash}`);
  window.localStorage.clear();
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
      window.dispatchEvent(new MessageEvent('message', { data: { universe: 'use-app', app: 'shop', ...data }, source: frameWindow as unknown as Window }));
    });
  };
  return { ask, bodies, frameWindow, iframe };
}

afterEach(() => {
  jest.useRealTimers();
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
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy receipt link' })));
    expect(written[0]).toMatch(/^http:\/\/localhost(:\d+)?\/a\/k7Qm2xR9#receipt=[A-Za-z0-9_-]{32,128}$/);
    expect(screen.getByRole('status').textContent).toContain('Receipt link copied.');
  });
});
