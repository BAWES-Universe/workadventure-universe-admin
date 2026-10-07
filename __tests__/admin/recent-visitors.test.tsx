/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RecentVisitors from '@/app/admin/components/recent-visitors';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const visitors = [
  { userId: 'omar', name: 'Omar', woka: [], at: ago(1), room: { id: 'r1', name: 'HQ Lobby' } },
  { userId: 'sara', name: 'Sara', woka: [], at: ago(4), room: { id: 'r1', name: 'HQ Lobby' } },
];

function serve(routes: Record<string, unknown>) {
  fetchMock.mockImplementation((path: string) => {
    const key = Object.keys(routes).find((candidate) => path.startsWith(candidate) && (candidate.endsWith('/passport') ? path.endsWith('/passport') : !path.endsWith('/passport')));
    return Promise.resolve(key ? { ok: true, json: async () => routes[key] } : { ok: false, status: 404, json: async () => ({}) });
  });
}

beforeEach(() => fetchMock.mockReset());

describe('Recent visitors', () => {
  it('shows a face for each person with a name and how long ago, and says these are past visits', async () => {
    serve({ '/api/admin/recent-visitors': { visitors } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    expect(within(section).getByText('Recent visitors')).toBeTruthy();
    expect(within(section).getByText('Who came by lately, newest first. Past visits, not who is online.')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Omar, 1 minute ago' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Sara, 4 minutes ago' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/recent-visitors?scope=universe&id=u1');
  });

  it('draws each face on the colour the game gives that name, with a solid chip and no dashed lines', async () => {
    serve({ '/api/admin/recent-visitors': { visitors, guests: 3 } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    const omar = within(within(section).getByRole('button', { name: 'Omar, 1 minute ago' })).getByTestId('woka-avatar');
    expect(omar.getAttribute('data-tinted')).toBe('true');
    expect(omar.style.background).toBe('rgb(153, 123, 77)');
    const sara = within(within(section).getByRole('button', { name: 'Sara, 4 minutes ago' })).getByTestId('woka-avatar');
    expect(sara.style.background).toBe('rgb(153, 121, 77)');
  });

  it('ends the row with See all, and puts See all by the title too, both opening the full paged list', async () => {
    const open = jest.fn();
    serve({ '/api/admin/recent-visitors': { visitors, guests: 0 } });
    render(<RecentVisitors scope="universe" id="u1" onOpenVisitors={open} />);
    const section = await screen.findByTestId('recent-visitors');
    const tile = within(section).getByTestId('recent-visitors-see-all-tile');
    const items = section.querySelectorAll('ul > li');
    expect(items[items.length - 1].contains(tile)).toBe(true);
    expect(tile.textContent).toContain('See all');
    fireEvent.click(tile);
    fireEvent.click(within(section).getByTestId('recent-visitors-see-all'));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('has no See all when there is nowhere to go from it', async () => {
    serve({ '/api/admin/recent-visitors': { visitors, guests: 0 } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    expect(within(section).queryByText('See all')).toBeNull();
  });

  it('puts a Guests chip first, with how many different guests this week, and opens the Visitors tab', async () => {
    const open = jest.fn();
    serve({ '/api/admin/recent-visitors': { visitors, guests: 12 } });
    render(<RecentVisitors scope="universe" id="u1" onOpenVisitors={open} />);
    const section = await screen.findByTestId('recent-visitors');
    const chip = within(section).getByRole('button', { name: '12 guests this week. See the Visitors tab' });
    expect(chip.textContent).toContain('12');
    expect(chip.textContent).toContain('Guests');
    expect(chip.textContent).toContain('this week');
    // First in the row, ahead of the faces.
    expect(section.querySelector('ul li:first-child button')).toBe(chip);
    expect(section.textContent).toContain('Guests are people without an account.');
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('says "Guest" for one, and still shows the chip when only guests came by', async () => {
    serve({ '/api/admin/recent-visitors': { visitors: [], guests: 1 } });
    render(<RecentVisitors scope="room" id="r1" />);
    const chip = await screen.findByRole('button', { name: '1 guest this week. See the Visitors tab' });
    expect(chip.textContent).toContain('Guest');
    expect(chip.textContent).not.toContain('Guests');
  });

  it('has no chip, and no guest note, when no guests came', async () => {
    serve({ '/api/admin/recent-visitors': { visitors, guests: 0 } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    expect(within(section).queryByText('this week')).toBeNull();
    expect(section.textContent).not.toContain('Guests are people');
  });

  it('is left out when there is nobody to show, or it cannot be read', async () => {
    serve({ '/api/admin/recent-visitors': { visitors: [] } });
    const { container, unmount } = render(<RecentVisitors scope="world" id="w1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    unmount();
    serve({});
    const second = render(<RecentVisitors scope="room" id="r1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(second.container.textContent).toBe('');
  });

  it('opens their profile card when a face is tapped: words, links, stamps and a way to the full profile', async () => {
    serve({
      '/api/admin/recent-visitors': { visitors },
      '/api/admin/users/sara/passport': { stamps: [{ worldId: 'hq', world: 'HQ', universe: { id: 'u-bawes', name: 'BAWES' }, visits: 212, since: '2026-01-12T08:00:00Z' }] },
      '/api/admin/users/sara': { visitCard: { bio: 'Ops at BAWES.', links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/sara' }, { label: 'Bad', url: 'javascript:alert(1)' }] } },
    });
    render(<RecentVisitors scope="universe" id="u1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sara, 4 minutes ago' }));
    const sheet = await screen.findByTestId('visitor-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Sara' })).toBeTruthy();
    expect(within(sheet).getByText('Here 4 minutes ago · HQ Lobby')).toBeTruthy();
    expect(await within(sheet).findByText('Ops at BAWES.')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'LinkedIn' }).getAttribute('href')).toBe('https://linkedin.com/in/sara');
    expect(within(sheet).queryByRole('link', { name: 'Bad' })).toBeNull();
    expect(within(sheet).getByText('212 visits')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Full profile' }).getAttribute('href')).toBe('/admin/users/sara');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('visitor-sheet')).toBeNull());
  });

  it('still opens the card with name, time and room when the profile cannot be read', async () => {
    serve({ '/api/admin/recent-visitors': { visitors } });
    render(<RecentVisitors scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar, 1 minute ago' }));
    const sheet = await screen.findByTestId('visitor-sheet');
    expect(within(sheet).getByText('Here 1 minute ago · HQ Lobby')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Full profile' })).toBeTruthy();
    expect(within(sheet).queryByText('Ops at BAWES.')).toBeNull();
  });
});
