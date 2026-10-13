/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { Context, EntityCard, EntityRow, InContext, Place, StatLine, countPlace } from '@/app/admin/components/ds';

describe('Universe, world and room icons', () => {
  it('draws a clean icon next to the name of a universe, world, room or star, and keeps tool tiles boxed', () => {
    const { container } = render(
      <div>
        <EntityRow href="/w" kind="world" title="BAWES World" />
        <EntityCard href="/u" kind="universe" title="With Ball" />
        <EntityRow href="/b" kind="bot" title="Greeter" />
      </div>,
    );
    expect(container.querySelectorAll('svg[data-kind="world"]').length).toBe(1);
    expect(container.querySelectorAll('svg[data-kind="universe"]').length).toBe(1);
    // A bot keeps its neutral tile and gets no icon on the name's line.
    expect(container.querySelectorAll('.orbit-kind[data-kind="bot"]').length).toBe(1);
    expect(container.querySelectorAll('.orbit-kind[data-kind="world"]').length).toBe(0);
    expect(container.querySelectorAll('.orbit-kind[data-kind="universe"]').length).toBe(0);
  });

  it('keeps a person’s Woka where it is and adds no icon next to the name', () => {
    const { container } = render(<EntityRow href="/p" kind="world" title="Studio" leading={<span data-testid="woka" />} />);
    expect(screen.getByTestId('woka')).toBeTruthy();
    expect(container.querySelectorAll('svg[data-kind]').length).toBe(0);
  });

  it('puts the small icon before each universe, world or room named in a line', () => {
    const { container } = render(
      <div>
        <Context parts={[{ label: 'BAWES', kind: 'universe' }, { label: 'Office', kind: 'world' }, { label: 'HQ' }]} />
        <InContext parts={[{ label: 'BAWES', href: '/u', kind: 'universe' }, { label: 'Office', href: '/w' }]} />
      </div>,
    );
    const places = container.querySelectorAll('[data-kind]');
    expect(Array.from(places).map((node) => node.getAttribute('data-kind'))).toEqual(['universe', 'world', 'universe']);
    expect(screen.getByText('HQ').querySelector('svg')).toBeNull();
    expect(screen.getByText('BAWES', { selector: 'a' }).getAttribute('href')).toBe('/u');
  });

  it('shows counts with their icon, and nothing for an unknown number', () => {
    const { container } = render(
      <StatLine items={[<Place key="u" kind="universe" label="BAWES" />, countPlace('room', 7, 'room'), countPlace('people', 1, 'member'), countPlace('world', undefined, 'world')]} />,
    );
    expect(container.textContent).toBe('BAWES · 7 rooms · 1 member');
    expect(container.querySelectorAll('svg').length).toBe(3);
  });
});
