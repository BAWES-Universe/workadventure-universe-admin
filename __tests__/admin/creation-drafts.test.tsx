/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewRoomPage from '@/app/admin/rooms/new/page';
import { readDraft, scopedDraftKey } from '@/lib/drafts';

let mockWorldId = 'world-a';
const mockPush = jest.fn();
const mockAuthenticatedFetch = jest.fn(async (url: string, _options?: RequestInit) => ({
  ok: true,
  json: async () => url === '/api/auth/me'
    ? { user: { id: 'user-1' } }
    : { id: mockWorldId, name: mockWorldId, universe: { id: 'universe-1', name: 'Universe' } },
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams({ worldId: mockWorldId }),
}));
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (url: string, options?: RequestInit) => mockAuthenticatedFetch(url, options) }));
jest.mock('@/components/templates/TemplateLibrary', () => ({
  TemplateLibrary: ({ onSelectTemplate }: { onSelectTemplate: (slug: string) => void }) =>
    <button onClick={() => onSelectTemplate('moon')}>Choose Moon</button>,
}));
jest.mock('@/components/templates/TemplateDetail', () => ({
  TemplateDetail: ({ onSelectMap }: { onSelectMap: (id: string, url: string) => void }) =>
    <button onClick={() => onSelectMap('11111111-1111-1111-1111-111111111111', 'https://maps.example/moon.tmj')}>Choose Garden</button>,
}));

describe('creation drafts preserve what will actually be submitted', () => {
  beforeAll(() => {
    global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  });
  beforeEach(() => { sessionStorage.clear(); mockWorldId = 'world-a'; mockPush.mockClear(); mockAuthenticatedFetch.mockClear(); });

  it('restores custom-map mode and a manually chosen slug, without copying the draft to another world', async () => {
    const first = render(<NewRoomPage />);
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/admin/worlds/world-a', undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Custom Map (Advanced)' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Moon garden' } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'my-orbit' } });
    fireEvent.change(screen.getByLabelText(/^Map URL/), { target: { value: 'https://maps.example/moon.tmj' } });
    first.unmount();

    const second = render(<NewRoomPage />);
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Moon garden');
    expect(screen.getByLabelText(/^Map URL/)).toHaveValue('https://maps.example/moon.tmj');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Moon garden two' } });
    expect(screen.getByLabelText(/^Slug/)).toHaveValue('my-orbit');

    mockWorldId = 'world-b';
    second.rerender(<NewRoomPage />);
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Custom Map (Advanced)' }));
    expect(screen.getByLabelText(/^Name/)).toHaveValue('');
    expect(screen.getByLabelText(/^Map URL/)).toHaveValue('');
    expect(readDraft<{ name: string }>(scopedDraftKey('room.new', 'world-a', null))?.name).toBe('Moon garden two');
    second.unmount();
  });

  it('restores the selected template and submits its identity instead of silently switching to a custom map', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ template: {
      name: 'Moon template', maps: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Garden', previewImageUrl: null }],
    } }) })) as unknown as typeof fetch;
    const first = render(<NewRoomPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose Moon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Garden' }));
    await screen.findByText('Moon template');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Restored garden' } });
    first.unmount();

    const restored = render(<NewRoomPage />);
    expect(screen.getByText('Moon template')).toBeTruthy();
    expect(screen.getByText('Garden')).toBeTruthy();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Restored garden');
    fireEvent.submit(screen.getByRole('button', { name: 'Create Room' }).closest('form')!);
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    const submitted = mockAuthenticatedFetch.mock.calls.find(([url, options]) => url === '/api/admin/rooms' && options?.method === 'POST');
    expect(JSON.parse(submitted?.[1]?.body as string)).toMatchObject({
      name: 'Restored garden', worldId: 'world-a', templateMapId: '11111111-1111-1111-1111-111111111111',
    });
    expect(JSON.parse(submitted?.[1]?.body as string).mapUrl).toBeUndefined();
    restored.unmount();
  });
});
