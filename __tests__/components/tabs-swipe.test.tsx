/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// jsdom has no PointerEvent or capture; keep real bubbling and set the fields the swipe reads.
function pointer(target: Element, type: string, x: number, time: number, extras: Record<string, unknown> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.entries({ pointerId: 1, isPrimary: true, button: 0, pointerType: 'touch', clientX: x, clientY: 300, timeStamp: time + 10000, ...extras })
    .forEach(([key, value]) => Object.defineProperty(event, key, { value }));
  fireEvent(target, event);
}

function setup(onValueChange = jest.fn(), defaultValue = 'b') {
  const view = render(
    <Tabs defaultValue={defaultValue} onValueChange={onValueChange}>
      <TabsList aria-label="Sections">
        <TabsTrigger value="a">One</TabsTrigger>
        <TabsTrigger value="b">Two</TabsTrigger>
        <TabsTrigger value="c">Three</TabsTrigger>
      </TabsList>
      <TabsContent value="a">First</TabsContent>
      <TabsContent value="b">Second</TabsContent>
      <TabsContent value="c">Third</TabsContent>
    </Tabs>,
  );
  const list = screen.getByRole('tablist') as HTMLDivElement;
  // Three 100px tabs. jsdom computes no padding, so say so.
  list.style.padding = '0px';
  Object.defineProperty(list, 'scrollWidth', { value: 300, configurable: true });
  Object.defineProperty(list, 'clientWidth', { value: 300 });
  list.setPointerCapture = jest.fn();
  list.hasPointerCapture = jest.fn(() => true);
  list.releasePointerCapture = jest.fn();
  return { ...view, list, onValueChange };
}

const selected = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent;

it('keeps Radix behaviour: click selects, arrows move', async () => {
  const { onValueChange } = setup();
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Three' }));
  expect(selected()).toBe('Three');
  expect(onValueChange).toHaveBeenCalledWith('c');
  expect(screen.getByText('Third')).toBeTruthy();
  act(() => screen.getByRole('tab', { name: 'Three' }).focus());
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Three' }), { key: 'ArrowLeft' });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Two' })));
  expect(selected()).toBe('Two');
});

it('marks the current tab for the gradient look', () => {
  setup();
  expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('data-current')).toBe('true');
  expect(screen.getByRole('tab', { name: 'One' }).getAttribute('data-current')).toBe('false');
});

it('a touch drag follows the finger and lands on the next tab', () => {
  const { list, onValueChange } = setup();
  pointer(list, 'pointerdown', 150, 0);
  pointer(list, 'pointermove', 245, 300);
  // 95px of 100px per tab: the third tab is under the finger, the second is not.
  expect(list.dataset.dragging).toBe('true');
  expect(screen.getByRole('tab', { name: 'Three' }).getAttribute('data-current')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('data-current')).toBe('false');
  pointer(list, 'pointerup', 245, 450);
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(onValueChange).toHaveBeenCalledWith('c');
  expect(selected()).toBe('Three');
});

it('a quick flick moves one tab even when it is short, towards the flick', () => {
  const { list, onValueChange } = setup();
  pointer(list, 'pointerdown', 150, 0);
  pointer(list, 'pointermove', 120, 30);
  pointer(list, 'pointerup', 100, 60);
  expect(onValueChange).toHaveBeenCalledWith('a');
});

it('does not move past the first or last tab', () => {
  const { list, onValueChange } = setup(jest.fn(), 'c');
  pointer(list, 'pointerdown', 100, 0);
  pointer(list, 'pointermove', 190, 300);
  pointer(list, 'pointerup', 190, 450);
  expect(onValueChange).not.toHaveBeenCalled();
  expect(selected()).toBe('Three');
});

