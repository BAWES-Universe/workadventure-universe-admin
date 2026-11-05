/** @jest-environment jsdom */

// Passing a universe to another account (#820): the Make owner card and sheet on a member's page, and "Offered to you" on
// Memberships. The server rules are in __tests__/api/ownership-transfer-db.test.ts.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemberPage } from '@/app/admin/universes/[id]/members/[userId]/member-page';
import MyMembershipsPage from '@/app/admin/memberships/page';
import { ToastProvider } from '@/components/ui/toast';
import { clearSummaryCache } from '@/app/admin/hooks/use-room-analytics';

const fetchMock = jest.fn();
const push = jest.fn();
let params: Record<string, string> = { id: 'u1', userId: 'sara' };

jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({
  useParams: () => params,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn(), push, refresh: jest.fn() }),
}));

const reply = (body: unknown, status = 200) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
const everywhere = { allWorlds: true, worldIds: [] as string[] };
const ROLES = [
  { id: 'r-admin', key: 'admin', name: 'Admin', color: '#F87171', builtIn: true, position: 1_000_000, permissions: '1073741823', people: 1 },
  { id: 'r-member', key: 'member', name: 'Member', color: '#A78BFA', builtIn: true, position: 1, permissions: '0', people: 2 },
];

type Ownership = {
  canOffer: boolean;
  onBehalfOf: string | null;
  waiting: { toUserId: string; toName: string | null; createdAt: string; toThem: boolean } | null;
  since: string | null;
  from: string | null;
};
let calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
let ownership: Ownership;
let isOwner = false;
let postStatus = 201;

function memberRequests(url: string, init?: { method?: string; body?: string }) {
  const method = init?.method ?? 'GET';
  calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
  if (url === '/api/auth/me') return reply({ user: { id: 'owner' } });
  if (url === '/api/admin/universes/u1') return reply({ id: 'u1', name: 'Autonode Labs', ownerId: 'owner', worlds: [{ id: 'iv', name: 'Infinite Void' }] });
  if (url.endsWith('/u1/roles')) return reply({ roles: ROLES });
  if (url.endsWith('/ownership-offer') && method === 'POST') return reply(postStatus === 201 ? { offer: { id: 'o1' } } : { error: 'An offer is already waiting. Take it back first.' }, postStatus);
  if (url.endsWith('/ownership-offer') && method === 'DELETE') {
    ownership = { ...ownership, canOffer: true, waiting: null };
    return reply({ success: true });
  }
  if (url.endsWith('/members/sara')) {
    return reply({
      member: { userId: 'sara', name: 'Yousef 2', email: null, joinedAt: '2026-11-03T09:00:00Z', lastVisitedAt: null, isOwner, worlds: everywhere, roles: [] },
      can: { giveRoleIds: [], giveWorlds: 'all', widen: true, remove: !isOwner },
      ownership,
    });
  }
  return reply({});
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  clearSummaryCache();
  calls = [];
  params = { id: 'u1', userId: 'sara' };
  isOwner = false;
  postStatus = 201;
  ownership = { canOffer: true, onBehalfOf: null, waiting: null, since: null, from: null };
  fetchMock.mockImplementation(memberRequests);
});

const wrap = (node: React.ReactNode) => render(<ToastProvider>{node}</ToastProvider>);

