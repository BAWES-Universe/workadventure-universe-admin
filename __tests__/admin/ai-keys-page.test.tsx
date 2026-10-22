/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** The AI keys page (#374): your keys, what each spent this month, and Revoke with its confirm. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));

import AiKeysPage from '@/app/admin/you/ai-keys/page';

const lmStudio = {
  id: 'key-1',
  name: 'My LM Studio',
  kind: 'lmstudio',
  kindLabel: 'LM Studio',
  model: 'qwen3-8b',
  address: 'lm.example.com',
  last4: null,
  month: { replies: 2310, tokens: 880_000 },
  createdAt: '2026-10-19T00:00:00.000Z',
};
const deepseek = {
  id: 'key-2',
  name: 'My DeepSeek',
  kind: 'deepseek',
  kindLabel: 'DeepSeek',
  model: 'deepseek-v4-flash',
  address: null,
  last4: '4f2a',
  month: { replies: 1, tokens: 1_240_000 },
  createdAt: '2026-10-19T00:00:00.000Z',
};

function answer(keys: unknown[]) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(init?.method === 'DELETE' ? { status: 'revoked' } : { keys }) }),
  );
}

beforeEach(() => fetchMock.mockReset());

describe('AI keys page', () => {
  it('says what each key is and what it spent this month, never the key', async () => {
    answer([lmStudio, deepseek]);
    render(<AiKeysPage />);
    expect(await screen.findByText('LM Studio · qwen3-8b · lm.example.com')).toBeTruthy();
    expect(screen.getByText('DeepSeek · deepseek-v4-flash · ends in 4f2a')).toBeTruthy();
    expect(screen.getByText('2,310 replies · 880k tokens')).toBeTruthy();
    expect(screen.getByText('1 reply · 1.2M tokens')).toBeTruthy();
  });

  it('says so, plainly, when there are no keys', async () => {
    answer([]);
    render(<AiKeysPage />);
    expect(await screen.findByTestId('ai-keys-empty')).toBeTruthy();
    expect(screen.queryByText('Danger zone')).toBeNull();
  });

  it('says it could not load, with a way to try again, instead of showing an empty list', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<AiKeysPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('ai-keys-empty')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('revokes only after the confirm, then the key is gone from the list', async () => {
    answer([lmStudio, deepseek]);
    render(<AiKeysPage />);
    await screen.findByText('My DeepSeek', { selector: 'h2' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('key-2'), expect.anything());
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/ai-keys/key-2', { method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByText('My DeepSeek', { selector: 'h2' })).toBeNull());
    expect(screen.getByText('My LM Studio', { selector: 'h2' })).toBeTruthy();
  });

  it('keeps the key and says so when revoking fails', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys: [lmStudio] }) }),
    );
    render(<AiKeysPage />);
    await screen.findByText('My LM Studio', { selector: 'h2' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('That didn’t work. Try again.')).toBeTruthy();
    expect(screen.getByText('My LM Studio', { selector: 'h2' })).toBeTruthy();
  });
});
