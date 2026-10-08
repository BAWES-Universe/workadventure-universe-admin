/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import InviteToWorldDialog from '@/app/admin/components/invite-to-world-dialog';
import { ToastProvider } from '@/components/ui/toast';

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

describe('Inviting someone from their profile', () => {
  it('says the invitation makes them a member, and that visiting needs none', async () => {
    fetchMock.mockImplementation(() =>
      json({ worlds: [{ id: 'w-1', name: 'HQ', slug: 'hq', universe: { id: 'u-1', name: 'Universe HQ', slug: 'hq' } }] }),
    );
    render(
      <ToastProvider>
        <InviteToWorldDialog open onOpenChange={() => {}} userId="u-sara" userName="Sara Khaled" onInviteSent={() => {}} />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Invite Sara Khaled to become a member' })).toBeTruthy();
    expect(screen.getByText(/Public rooms are open to everyone, no invitation needed\./)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/u-sara/worlds');
  });
});
