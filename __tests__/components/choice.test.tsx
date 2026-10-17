/** @jest-environment jsdom */

import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PickCard, PickChip, Radio, RolePill, Segmented, Swatch } from '@/components/ui/choice';

it('Radio is a picture only: hidden from assistive tech, dot when on', () => {
  const { container, rerender } = render(<Radio checked={false} />);
  expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  expect(container.firstElementChild?.children).toHaveLength(0);
  rerender(<Radio checked />);
  expect(container.firstElementChild?.children).toHaveLength(1);
});

describe('PickCard', () => {
  it('is a toggle button by default', () => {
    const onClick = jest.fn();
    render(<PickCard picked title="Moderator" description="Handles reports" onClick={onClick} />);
    const card = screen.getByRole('button', { name: /Moderator/ });
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(card.hasAttribute('aria-checked')).toBe(false);
    expect(card.getAttribute('type')).toBe('button');
    expect(screen.getByText('Handles reports')).toBeTruthy();
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalled();
  });

  it('carries aria-checked as a radio, with the indicator and extra content inside', () => {
    render(
      <PickCard role="radio" picked={false} title="Member" indicator={<Radio checked={false} />}>
        <span>extra</span>
      </PickCard>,
    );
    const card = screen.getByRole('radio', { name: /Member/ });
    expect(card.getAttribute('aria-checked')).toBe('false');
    expect(card.hasAttribute('aria-pressed')).toBe(false);
    expect(card.textContent).toContain('extra');
  });

  it('is at least 44px tall', () => {
    render(<PickCard picked={false} title="Member" />);
    expect(screen.getByRole('button').className).toContain('min-h-11');
  });
});

it('PickChip toggles with aria-pressed and shows a tick only when picked', () => {
  const { container, rerender } = render(<PickChip picked={false}>Editor</PickChip>);
  const chip = screen.getByRole('button', { name: 'Editor' });
  expect(chip.getAttribute('aria-pressed')).toBe('false');
  expect(container.querySelector('svg')).toBeNull();
  expect(chip.className).toContain('h-11');
  rerender(<PickChip picked color="#34d399">Editor</PickChip>);
  expect(screen.getByRole('button', { name: 'Editor' }).getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('svg')).not.toBeNull();
  expect(container.querySelector('i')?.getAttribute('style')).toContain('background');
});

describe('Segmented', () => {
  function Form({ onChange = jest.fn() }) {
    const [value, setValue] = useState<'all' | 'some'>('all');
    return (
      <Segmented
        aria-label="Works in"
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        options={[
          { value: 'all', label: 'All worlds' },
          { value: 'some', label: 'Some worlds' },
        ]}
      />
    );
  }

  it('is a radiogroup with one picked radio and one tab stop', () => {
    render(<Form />);
    expect(screen.getByRole('radiogroup', { name: 'Works in' })).toBeTruthy();
    const [all, some] = screen.getAllByRole('radio');
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(some.getAttribute('aria-checked')).toBe('false');
    expect(all.tabIndex).toBe(0);
    expect(some.tabIndex).toBe(-1);
  });

  it('picks on click and with the arrow keys, moving focus', () => {
    const onChange = jest.fn();
    render(<Form onChange={onChange} />);
    const [all, some] = screen.getAllByRole('radio');
    fireEvent.click(some);
    expect(onChange).toHaveBeenLastCalledWith('some');
    expect(some.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(some, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('all');
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(all, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('some');
  });

  it('skips a disabled segment', () => {
    const onChange = jest.fn();
    render(
      <Segmented
        aria-label="Kind"
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
          { value: 'c', label: 'C' },
        ]}
      />,
    );
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('c');
  });
});

it('RolePill shows the name with a dot in the role colour, or none', () => {
  const { container, rerender } = render(<RolePill name="Moderator" color="rgb(1, 2, 3)" />);
  expect(screen.getByText('Moderator')).toBeTruthy();
  expect(container.querySelector('i')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('i')?.getAttribute('style')).toContain('rgb(1, 2, 3)');
  rerender(<RolePill name="+2" />);
  expect(container.querySelector('i')).toBeNull();
});

it('Swatch is a named radio, ringed when picked', () => {
  const onClick = jest.fn();
  const { rerender } = render(
    <div role="radiogroup" aria-label="Colour">
      <Swatch color="#8629fc" picked={false} label="Violet" onClick={onClick} />
    </div>,
  );
  const swatch = screen.getByRole('radio', { name: 'Violet' });
  expect(swatch.getAttribute('aria-checked')).toBe('false');
  expect(swatch.className).not.toContain('0_0_0_4px');
  fireEvent.click(swatch);
  expect(onClick).toHaveBeenCalled();
  rerender(
    <div role="radiogroup" aria-label="Colour">
      <Swatch color="#8629fc" picked label="Violet" onClick={onClick} />
    </div>,
  );
  expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('radio', { name: 'Violet' }).className).toContain('0_0_0_4px');
});

describe('Segmented tab stop', () => {
  it('falls back to the first enabled option when the picked one is disabled, so the group can be tabbed into', () => {
    render(
      <Segmented
        aria-label="Works in"
        value="all"
        onChange={() => {}}
        options={[
          { value: 'all', label: 'All worlds', disabled: true },
          { value: 'some', label: 'Some worlds' },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'All worlds' }).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('radio', { name: 'Some worlds' }).getAttribute('tabindex')).toBe('0');
  });
});

