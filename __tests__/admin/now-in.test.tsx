/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { NowIn } from '@/app/admin/components/now-in';
import type { LivePlace, LiveView } from '@/lib/live-presence';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const person = (uuid: string, you = false) => ({ uuid, userId: `u-${uuid}`, name: uuid, status: 'online' as const, woka: [], you, friend: true });
const place = (roomId: string, name: string, here: boolean): LivePlace => ({
  roomId,
  name,
  world: { id: 'w-hq', name: 'BAWES World' },
  universe: { id: 'un-bawes', name: 'BAWES Universe' },
  playPath: `/@/bawes/bawes/${roomId}`,
  count: 1,
  guests: 0,
  bots: 0,
  people: [],
  here,
});
const at = ({ roomId, name, world, universe, playPath }: LivePlace) => ({ roomId, name, world, universe, playPath });
const hall = place('hall', 'Main Hall', true);
const hq = place('hq', 'Headquarters', false);
const view: LiveView = {
  available: true,
  generatedAt: 1,
  places: [hall, hq],
  people: [
    { ...person('omar'), place: at(hq) },
    { ...person('dana'), place: at(hall) },
  ],
};

describe('Now in', () => {
  it('shows the room someone is in, its world and universe, and Visit', () => {
    render(<NowIn live={view} uuid="omar" />);
    expect(screen.getByText('Now in')).toBeTruthy();
    expect(screen.getByText('Headquarters')).toBeTruthy();
    expect(screen.getByText('BAWES World')).toBeTruthy();
    expect(screen.getByText('BAWES Universe')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Visit: Headquarters' }).getAttribute('href')).toBe('/admin/rooms/hq');
  });

  it("says you're in their room instead of offering Visit", () => {
    render(<NowIn live={view} uuid="dana" />);
    expect(screen.getByText('You’re in this room')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows nothing for someone the live view leaves out (offline, or not sharing their room with you)', () => {
    const { container } = render(<NowIn live={view} uuid="sara" />);
    expect(container.innerHTML).toBe('');
    expect(render(<NowIn live={null} uuid="omar" />).container.innerHTML).toBe('');
    expect(render(<NowIn live={undefined} uuid="omar" />).container.innerHTML).toBe('');
  });
});
