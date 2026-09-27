/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileCard, profileLinkError } from '@/app/admin/components/profile-card';

const fetchMock = jest.fn();
const announceProfileName = jest.fn((name: string) => Boolean(name));
jest.mock('@/app/admin/components/orbit-bridge', () => ({
  announceProfileName: (name: string) => announceProfileName(name),
  gameMaxNameLength: () => 10,
}));
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });
const me = { name: 'Khalid Alsayed' };

beforeEach(() => {
  fetchMock.mockReset();
  announceProfileName.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('Your profile on You', () => {
  it('invites someone with an empty profile to set it up, and says who sees it', async () => {
    fetchMock.mockImplementation(() => json({ bio: null, links: [] }));
    render(<ProfileCard user={me} />);
    expect(await screen.findByTestId('profile-empty')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Khalid Alsayed');
    // Nothing private in the card that says what people see.
    expect(screen.getByTestId('profile-card').textContent).not.toContain('@');
    expect(screen.getByText(/what people see when they click you in the game/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /set up your profile/i }));
    expect(screen.getByRole('button', { name: /save profile/i })).toBeTruthy();
  });

  it('shows the profile as others see it, and saves edits in place', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? json({}) : json({ name: 'Khalid Alsayed', bio: 'Builds universes.', links: [{ label: 'Site', url: 'https://bawes.net' }] }),
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
    // The name didn't change, so the game isn't told anything.
    expect(announceProfileName).not.toHaveBeenCalled();
  });

  it('renames you, tells the game, and keeps to the game’s name length', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? json({}) : json({ name: 'Khalid Alsayed', bio: 'Hi', links: [] }),
    );
    render(<ProfileCard user={me} />);
    fireEvent.click(await screen.findByRole('button', { name: /edit profile/i }));
    const name = screen.getByPlaceholderText('What people call you');
    fireEvent.change(name, { target: { value: 'A name far too long' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/up to 10 characters/);

    fireEvent.change(name, { target: { value: ' Khalid A ' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
    expect(await screen.findByText(/Close Orbit and everyone in the room sees your new name/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Khalid A');
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put[1].body).name).toBe('Khalid A');
    expect(announceProfileName).toHaveBeenCalledWith('Khalid A');
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

  it('opens editing when asked while already open (a first-steps link on You), focused on the name', async () => {
    fetchMock.mockImplementation(() => json({ name: 'Khalid Alsayed', bio: 'Hi', links: [] }));
    const view = render(<ProfileCard user={me} />);
    await screen.findByText('Hi');
    expect(screen.queryByPlaceholderText('What people call you')).toBeNull();
    view.rerender(<ProfileCard user={me} startEditing />);
    const name = await screen.findByPlaceholderText('What people call you');
    expect(document.activeElement).toBe(name);
  });
});