it('a mouse drag does nothing: desktop stays click and keyboard', () => {
  const { list, onValueChange } = setup();
  pointer(list, 'pointerdown', 150, 0, { pointerType: 'mouse' });
  pointer(list, 'pointermove', 280, 300, { pointerType: 'mouse' });
  pointer(list, 'pointerup', 280, 450, { pointerType: 'mouse' });
  expect(list.dataset.dragging).toBeUndefined();
  expect(onValueChange).not.toHaveBeenCalled();
});

it('a vertical scroll is not a swipe', () => {
  const { list, onValueChange } = setup();
  pointer(list, 'pointerdown', 150, 0);
  pointer(list, 'pointermove', 160, 100, { clientY: 340 });
  pointer(list, 'pointerup', 160, 200, { clientY: 340 });
  expect(onValueChange).not.toHaveBeenCalled();
});

it('blocks the press that trails a swipe, so it cannot undo it', () => {
  const { list, onValueChange } = setup();
  pointer(list, 'pointerdown', 150, 0);
  pointer(list, 'pointermove', 245, 300);
  pointer(list, 'pointerup', 245, 450);
  const trailing = new Event('mousedown', { bubbles: true, cancelable: true });
  Object.defineProperty(trailing, 'detail', { value: 1 });
  Object.defineProperty(trailing, 'button', { value: 0 });
  Object.defineProperty(trailing, 'timeStamp', { value: 10451 });
  fireEvent(screen.getByRole('tab', { name: 'Two' }), trailing);
  expect(trailing.defaultPrevented).toBe(true);
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(selected()).toBe('Three');
});

it('follows a controlled value', () => {
  const view = render(
    <Tabs value="a" onValueChange={() => {}}>
      <TabsList>
        <TabsTrigger value="a">One</TabsTrigger>
        <TabsTrigger value="b">Two</TabsTrigger>
      </TabsList>
    </Tabs>,
  );
  expect(selected()).toBe('One');
  view.rerender(
    <Tabs value="b" onValueChange={() => {}}>
      <TabsList>
        <TabsTrigger value="a">One</TabsTrigger>
        <TabsTrigger value="b">Two</TabsTrigger>
      </TabsList>
    </Tabs>,
  );
  expect(selected()).toBe('Two');
});

describe('a bar with more tabs than fit', () => {
  function overflowing() {
    const view = setup();
    // Six tabs' worth in a three-tab space, scrolled to the start; a scroll makes the bar measure itself again.
    Object.defineProperty(view.list, 'scrollWidth', { value: 600 });
    fireEvent.scroll(view.list);
    return view;
  }

  it('scrolls sideways instead of making the page wider', () => {
    const { list } = overflowing();
    expect(list.dataset.scrolls).toBe('true');
    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('[contain:inline-size]');
    // A finger drag is the browser's to scroll the strip
    expect(list.className).toContain('touch-manipulation');
    expect(list.className).not.toContain('touch-pan-y');
    // More tabs past the right edge, none past the left: only the right edge fades
    expect(list.className).toContain('[mask-image:linear-gradient(to_left,transparent,#000_2rem)]');
  });

  it('a touch drag scrolls the strip and does not switch tabs', () => {
    const { list, onValueChange } = overflowing();
    // Far enough to be a whole tab and more, however wide the tabs are measured
    pointer(list, 'pointerdown', 20, 0);
    pointer(list, 'pointermove', 290, 300);
    pointer(list, 'pointerup', 290, 450);
    expect(list.dataset.dragging).toBeUndefined();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(selected()).toBe('Two');
  });

  it('fades both edges once scrolled into the middle', () => {
    const { list } = overflowing();
    list.scrollLeft = 150;
    fireEvent.scroll(list);
    expect(list.className).toContain('[mask-image:linear-gradient(to_right,transparent,#000_2rem,#000_calc(100%-2rem),transparent)]');
  });

  it('a bar that fits keeps the tab swipe and no fade', () => {
    const { list } = setup();
    fireEvent.scroll(list);
    expect(list.dataset.scrolls).toBeUndefined();
    expect(list.className).toContain('touch-pan-y');
    expect(list.className).not.toContain('mask-image');
  });
});
