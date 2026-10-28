/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/** The Limits section of the Universe AI page (#666): every limit a super admin sets, each saved as soon as it is picked. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const mockAddToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: mockAddToast }) }));

import { UniverseAiLimits } from '@/app/admin/components/limits';
import { SERVER_LIMITS_RECOMMENDED } from '@/lib/bot-limit-values';

function answer(limits = SERVER_LIMITS_RECOMMENDED) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const change = JSON.parse(String(init.body));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            limits: {
              universeAi: { ...limits.universeAi, ...change.universeAi },
              artifacts: { ...limits.artifacts, ...change.artifacts },
              guard: change.guard ?? limits.guard,
              fairUsage: { ...limits.fairUsage, ...change.fairUsage },
            },
          }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ limits }) });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  mockAddToast.mockReset();
});

describe('Universe AI limits', () => {
  it('shows every row with its value, the recommended ones marked', async () => {
    answer();
    render(<UniverseAiLimits />);
    expect(await screen.findByText('Replies on Universe AI')).toBeTruthy();
    for (const label of ['Longest reply', 'Steps in one reply', 'Keep going when cut off', 'Messages it remembers', 'Reads from a page or file', 'Wait for the AI', 'Size of one version', 'Versions kept', 'Time to save', 'Media added in one save', 'Replies for a signed-in person', 'Replies for a guest', 'Replies for all guests on one bot']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText('32,000 tokens').length).toBeGreaterThan(0);
    expect(screen.getAllByText('All of them').length).toBeGreaterThan(0);
    expect(screen.getByRole('switch', { name: /Say when nothing was saved/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('saves a picked value and shows it, with what is recommended next to it', async () => {
    answer();
    render(<UniverseAiLimits />);
    fireEvent.click(await screen.findByTestId('limit-size'));
    fireEvent.click(await screen.findByRole('radio', { name: /10 MB/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getAllByText('Recommended: 2 MB').length).toBeGreaterThan(0));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch?.[0]).toBe('/api/admin/bot-limits');
    expect(JSON.parse(patch?.[1].body)).toEqual({ artifacts: { size: 10 } });
  });

  it('types a value of its own in a field that sits beside the Other choice, not inside its button', async () => {
    answer();
    render(<UniverseAiLimits />);
    fireEvent.click(await screen.findByTestId('limit-size'));
    fireEvent.click(await screen.findByRole('radio', { name: /Other/ }));
    const field = await screen.findByLabelText(/Size of one version, in/);
    expect(field.closest('button')).toBeNull();
    fireEvent.change(field, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({ artifacts: { size: 7 } }));
  });

  it('turns media in artifacts off with None (#1510)', async () => {
    answer();
    render(<UniverseAiLimits />);
    fireEvent.click(await screen.findByTestId('limit-media'));
    fireEvent.click(await screen.findByRole('radio', { name: /None/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({ artifacts: { media: 0 } }));
  });

  it('saves the switch', async () => {
    answer();
    render(<UniverseAiLimits />);
    fireEvent.click(await screen.findByRole('switch', { name: /Say when nothing was saved/ }));
    await waitFor(() => expect(screen.getByRole('switch', { name: /Say when nothing was saved/ }).getAttribute('aria-checked')).toBe('false'));
    expect(JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1].body)).toEqual({ guard: false });
  });

  it('says it could not load, with a way to try again', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<UniverseAiLimits />);
    expect(await screen.findByText(/We couldn’t load the limits/)).toBeTruthy();
    answer();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Replies on Universe AI')).toBeTruthy();
  });
});
