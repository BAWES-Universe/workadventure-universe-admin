import { snapDockIndex, swipeVelocity } from '@/app/admin/components/shell/dock-swipe';

describe('dock snapping', () => {
  it.each([
    [0.49, 0, 0], [0.51, 0, 1], [1.49, 0, 1], [1.51, 0, 2],
    [0.1, 0.6, 1], [1.1, 0.6, 2], [1.9, -0.6, 1], [0.9, -0.6, 0],
    [0, -1, 0], [2, 1, 2], [1, 0.6, 2], [1, -0.6, 0],
    [0.2, 0.4, 0], [1.8, -0.4, 2],
  ])('position %s at velocity %s lands on %s', (position, velocity, expected) => {
    expect(snapDockIndex(position, velocity, 3)).toBe(expected);
  });

  it('uses recent velocity in logical direction, ignoring old motion', () => {
    const samples = [{ x: 200, time: 0 }, { x: 50, time: 110 }, { x: 80, time: 150 }];
    expect(swipeVelocity(samples, 1)).toBe(0.75);
    expect(swipeVelocity(samples, -1)).toBe(-0.75);
  });

  it('does not flick after holding still, or with missing/equal timestamps', () => {
    expect(swipeVelocity([{ x: 0, time: 0 }, { x: 80, time: 50 }, { x: 80, time: 200 }], 1)).toBe(0);
    expect(swipeVelocity([{ x: 0, time: 1 }, { x: 80, time: 1 }], 1)).toBe(0);
    expect(swipeVelocity([], 1)).toBe(0);
  });
});
