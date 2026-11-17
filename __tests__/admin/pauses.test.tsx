/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** Pause now (Universe AI page): the screen shows the answer of the newest thing it asked, never an older one that arrived late. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));

import { CapabilityPauses } from '@/app/admin/components/pauses';

const rows = (computersPaused: boolean) => ({
  capabilities: [
    { key: 'instant', name: 'Instant Apps', paused: false, reason: null, words: null, at: null },
    { key: 'apps', name: 'Apps', paused: false, reason: null, words: null, at: null },
    { key: 'computers', name: 'Computers', paused: computersPaused, reason: computersPaused ? 'manual' : null, words: computersPaused ? 'Paused by the team' : null, at: null, jobsLeft: 0, machinesLeft: 0 },
  ],
});
const reply = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
const later = () => {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

describe('the pause screen', () => {
  beforeEach(() => fetchMock.mockReset());

  it('shows the first read when nothing newer was asked', async () => {
    fetchMock.mockResolvedValue(reply(rows(true)));
    render(<CapabilityPauses />);
    await waitFor(() => expect(screen.getByTestId('pause-computers').getAttribute('data-paused')).toBe('yes'));
  });

  it('does not let the read after “End them now” put back what a Resume pressed meanwhile changed', async () => {
    // Computers are paused with one job left. “End them now” asks the server, then reads again; that read is slow and will say "paused"
    const slowRead = later();
    let reads = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/admin/computer/wind-down') return Promise.resolve(reply({}));
      if (init?.method === 'POST') return Promise.resolve(reply(rows(false)));
      reads++;
      if (reads === 1) return Promise.resolve(reply({ capabilities: rows(true).capabilities.map((row) => (row.key === 'computers' ? { ...row, jobsLeft: 1 } : row)) }));
      return slowRead.promise;
    });
    render(<CapabilityPauses />);
    await waitFor(() => expect(screen.getByTestId('pause-end-running')).toBeTruthy());
    fireEvent.click(screen.getByText('End them now'));
    const sheetButton = within(await screen.findByRole('dialog')).getByRole('button', { name: 'End them now' });
    await act(async () => {
      fireEvent.click(sheetButton);
    });
    await waitFor(() => expect(reads).toBe(2));
    // The controls are back while that read is still out: the person resumes computers
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Resume Computers'));
    });
    await waitFor(() => expect(screen.getByTestId('pause-computers').getAttribute('data-paused')).toBe('no'));
    // The old read arrives last, saying paused: it is not shown
    await act(async () => {
      slowRead.resolve(reply(rows(true)));
    });
    expect(screen.getByTestId('pause-computers').getAttribute('data-paused')).toBe('no');
  });

  it('reads again when a Resume fails after “End them now”, so the screen is not left with the ended job and its button', async () => {
    const slowRead = later();
    let reads = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/admin/computer/wind-down') return Promise.resolve(reply({}));
      // The Resume never reaches the server
      if (init?.method === 'POST') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'That didn’t work. Try again.' }) });
      reads++;
      if (reads === 1) return Promise.resolve(reply({ capabilities: rows(true).capabilities.map((row) => (row.key === 'computers' ? { ...row, jobsLeft: 1 } : row)) }));
      // The read after “End them now” is slow and is dropped when the Resume is sent; the read after the failed Resume says the job is over
      if (reads === 2) return slowRead.promise;
      return Promise.resolve(reply(rows(true)));
    });
    render(<CapabilityPauses />);
    await waitFor(() => expect(screen.getByTestId('pause-end-running')).toBeTruthy());
    fireEvent.click(screen.getByText('End them now'));
    const sheetButton = within(await screen.findByRole('dialog')).getByRole('button', { name: 'End them now' });
    await act(async () => {
      fireEvent.click(sheetButton);
    });
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Resume Computers'));
    });
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(screen.queryByTestId('pause-end-running')).toBeNull());
    // The dropped read arrives last and changes nothing
    await act(async () => {
      slowRead.resolve(reply({ capabilities: rows(true).capabilities.map((row) => (row.key === 'computers' ? { ...row, jobsLeft: 1 } : row)) }));
    });
    expect(screen.queryByTestId('pause-end-running')).toBeNull();
  });
});
