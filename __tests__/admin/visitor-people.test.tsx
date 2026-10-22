/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { VisitorPeople } from '@/app/admin/components/visitor-people';

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
const visit = (id: string, minutes: number, signedIn: boolean, ip?: string, room = { id: 'r1', name: 'HQ' }) => ({ id, at: ago(minutes), signedIn, ...(ip ? { ip } : {}), room, world: { id: 'w1', name: 'Kuwait' } });
const fawaz = {
  key: 'u:fawaz',
  userId: 'fawaz',
  name: 'fawaz',
  woka: [],
  roles: [],
  visitCount: 12,
  ipCount: 2,
  visits: Array.from({ length: 10 }, (_, index) => visit(`f${index}`, 8 + index, index !== 4, index % 2 ? '104.23.200.156' : '94.129.203.235', index % 3 ? { id: 'r1', name: 'HQ' } : { id: 'r2', name: 'PawApp' })),
};
const nova = { key: 'g:browser', userId: null, name: 'Nova', woka: [], roles: [], visitCount: 1, ipCount: 1, visits: [visit('n1', 30, false, '37.36.12.9')] };
const sara = { key: 'u:sara', userId: 'sara', name: 'Sara', woka: [], roles: ['admin'], visitCount: 1, visits: [visit('s1', 60, true)] };

function serve(handler: (path: string) => unknown) {
  fetchMock.mockImplementation((path: string) => {
    const body = handler(path);
    return Promise.resolve(body ? { ok: true, json: async () => body } : { ok: false, status: 500, json: async () => ({}) });
  });
}

beforeEach(() => fetchMock.mockReset());

