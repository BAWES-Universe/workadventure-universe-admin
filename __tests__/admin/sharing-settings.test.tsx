/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SharingSettings } from '@/app/admin/components/live/sharing-settings';

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ preferences: {} }) });
});

async function ready() {
  render(<SharingSettings />);
  await waitFor(() => expect((screen.getByTestId('share-room') as HTMLButtonElement).disabled).toBe(false));
}

describe('Sharing dropdowns', () => {
  it('opens a list with the chosen row marked and a check', async () => {
    await ready();
    fireEvent.click(screen.getByTestId('share-room'));
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Everyone', 'Friends', 'No one']);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[0].querySelector('svg')).toBeTruthy();
    expect(options[1].querySelector('svg')).toBeNull();
  });

  it('closes when you press anywhere else', async () => {
    await ready();
    fireEvent.click(screen.getByTestId('share-room'));
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    fireEvent.pointerDown(document.body);
    expect(screen.queryAllByRole('listbox')).toHaveLength(0);
  });

  it('closes on Escape', async () => {
    await ready();
    fireEvent.click(screen.getByTestId('share-passport'));
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryAllByRole('listbox')).toHaveLength(0);
  });

  it('keeps only one open: opening the other closes the first', async () => {
    await ready();
    fireEvent.click(screen.getByTestId('share-passport'));
    fireEvent.pointerDown(screen.getByTestId('share-room'));
    fireEvent.click(screen.getByTestId('share-room'));
    const lists = screen.getAllByRole('listbox');
    expect(lists).toHaveLength(1);
    expect(lists[0].getAttribute('aria-label')).toBe('Share which room I’m in with');
  });

  it('picking an answer closes the list and saves it', async () => {
    await ready();
    fireEvent.click(screen.getByTestId('share-room'));
    fireEvent.click(screen.getByRole('option', { name: 'Friends' }));
    expect(screen.queryAllByRole('listbox')).toHaveLength(0);
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => path === '/api/me/preferences' && init?.method === 'PUT' && String(init.body).includes('friends'))).toBe(true));
    expect(screen.getByTestId('share-room').textContent).toContain('Friends');
  });

  it('keys: arrows move, Enter picks, Tab leaves', async () => {
    await ready();
    fireEvent.click(screen.getByTestId('share-room'));
    const options = screen.getAllByRole('option');
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1], { key: 'Tab' });
    expect(screen.queryAllByRole('listbox')).toHaveLength(0);
  });
});
