/** @jest-environment jsdom */
/**
 * Who is in a place right now, on the universe, world and room pages: people are the number, bots are named apart
 * (#594).
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { PlaceHero, RoomRows } from '@/app/admin/components/place-hero';
import type { Here } from '@/app/admin/hooks/use-place-data';

const face = (name: string) => ({ name, woka: [] });
const busy: Here = { count: 5, bots: 21, people: ['Khalid', 'Mishari', 'Sara', 'Ahmad', 'Layla'].map(face), youAreHere: true };

describe('The place hero', () => {
  it('names the people here and counts the bots after them', () => {
    render(<PlaceHero kind="world" title="BAWES World" context={null} stats={[]} here={busy} actions={null} />);
    const hero = screen.getByTestId('place-hero');
    expect(within(hero).getByText(/Khalid, Mishari, Sara and 2 more are here now/)).toBeTruthy();
    expect(within(hero).getByText('· 21 bots')).toBeTruthy();
  });

  it('counts only the bots when no people are in', () => {
    render(<PlaceHero kind="world" title="BAWES World" context={null} stats={[]} here={{ count: 0, bots: 21, people: [], youAreHere: false }} actions={null} />);
    expect(screen.getByTestId('place-hero').textContent).toContain('21\u00a0bots here now');
  });

  it('says nothing about bots when there are none', () => {
    render(<PlaceHero kind="world" title="BAWES World" context={null} stats={[]} here={{ ...busy, bots: 0 }} actions={null} />);
    expect(screen.getByTestId('place-hero').textContent).not.toMatch(/bot/);
  });
});

describe('A room row', () => {
  const row = (here: Here) => ({ id: 'r-hq', name: 'Headquarters', favorites: 0, playPath: '/@/b/w/hq', here });

  it('counts the people here, then the bots', () => {
    const { container } = render(<RoomRows rooms={[row({ count: 2, bots: 21, people: [face('Khalid'), face('Mishari')], youAreHere: true })]} />);
    expect(container.textContent).toContain('2 here · 21\u00a0bots');
  });

  it('still shows the bots of a room with only bots in it', () => {
    const { container } = render(<RoomRows rooms={[row({ count: 0, bots: 21, people: [], youAreHere: false })]} />);
    expect(container.textContent).toContain('0 here · 21\u00a0bots');
  });

  it('reads as before when no bots are in', () => {
    const { container } = render(<RoomRows rooms={[row({ count: 3, bots: 0, people: [face('Sara')], youAreHere: true })]} />);
    expect(container.textContent).toContain('3 here');
    expect(container.textContent).not.toMatch(/bot/);
  });
});
