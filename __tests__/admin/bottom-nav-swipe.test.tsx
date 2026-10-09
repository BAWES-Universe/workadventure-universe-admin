/** @jest-environment jsdom */

import React from 'react';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { BottomNav } from '@/app/admin/components/shell/bottom-nav';

const mockPush = jest.fn();
let mockRoot = '/admin';
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/app/admin/orbit-frame-context', () => ({
  useOrbitFrame: () => ({ section: mockRoot, route: { parent: null } }),
}));
jest.mock('@/app/admin/components/shell/attention-badge', () => ({
  AttentionBadge: () => null,
  useAttentionCount: () => 0,
}));

// jsdom has no PointerEvent/capture implementation. Preserve real event bubbling and cancellation.
function pointer(target: Element, type: string, x: number, time: number, extras: Record<string, unknown> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  // React treats a zero timestamp as missing, so start the simulated clock above zero.
  Object.entries({ pointerId: 1, isPrimary: true, button: 0, pointerType: 'touch', clientX: x, clientY: 700, timeStamp: time + 10000, ...extras })
    .forEach(([key, value]) => Object.defineProperty(event, key, { value }));
  fireEvent(target, event);
}

function setup(direction = 'ltr') {
  const view = render(<BottomNav />);
  const track = screen.getByRole('navigation').firstElementChild as HTMLDivElement;
  track.style.padding = '8px';
  track.style.direction = direction;
  Object.defineProperty(track, 'clientWidth', { value: 316 });
  track.setPointerCapture = jest.fn();
  track.hasPointerCapture = jest.fn(() => true);
  track.releasePointerCapture = jest.fn();
  return { ...view, track };
}

beforeEach(() => {
  mockPush.mockClear();
  mockRoot = '/admin';
});

it('tracks the finger, navigates once on release, and blocks the trailing link click', () => {
  const { track } = setup();
  pointer(track, 'pointerdown', 150, 0);
  pointer(track, 'pointermove', 215, 300);
  expect(track.dataset.dragging).toBe('true');
  expect(track.style.getPropertyValue('--dock-position')).toBe('1.65');
  expect(track.setPointerCapture).toHaveBeenCalledWith(1);
  pointer(track, 'pointerup', 215, 450);
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/admin/space');
  expect(track.dataset.dragging).toBeUndefined();
  const click = createEvent.click(screen.getByRole('link', { name: 'You' }), { detail: 1 });
  Object.defineProperty(click, 'timeStamp', { value: 10451 });
  fireEvent(screen.getByRole('link', { name: 'You' }), click);
  expect(click.defaultPrevented).toBe(true);
  expect(mockPush).toHaveBeenCalledTimes(1);
});

it('keeps native taps under 6px, keyboard activation, and fresh taps after a drag', () => {
  const { track } = setup();
  const you = screen.getByRole('link', { name: 'You' });
  const clicks: boolean[] = [];
  // Observe whether the capture handler allows activation before preventing jsdom navigation.
  you.addEventListener('click', (event) => { clicks.push(event.defaultPrevented); event.preventDefault(); });
  pointer(you, 'pointerdown', 100, 0);
  pointer(you, 'pointermove', 105, 10);
  pointer(you, 'pointerup', 105, 20);
  expect(track.setPointerCapture).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  fireEvent.click(you, { detail: 1 });
  pointer(track, 'pointerdown', 150, 100);
  pointer(track, 'pointermove', 160, 200);
  pointer(track, 'pointerup', 160, 350);
  const keyboardClick = createEvent.click(you, { detail: 0 });
  Object.defineProperty(keyboardClick, 'timeStamp', { value: 10351 });
  fireEvent(you, keyboardClick);
  pointer(you, 'pointerdown', 100, 360);
  pointer(you, 'pointerup', 100, 370);
  const freshClick = createEvent.click(you, { detail: 1 });
  Object.defineProperty(freshClick, 'timeStamp', { value: 10371 });
  fireEvent(you, freshClick);
  expect(clicks).toEqual([false, false, false]);
});

it.each([['ltr', 215], ['rtl', 85]])('follows %s layout toward Space', (direction, x) => {
  const { track } = setup(direction);
  pointer(track, 'pointerdown', 150, 0);
  pointer(track, 'pointermove', x, 200);
  pointer(track, 'pointerup', x, 400);
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/admin/space');
});

it('flicks to the next tab before halfway, but a hold snaps back without navigating', () => {
  const { track } = setup();
  pointer(track, 'pointerdown', 150, 0);
  pointer(track, 'pointermove', 170, 20);
  pointer(track, 'pointerup', 180, 40);
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/admin/space');
  mockPush.mockClear();
  pointer(track, 'pointerdown', 150, 1000);
  pointer(track, 'pointermove', 170, 1020);
  pointer(track, 'pointerup', 170, 1200);
  expect(mockPush).not.toHaveBeenCalled();
});

it.each([10, 1014])('leaves the viewport edge at %s to the browser', (x) => {
  const { track } = setup();
  pointer(track, 'pointerdown', x, 0);
  pointer(track, 'pointermove', 180, 100);
  pointer(track, 'pointerup', 180, 200);
  expect(track.setPointerCapture).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

it('leaves vertical intent alone even if the finger later moves sideways', () => {
  const { track } = setup();
  pointer(track, 'pointerdown', 150, 0);
  pointer(track, 'pointermove', 154, 100, { clientY: 715 });
  pointer(track, 'pointermove', 250, 200, { clientY: 720 });
  pointer(track, 'pointerup', 250, 300);
  expect(track.setPointerCapture).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

it.each(['pointercancel', 'lostpointercapture'])('resets on %s without navigating', (type) => {
  const { track } = setup();
  pointer(track, 'pointerdown', 150, 0);
  pointer(track, 'pointermove', 240, 100);
  pointer(track, type, 240, 200);
  pointer(track, 'pointerup', 240, 300);
  expect(track.dataset.dragging).toBeUndefined();
  expect(mockPush).not.toHaveBeenCalled();
});

it('ignores capture transferred from the touched link and unrelated pointers', () => {
  const { track } = setup();
  const orbit = screen.getByRole('link', { name: 'Orbit' });
  pointer(orbit, 'pointerdown', 150, 0);
  pointer(orbit, 'pointermove', 240, 100);
  pointer(orbit, 'lostpointercapture', 240, 101);
  pointer(track, 'pointermove', 40, 110, { pointerId: 2, isPrimary: false });
  pointer(track, 'pointerup', 240, 300);
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/admin/space');
});

it('abandons a gesture when the route changes underneath it', () => {
  const { track, rerender } = setup();
  pointer(track, 'pointerdown', 150, 0);
  pointer(track, 'pointermove', 240, 100);
  mockRoot = '/admin/you';
  rerender(<BottomNav />);
  pointer(track, 'pointerup', 240, 300);
  expect(mockPush).not.toHaveBeenCalled();
  expect(track.style.getPropertyValue('--dock-position')).toBe('0');
});