describe('Make owner on a member’s page', () => {
  it('sits in the Danger zone above Remove, and says what the person gets', async () => {
    wrap(<MemberPage />);
    const card = await screen.findByTestId('make-owner');
    expect(within(card).getByText('Make Yousef 2 the owner')).toBeTruthy();
    expect(within(card).getByText(/gets the whole universe, every world and room in it, once they accept\. You stay as Admin\./)).toBeTruthy();
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons.indexOf('Make owner')).toBeGreaterThan(-1);
    expect(buttons.indexOf('Make owner')).toBeLessThan(buttons.indexOf('Remove'));
  });

  it('asks for the universe’s name before it offers, and sends the offer for the whole universe', async () => {
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make owner' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Make Yousef 2 the owner of Autonode Labs?' })).toBeTruthy();
    expect(within(sheet).getByText(/all of Autonode Labs, with the world Infinite Void and every room in it\. A world or room can’t be passed on its own\./)).toBeTruthy();
    expect(within(sheet).getByText(/has to accept\./)).toBeTruthy();

    const send = within(sheet).getByRole('button', { name: 'Offer ownership' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const input = within(sheet).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'autonode labs' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Autonode Labs' } });
    expect(send.disabled).toBe(false);

    // After the offer the page reloads to the waiting card
    ownership = { canOffer: false, onBehalfOf: null, waiting: { toUserId: 'sara', toName: 'Yousef 2', createdAt: new Date().toISOString(), toThem: true }, since: null, from: null };
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/admin/universes/u1/ownership-offer', body: { toUserId: 'sara', universeName: 'Autonode Labs' } });
    const waiting = await screen.findByTestId('offer-waiting');
    expect(within(waiting).getByText('Waiting for Yousef 2 to accept')).toBeTruthy();
    expect(within(waiting).getByText(/Nothing changes until they accept\. It waits until they answer or you take it back\./)).toBeTruthy();
    expect(screen.queryByTestId('make-owner')).toBeNull();
  });

  it('keeps the sheet open and says why when the server refuses', async () => {
    postStatus = 409;
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make owner' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'Autonode Labs' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Offer ownership' }));
    expect(await within(sheet).findByText('An offer is already waiting. Take it back first.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes with Cancel and sends nothing', async () => {
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make owner' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('takes the waiting offer back with one tap and shows Make owner again', async () => {
    ownership = { canOffer: false, onBehalfOf: null, waiting: { toUserId: 'sara', toName: 'Yousef 2', createdAt: new Date().toISOString(), toThem: true }, since: null, from: null };
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Take back the offer' }));
    await screen.findByTestId('make-owner');
    expect(calls.find((call) => call.method === 'DELETE')!.url).toBe('/api/admin/universes/u1/ownership-offer');
    expect(screen.queryByTestId('offer-waiting')).toBeNull();
  });

  it('on anyone else’s page says who is already waiting, and offers no second one', async () => {
    ownership = { canOffer: false, onBehalfOf: null, waiting: { toUserId: 'omar', toName: 'Omar', createdAt: new Date().toISOString(), toThem: false }, since: null, from: null };
    wrap(<MemberPage />);
    const note = await screen.findByTestId('offer-elsewhere');
    expect(within(note).getByText('An offer is waiting for Omar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make owner' })).toBeNull();
    fireEvent.click(within(note).getByRole('button', { name: 'See the offer' }));
    expect(push).toHaveBeenCalledWith('/admin/universes/u1/members/omar');
  });

  it('shows nothing about passing the universe on to someone who cannot', async () => {
    ownership = { canOffer: false, onBehalfOf: null, waiting: null, since: null, from: null };
    wrap(<MemberPage />);
    await screen.findByRole('button', { name: 'Remove' });
    expect(screen.queryByTestId('make-owner')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make owner' })).toBeNull();
  });

  it('names the owner who stays Admin when a super admin acts for them', async () => {
    ownership = { canOffer: true, onBehalfOf: 'Yousef', waiting: null, since: null, from: null };
    wrap(<MemberPage />);
    expect(await screen.findByText(/Yousef stays as Admin\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }));
    expect(within(await screen.findByRole('dialog')).getByText(/Yousef stays as Admin/)).toBeTruthy();
  });

  it('says on the new owner’s page since when, and from whom', async () => {
    isOwner = true;
    ownership = { canOffer: false, onBehalfOf: null, waiting: null, since: new Date().toISOString(), from: 'Yousef' };
    wrap(<MemberPage />);
    expect(await screen.findByText('Since today · from Yousef')).toBeTruthy();
    expect(screen.getByText(/Admin in every world came with it, so the game gives the same\./)).toBeTruthy();
  });

  it('still says “Created” for an owner who made the universe', async () => {
    isOwner = true;
    wrap(<MemberPage />);
    expect(await screen.findByText('Created Autonode Labs')).toBeTruthy();
  });

  it('works against a server that does not send the ownership part yet', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const answer = await memberRequests(url, init);
      const body = await answer.json();
      if ('ownership' in body) delete body.ownership;
      return { ...answer, json: () => Promise.resolve(body) };
    });
    wrap(<MemberPage />);
    await screen.findByRole('button', { name: 'Remove' });
    expect(screen.queryByTestId('make-owner')).toBeNull();
  });
});