describe('Visitors list', () => {
  it('shows each person once, with their latest visit, role and IP, and a visits strip only when they came back', async () => {
    serve(() => ({ people: [fawaz, nova, sara], total: 3, hasMore: false }));
    render(<VisitorPeople scope="room" id="r1" />);
    const cards = await screen.findAllByTestId('visitor-person');
    expect(cards).toHaveLength(3);
    expect(within(cards[0]).getByText('Signed in · 8 minutes ago')).toBeTruthy();
    expect(within(cards[0]).getByText('94.129.203.235')).toBeTruthy();
    expect(within(cards[0]).getByText('+1 more IP')).toBeTruthy();
    expect(within(cards[0]).getByRole('button', { name: '12 visits' }).getAttribute('aria-expanded')).toBe('false');
    expect(within(cards[0]).getByRole('link').getAttribute('href')).toBe('/admin/users/fawaz');
    // A guest has no profile to open; one visit needs no strip.
    expect(within(cards[1]).queryByRole('link')).toBeNull();
    expect(within(cards[1]).queryByRole('button')).toBeNull();
    expect(within(cards[2]).getByText('Admin')).toBeTruthy();
    expect(screen.getByText('3 of 3 people')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/visitors?scope=room&id=r1&page=1');
  });

  it('opens every visit with when, how and the IP, and loads the rest on request', async () => {
    serve((path) => (path.includes('person=') ? { visits: [visit('f10', 40, true, '94.129.203.235'), visit('f11', 41, false, '104.23.200.156')] } : { people: [fawaz], total: 1, hasMore: false }));
    render(<VisitorPeople scope="room" id="r1" />);
    const [card] = await screen.findAllByTestId('visitor-person');
    fireEvent.click(within(card).getByRole('button', { name: '12 visits' }));
    expect(within(card).getByRole('button', { name: '12 visits' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(card).getAllByRole('listitem')).toHaveLength(10);
    expect(within(card).getAllByText('Guest')).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'Show 2 more visits' }));
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(12));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/visitors?scope=room&id=r1&person=u%3Afawaz&offset=10&limit=20');
    expect(within(card).queryByRole('button', { name: /more visits/ })).toBeNull();
  });

  it('names the room of each visit on a world, with no IP', async () => {
    serve(() => ({ people: [fawaz], total: 1, hasMore: false }));
    render(<VisitorPeople scope="world" id="w1" />);
    const [card] = await screen.findAllByTestId('visitor-person');
    expect(within(card).queryByText('94.129.203.235')).toBeNull();
    expect(within(card).queryByText('+1 more IP')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: '12 visits' }));
    expect(within(card).getAllByRole('link', { name: 'PawApp' })[0].getAttribute('href')).toBe('/admin/rooms/r2');
    expect(within(card).queryByText('104.23.200.156')).toBeNull();
  });

  it('names the room of a single visit on a world, and the world too on a universe', async () => {
    serve(() => ({ people: [nova], total: 1, hasMore: false }));
    const { unmount } = render(<VisitorPeople scope="world" id="w1" />);
    const [card] = await screen.findAllByTestId('visitor-person');
    expect(within(card).getByRole('link', { name: 'HQ' }).getAttribute('href')).toBe('/admin/rooms/r1');
    expect(within(card).queryByRole('link', { name: 'Kuwait' })).toBeNull();
    unmount();
    render(<VisitorPeople scope="universe" id="u1" />);
    const [universeCard] = await screen.findAllByTestId('visitor-person');
    expect(within(universeCard).getByRole('link', { name: 'Kuwait' }).getAttribute('href')).toBe('/admin/worlds/w1');
    expect(within(universeCard).getByRole('link', { name: 'HQ' }).getAttribute('href')).toBe('/admin/rooms/r1');
  });

  it('says a room or world was private instead of naming it', async () => {
    serve(() => ({ people: [{ ...nova, visits: [{ ...nova.visits[0], room: null, world: null }] }], total: 1, hasMore: false }));
    render(<VisitorPeople scope="universe" id="u1" />);
    const [card] = await screen.findAllByTestId('visitor-person');
    expect(within(card).getByText('Private world')).toBeTruthy();
    expect(within(card).getByText('Private room')).toBeTruthy();
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('keeps a single visit on a room to the card, with no extra row', async () => {
    serve(() => ({ people: [nova], total: 1, hasMore: false }));
    render(<VisitorPeople scope="room" id="r1" />);
    const [card] = await screen.findAllByTestId('visitor-person');
    expect(within(card).queryByRole('link')).toBeNull();
    expect(within(card).getByText('37.36.12.9')).toBeTruthy();
  });

  it('adds the next people with Show more', async () => {
    serve((path) => (path.endsWith('page=1') ? { people: [fawaz], total: 2, hasMore: true } : { people: [fawaz, nova], total: 2, hasMore: false }));
    render(<VisitorPeople scope="room" id="r1" />);
    expect(await screen.findByText('1 of 2 people')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('2 of 2 people')).toBeTruthy();
    expect(screen.getAllByTestId('visitor-person')).toHaveLength(2);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/visitors?scope=room&id=r1&page=2');
  });

  it('stops offering more once the last page is in, even if someone came back meanwhile and is counted twice', async () => {
    // Fawaz came back while the list was open: page 2 repeats him, and nobody is left after it.
    serve((path) => (path.endsWith('page=1') ? { people: [fawaz], total: 3, hasMore: true } : { people: [fawaz, nova], total: 3, hasMore: false }));
    render(<VisitorPeople scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('2 of 3 people')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('asks for the same page again after it failed, never skipping it', async () => {
    let failPage2 = true;
    serve((path) => (path.endsWith('page=1') ? { people: [fawaz], total: 2, hasMore: true } : failPage2 ? null : { people: [nova], total: 2, hasMore: false }));
    render(<VisitorPeople scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText(/couldn’t load more visitors/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    failPage2 = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 of 2 people')).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/visitors?scope=room&id=r1&page=2');
  });

  it('says when nobody came, with the people icon as a plain glyph', async () => {
    serve(() => ({ people: [], total: 0, hasMore: false }));
    const { container } = render(<VisitorPeople scope="universe" id="u1" />);
    expect(await screen.findByText('No visitors yet.')).toBeTruthy();
    expect(screen.getByText('Visits to this universe show up here.')).toBeTruthy();
    expect(container.querySelector('.orbit-kind[data-kind="people"]')).toBeTruthy();
  });

  it('offers to try again when the list cannot load', async () => {
    serve(() => null);
    render(<VisitorPeople scope="room" id="r1" />);
    expect(await screen.findByText(/couldn’t load visitors/)).toBeTruthy();
    serve(() => ({ people: [nova], total: 1, hasMore: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nova')).toBeTruthy();
  });
});
