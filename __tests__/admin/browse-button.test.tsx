/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { BrowseButton } from '@/app/admin/components/place-hero';

function setReducedMotion(reduced: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({ matches: reduced && query.includes('prefers-reduced-motion'), media: query, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
}

describe('BrowseButton', () => {
  let scrollIntoView: jest.Mock;
  beforeEach(() => {
    scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    document.body.innerHTML = '';
  });

  it('scrolls smoothly to the list it names', () => {
    setReducedMotion(false);
    const { container } = render(<><BrowseButton label="Browse rooms" targetId="world-rooms-section" /><section id="world-rooms-section" /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse rooms' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('#world-rooms-section'));
  });

  it('jumps without animation when the person prefers reduced motion', () => {
    setReducedMotion(true);
    render(<><BrowseButton label="Browse worlds" targetId="universe-worlds-section" /><section id="universe-worlds-section" /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse worlds' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('does nothing when the list is not on the page', () => {
    setReducedMotion(false);
    render(<BrowseButton label="Browse rooms" targetId="missing" />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse rooms' }));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
