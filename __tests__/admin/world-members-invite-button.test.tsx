/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { WorldDetailPage } from '@/app/admin/worlds/[id]/detail';

const fetchMock = jest.fn();
let canInvite = true;

jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'w1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));
jest.mock('@/app/admin/admin-bootstrap-context', () => ({ useIsSuperAdmin: () => false }));
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => jest.fn() }));
jest.mock('@/app/admin/hooks/use-place-data', () => ({
  useHere: () => ({ here: { count: 0, bots: 0, people: [], youAreHere: false }, known: false, byRoom: new Map() }),
  useMembersPreview: () => ({ universeId: 'u1', yourTags: ['editor'], members: [], total: 0 }),
  useStarToggle: () => ({ toggle: jest.fn(), busy: false }),
}));
jest.mock('@/app/admin/hooks/use-entity-summaries', () => ({ useEntitySummaries: () => ({ summary: () => undefined, failed: false, retry: jest.fn() }) }));
jest.mock('@/app/admin/components/world-safety', () => ({ __esModule: true, default: () => null, useWorldSafety: () => ({ data: null }), waitingCount: () => 0 }));
jest.mock('@/app/admin/components/member-list', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/admin/components/members-row', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/admin/components/recent-visitors', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/admin/components/universe-people', () => ({ ...jest.requireActual('@/app/admin/components/universe-people'), useCanInvite: () => canInvite }));
// The sheet has its own tests; here it only has to be there or not
jest.mock('@/app/admin/components/invite-sheet', () => ({ __esModule: true, default: () => <div data-testid="invite-sheet" /> }));

const WORLD = {
  id: 'w1', slug: 'hq', name: 'HQ', description: null, isPublic: true, featured: false, thumbnailUrl: null,
  universe: { id: 'u1', name: 'BAWES', slug: 'bawes', ownerId: 'owner' },
  rooms: [], manages: true, canEdit: false,
};

beforeEach(() => {
  fetchMock.mockReset();
  canInvite = true;
  fetchMock.mockImplementation(async (path: string) => ({
    ok: true,
    status: 200,
    json: async () => (path === '/api/admin/worlds/w1' ? WORLD : path === '/api/auth/me' ? { user: { id: 'me' } } : {}),
  }));
});

it('offers Invite member on the world Members page only to someone who may invite, so the button is never dead', async () => {
  render(<WorldDetailPage view="members" />);
  expect(await screen.findByRole('button', { name: 'Invite member' })).toBeTruthy();
  expect(screen.getByTestId('invite-sheet')).toBeTruthy();
});

it('shows no Invite member to an Editor who manages the world but may not invite', async () => {
  canInvite = false;
  render(<WorldDetailPage view="members" />);
  await screen.findByRole('heading', { name: 'Members' });
  expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
  expect(screen.queryByTestId('invite-sheet')).toBeNull();
});
