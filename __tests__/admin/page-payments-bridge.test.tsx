/** @jest-environment jsdom */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { PagePaymentsBridge } from '@/components/page-payments-bridge';

/** The 20 minute watch on a payment ends on time even when a look at the order never answers. */

const fetchMock = jest.fn();
const signals: AbortSignal[] = [];
const MIN = 60_000;

beforeEach(() => {
  jest.useFakeTimers();
  signals.length = 0;
  fetchMock.mockReset();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  window.open = jest.fn(() => null);
});
afterEach(() => jest.useRealTimers());

it('ends the watch at twenty minutes and says so, though a look at the order is still waiting for an answer', async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ orderId: 'o1', checkoutUrl: 'https://pay.example/c', app: 'Pay' }) });
    // A look that never answers, and only ends when it is aborted
    const signal = init!.signal as AbortSignal;
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  render(
    <div>
      <iframe data-artifact-frame="" title="page" />
      <PagePaymentsBridge artifactId="a1" />
    </div>,
  );
  const frame = document.querySelector('iframe')!;
  const told = jest.spyOn(frame.contentWindow!, 'postMessage');
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { universe: 'use-app', app: 'pay' }, source: frame.contentWindow }));
  });
  // A look starts and hangs
  await act(async () => {
    await jest.advanceTimersByTimeAsync(3_000);
  });
  expect(signals.length).toBe(1);
  // Looks that hang are ended and asked again, but nothing outlives the watch
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20 * MIN + 1_000 - 3_000);
  });
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(told).toHaveBeenCalledWith({ universe: 'app-result', status: 'cant_confirm' }, '*');
  expect(screen.getByText('We could not confirm the payment')).toBeTruthy();
  // And nothing is asked after it ended
  const looks = signals.length;
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5 * MIN);
  });
  expect(signals.length).toBe(looks);
});

it('a look that fails just before the end of the watch is not asked again after it: no request goes out past the end, and the watch ends on time', async () => {
  const lookTimes: number[] = [];
  const startedAt = Date.now();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ orderId: 'o2', checkoutUrl: 'https://pay.example/c', app: 'Pay' }) });
    lookTimes.push(Date.now() - startedAt);
    // Each look fails 0.7 s after it starts, so the one before the end fails 1.2 s ahead of it and the next would be due 1.8 s after it
    return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('network')), 700));
  });
  render(
    <div>
      <iframe data-artifact-frame="" title="page" />
      <PagePaymentsBridge artifactId="a1" />
    </div>,
  );
  const frame = document.querySelector('iframe')!;
  const told = jest.spyOn(frame.contentWindow!, 'postMessage');
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { universe: 'use-app', app: 'pay' }, source: frame.contentWindow }));
  });
  // Up to a moment before the end of the watch: still being asked
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20 * MIN - 500);
  });
  expect(told).not.toHaveBeenCalledWith({ universe: 'app-result', status: 'cant_confirm' }, '*');
  // At the end: said, on time
  await act(async () => {
    await jest.advanceTimersByTimeAsync(600);
  });
  expect(told).toHaveBeenCalledWith({ universe: 'app-result', status: 'cant_confirm' }, '*');
  const looks = lookTimes.length;
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10_000);
  });
  expect(lookTimes.length).toBe(looks);
  expect(Math.max(...lookTimes)).toBeLessThanOrEqual(20 * MIN);
});
