/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FADE, ScrollSection, stepTarget } from '@/app/admin/components/orbit/scroll-row';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** Seven cards 216 wide, 12 apart, in a row 682 wide (Your stars in the Orbit panel). */
const cards = Array.from({ length: 7 }, (_, index) => ({ left: index * 228, right: index * 228 + 216 }));
const VIEW = 682;
const CONTENT = 7 * 228 - 12;

describe('stepTarget', () => {
  it('› puts the first card that is not clear of the fade at the left, just clear of the fade there', () => {
    // Card 2 (456–672) is under the fade on the right, so it goes to the left edge, clear of the fade.
    expect(stepTarget(cards, 0, VIEW, CONTENT, 1)).toBe(456 - FADE);
    // The card before it (228–444) is now in the fade on the left; the one after is fully in view.
    const from = 456 - FADE;
    expect(cards[1].right - from).toBeLessThanOrEqual(FADE);
    expect(cards[3].right - from).toBeLessThanOrEqual(VIEW - FADE);
  });

  it('› moves on from where the last tap is going, one card further each time', () => {
    const first = stepTarget(cards, 0, VIEW, CONTENT, 1);
    const second = stepTarget(cards, first, VIEW, CONTENT, 1);
    expect(second).toBeGreaterThan(first);
  });

  it('› stops at the end of the row, and takes the last stretch in one go', () => {
    expect(stepTarget(cards, CONTENT - VIEW - 10, VIEW, CONTENT, 1)).toBe(CONTENT - VIEW);
    expect(stepTarget(cards, 0, VIEW, 100, 1)).toBe(0);
  });

  it('‹ puts the last card that is hidden or under the fade at the right, clear of the fade there', () => {
    const from = 900;
    const target = stepTarget(cards, from, VIEW, CONTENT, -1);
    // Card 4 (912–1128) was in the fade; it now ends where the right fade starts.
    expect(cards[4].right - target).toBe(VIEW - FADE);
    expect(target).toBeLessThan(from);
  });

  it('‹ goes to the start when what is left would hide the first card under the fade', () => {
    expect(stepTarget(cards, 228, VIEW, CONTENT, -1)).toBe(0);
  });

  it('a card too wide to sit between both fades keeps its left edge clear', () => {
    const wide = [
      { left: 0, right: 420 },
      { left: 432, right: 1100 },
      { left: 1112, right: 1400 },
    ];
    expect(stepTarget(wide, 0, 500, 1400, 1)).toBe(432 - FADE);
    expect(stepTarget(wide, 900, 500, 1400, -1)).toBe(432 - FADE);
  });
});

describe('ScrollSection', () => {
  function geometry(row: HTMLElement, left: number) {
    // jsdom has no layout: the row is 682 wide and its seven cards sit where the browser would put them.
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: VIEW });
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: CONTENT });
    let scrollLeft = left;
    Object.defineProperty(row, 'scrollLeft', { configurable: true, get: () => scrollLeft, set: (value: number) => (scrollLeft = value) });
    row.getBoundingClientRect = () => ({ left: 100 - scrollLeft, right: 0, top: 0, bottom: 0, width: VIEW, height: 0, x: 0, y: 0, toJSON() {} });
    Array.from(row.children).forEach((child, index) => {
      (child as HTMLElement).getBoundingClientRect = () =>
        ({ left: 100 - scrollLeft + cards[index].left, right: 100 - scrollLeft + cards[index].right, top: 0, bottom: 0, width: 216, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    });
    row.scrollTo = jest.fn() as unknown as typeof row.scrollTo;
  }

  const rooms = (names: string[]) => names.map((name) => <div key={name}>{name}</div>);

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  });

  it('› scrolls the row to the card, not by a fixed distance', () => {
    render(
      <ScrollSection id="x" title="Your stars" label="your stars" testId="stars">
        {rooms(['a', 'b', 'c', 'd', 'e', 'f', 'g'])}
      </ScrollSection>,
    );
    const row = screen.getByTestId('stars').querySelector('[data-back]') as HTMLElement;
    geometry(row, 0);
    // The arrows show once the row has been measured.
    act(() => {
      fireEvent.scroll(row);
    });
    fireEvent.click(screen.getByRole('button', { name: 'More: your stars' }));
    expect(row.scrollTo).toHaveBeenCalledWith({ left: 456 - FADE, behavior: 'smooth' });
  });

  it('a second tap while the first is still moving goes on from where the first is going', () => {
    render(
      <ScrollSection id="x" title="Your stars" label="your stars" testId="stars">
        {rooms(['a', 'b', 'c', 'd', 'e', 'f', 'g'])}
      </ScrollSection>,
    );
    const row = screen.getByTestId('stars').querySelector('[data-back]') as HTMLElement;
    geometry(row, 0);
    act(() => {
      fireEvent.scroll(row);
    });
    const next = screen.getByRole('button', { name: 'More: your stars' });
    fireEvent.click(next);
    fireEvent.click(next);
    const [first, second] = (row.scrollTo as jest.Mock).mock.calls.map(([options]) => options.left as number);
    expect(first).toBe(456 - FADE);
    expect(second).toBeGreaterThan(first);
  });

  it('goes back to its start when the cards change order while it was at the start', () => {
    const { rerender } = render(
      <ScrollSection id="x" title="Your stars" label="your stars" testId="stars">
        {rooms(['a', 'b', 'c'])}
      </ScrollSection>,
    );
    const row = screen.getByTestId('stars').querySelector('[data-back]') as HTMLElement;
    geometry(row, 0);
    act(() => {
      fireEvent.scroll(row);
    });
    // The browser keeps the card it was snapped to in view, which moves the row.
    row.scrollLeft = 228;
    rerender(
      <ScrollSection id="x" title="Your stars" label="your stars" testId="stars">
        {rooms(['c', 'a', 'b'])}
      </ScrollSection>,
    );
    expect(row.scrollLeft).toBe(0);
  });

  it('leaves the row where it is when it had been scrolled before the cards changed', () => {
    const { rerender } = render(
      <ScrollSection id="x" title="Your stars" label="your stars" testId="stars">
        {rooms(['a', 'b', 'c'])}
      </ScrollSection>,
    );
    const row = screen.getByTestId('stars').querySelector('[data-back]') as HTMLElement;
    geometry(row, 228);
    act(() => {
      fireEvent.scroll(row);
    });
    rerender(
      <ScrollSection id="x" title="Your stars" label="your stars" testId="stars">
        {rooms(['c', 'a', 'b'])}
      </ScrollSection>,
    );
    expect(row.scrollLeft).toBe(228);
  });
});
