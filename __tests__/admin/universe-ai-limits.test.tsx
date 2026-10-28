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
              files: { ...limits.files, ...change.files },
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
    for (const label of ['Longest reply', 'Steps in one reply', 'Keep going when cut off', 'Messages it remembers', 'Reads from a page or file', 'Room to work in one reply', 'Newest files it sees', 'Files found in one search', 'Reads from an earlier file', 'Wait for the AI', 'Text kept from a file', 'Files bots can find again', 'Guests’ files', 'Size of one version', 'Versions kept', 'Time to save', 'Replies for a signed-in person', 'Replies for a guest', 'Replies for all guests on one bot']) {
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

  it('says on the sheet what Other can be, and turns down a number outside it (#1508)', async () => {
    answer();
    render(<UniverseAiLimits />);
    fireEvent.click(await screen.findByTestId('limit-results'));
    fireEvent.click(await screen.findByRole('radio', { name: /Other/ }));
    expect((await screen.findByTestId('limit-results-range')).textContent).toBe('Between 1 and 100 files.');
    fireEvent.change(screen.getByLabelText(/Files found in one search, in/), { target: { value: '500' } });
    expect(screen.getByRole('alert').textContent).toBe('Between 1 and 100 files.');
    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Files found in one search, in/), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({ universeAi: { results: 30 } }));
  });

  it('turns down "Reads from an earlier file" above "Reads from a page or file" with the line that says why, never cutting it', async () => {
    answer({ ...SERVER_LIMITS_RECOMMENDED, universeAi: { ...SERVER_LIMITS_RECOMMENDED.universeAi, read: 10000 } });
    render(<UniverseAiLimits />);
    fireEvent.click(await screen.findByTestId('limit-part'));
    fireEvent.click(await screen.findByRole('radio', { name: /20,000 characters/ }));
    expect((await screen.findByTestId('limit-part-above')).textContent).toBe("Reads from an earlier file can't be more than Reads from a page or file (10,000 characters).");
    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('saves what bots keep of the files in their chats, a guest\'s days included', async () => {
    answer();
    render(<UniverseAiLimits />);
    fireEvent.click(await screen.findByTestId('limit-guestDays'));
    fireEvent.click(await screen.findByRole('radio', { name: /7 days/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({ files: { guestDays: 7 } }));
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