describe('Offered to you on Memberships', () => {
  const OFFER = { id: 'o1', createdAt: '2026-11-05T09:00:00Z', universe: { id: 'u1', name: 'Autonode Labs', worldCount: 1 }, owner: { id: 'owner', name: 'Yousef' } };
  let offers: unknown[];
  let memberships: unknown[];
  let answerStatus: number;

  beforeEach(() => {
    offers = [OFFER];
    memberships = [];
    answerStatus = 200;
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/auth/me') return reply({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations') return reply({ invitations: [] });
      if (url === '/api/memberships/my/universes') return reply({ universes: memberships });
      if (url === '/api/memberships/ownership-offers') return reply({ offers });
      if (url.startsWith('/api/memberships/ownership-offers/') && method === 'POST') {
        if (answerStatus !== 200) return reply({ error: 'Offer not found' }, answerStatus);
        offers = [];
        if (url.endsWith('/accept')) {
          memberships = [{ universe: { id: 'u1', name: 'Autonode Labs', createdAt: '2026-09-14T09:00:00Z', worlds: [{ id: 'iv', name: 'Infinite Void' }] }, isOwner: true, joinedAt: '2026-11-03T09:00:00Z', worlds: everywhere, roles: [{ key: 'admin', name: 'Admin', color: '#F87171', ...everywhere }] }];
        }
        return reply({ success: true, previousOwnerName: 'Yousef' });
      }
      return reply({});
    });
  });

  it('shows the offer at the top with Accept and Decline, naming the owner and the whole universe', async () => {
    render(<MyMembershipsPage />);
    const section = await screen.findByTestId('ownership-offers');
    expect(within(section).getByText('Offered to you')).toBeTruthy();
    expect(within(section).getByText('Autonode Labs')).toBeTruthy();
    expect(within(section).getByText(/Yousef offered you the whole universe · 1 world/)).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Decline ownership of Autonode Labs' })).toBeTruthy();
  });

  it('shows nothing when no universe is offered', async () => {
    offers = [];
    render(<MyMembershipsPage />);
    await screen.findByText('No memberships yet.');
    expect(screen.queryByTestId('ownership-offers')).toBeNull();
  });

  it('opens a sheet that says what owning means, and accepts only on its main button', async () => {
    render(<MyMembershipsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Own Autonode Labs?' })).toBeTruthy();
    expect(within(sheet).getByText(/its world and every room in it\. A world or room can’t be owned on its own\./)).toBeTruthy();
    expect(within(sheet).getByText(/Yousef stays as Admin\./)).toBeTruthy();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    fireEvent.click(within(sheet).getByRole('button', { name: 'Own Autonode Labs' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((call) => call.method === 'POST')!.url).toBe('/api/memberships/ownership-offers/o1/accept');
    expect(await screen.findByTestId('own-done')).toHaveProperty('textContent', 'You own Autonode Labs now, with every world and room in it. Yousef stays as Admin.');
    // The universe moved to "You own", and the offer is gone
    expect(await screen.findByTestId('owned-universes')).toBeTruthy();
    expect(screen.queryByTestId('ownership-offers')).toBeNull();
  });

  it('closes the sheet with Cancel and accepts nothing', async () => {
    render(<MyMembershipsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('asks Keep or Decline before declining, like an invitation', async () => {
    render(<MyMembershipsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline ownership of Autonode Labs' }));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Decline ownership of Autonode Labs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(screen.queryByTestId('ownership-offers')).toBeNull());
    expect(calls.find((call) => call.method === 'POST')!.url).toBe('/api/memberships/ownership-offers/o1/decline');
  });

  it('says why when the offer is gone, and reloads the list', async () => {
    answerStatus = 404;
    render(<MyMembershipsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Own Autonode Labs' }));
    expect(await screen.findByText('Offer not found')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
