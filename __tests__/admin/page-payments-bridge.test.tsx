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

it('never starts a look at the order once the watch\'s time is up, even when the looks before it answered at once', async () => {
  const starts: number[] = [];
  let began = 0;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ orderId: 'o1', checkoutUrl: 'https://pay.example/c', app: 'Pay' }) });
    starts.push(Date.now());
    // Every look answers at once: the next one is only the poll timer's
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'pending' }) });
  });
  render(
    <div>
      <iframe data-artifact-frame="" title="page" />
      <PagePaymentsBridge artifactId="a1" />
    </div>,
  );
  const frame = document.querySelector('iframe')!;
  began = Date.now();
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { universe: 'use-app', app: 'pay' }, source: frame.contentWindow }));
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20 * MIN + 10_000);
  });
  expect(starts.length).toBeGreaterThan(10);
  // The last look began before the end of the twenty minutes, never at it or after it
  expect(starts.filter((at) => at - began >= 20 * MIN)).toEqual([]);
  expect(screen.getByText('We could not confirm the payment')).toBeTruthy();
});

it('ends the watch at the moment its twenty minutes are up, not at the next poll after it, when the last look answers just before the end', async () => {
  let began = 0;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ orderId: 'o1', checkoutUrl: 'https://pay.example/c', app: 'Pay' }) });
    const left = began + 20 * MIN - Date.now();
    const answer = { ok: true, json: () => Promise.resolve({ status: 'pending' }) };
    if (left > 4_000) return Promise.resolve(answer);
    // The last look before the end answers half a second before it, and the next poll would only come three seconds after that
    return new Promise((resolve) => setTimeout(() => resolve(answer), left - 500));
  });
  render(
    <div>
      <iframe data-artifact-frame="" title="page" />
      <PagePaymentsBridge artifactId="a1" />
    </div>,
  );
  const frame = document.querySelector('iframe')!;
  const told = jest.spyOn(frame.contentWindow!, 'postMessage');
  began = Date.now();
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { universe: 'use-app', app: 'pay' }, source: frame.contentWindow }));
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20 * MIN + 100);
  });
  expect(screen.getByText('We could not confirm the payment')).toBeTruthy();
  expect(told).toHaveBeenCalledWith({ universe: 'app-result', status: 'cant_confirm' }, '*');
});
