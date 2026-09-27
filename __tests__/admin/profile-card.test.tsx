/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileCard, profileLinkError } from '@/app/admin/components/profile-card';

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });
const me = { name: 'Khalid Alsayed', email: 'khalid@bawes.net', isSuperAdmin: true };

beforeEach(() => {
  fetchMock.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('Your profile on You', () => {
  it('invites someone with an empty profile to set it up, and says who sees it', async () => {
    fetchMock.mockImplementation(() => json({ bio: null, links: [] }));
    render(<ProfileCard user={me} />);
    expect(await screen.findByTestId('profile-empty')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Khalid Alsayed');
    expect(screen.getByText('only you see this')).toBeTruthy();
    expect(screen.getByText(/what people see when they click you in the game/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /set up your profile/i }));
    expect(screen.getByRole('button', { name: /save profile/i })).toBeTruthy();
  });

  it('shows the profile as others see it, and saves edits in place', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? json({}) : json({ bio: 'Builds universes.', links: [{ label: 'Site', url: 'https://bawes.net' }] }),
    );
    render(<ProfileCard user={me} />);
    expect(await screen.findByText('Builds universes.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Site/ }).getAttribute('href')).toBe('https://bawes.net');

    fireEvent.click(screen.getByRole('button', { name: /edit profile/i }));
    fireEvent.change(screen.getByPlaceholderText(/what you do/i), { target: { value: 'Builds worlds.' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

    expect(await screen.findByText('Builds worlds.')).toBeTruthy();
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put[1].body)).toEqual({ bio: 'Builds worlds.', links: [{ label: 'Site', url: 'https://bawes.net' }] });
    expect(screen.getByText(/Saved\. This is what people see now\./)).toBeTruthy();
  });

  it('opens ready to edit when asked, and catches a bad link before saving', async () => {
    fetchMock.mockImplementation(() => json({ bio: null, links: [] }));
    render(<ProfileCard user={me} startEditing />);
    fireEvent.click(await screen.findByRole('button', { name: /add a link/i }));
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Me' } });
    fireEvent.change(screen.getByLabelText('Link 1 address'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t a web address/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('says so when the profile cannot load, and retries', async () => {
    fetchMock.mockImplementationOnce(() => json({}, false)).mockImplementation(() => json({ bio: 'Hi', links: [] }));
    render(<ProfileCard user={me} />);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText('Hi')).toBeTruthy());
  });

  it('accepts only labelled web links', () => {
    expect(profileLinkError({ label: 'Site', url: 'https://bawes.net' })).toBeNull();
    expect(profileLinkError({ label: '', url: 'https://bawes.net' })).toMatch(/label/);
    expect(profileLinkError({ label: 'x', url: 'ftp://bawes.net' })).toMatch(/web address/);
  });
});
