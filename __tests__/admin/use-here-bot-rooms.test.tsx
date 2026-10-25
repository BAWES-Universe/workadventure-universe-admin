/** @jest-environment jsdom */
/**
 * A room with only bots in it is left out of Live now, but the room, world and universe pages still count its bots.
 */

import { renderHook } from '@testing-library/react';
import type { LivePlace, LiveView } from '@/lib/live-presence';
import { useHere } from '@/app/admin/hooks/use-place-data';

const botsOnly: LivePlace = {
  roomId: 'r-workshop',
  name: 'Workshop',
  world: { id: 'w-1', name: 'Office' },
  universe: { id: 'u-1', name: 'Acme' },
  playPath: '/@/acme/office/workshop',
  count: 0,
  guests: 0,
  bots: 21,
  people: [],
  here: false,
};

let mockView: LiveView | null = null;
jest.mock('@/app/admin/hooks/use-live', () => ({ useLive: () => mockView }));

describe('useHere', () => {
  beforeEach(() => {
    mockView = { available: true, generatedAt: 1, places: [], botRooms: [botsOnly], people: [] };
  });

  it.each(['room', 'world', 'universe'] as const)('counts the bots of a bot-only room on its %s page', (scope) => {
    const id = scope === 'room' ? 'r-workshop' : scope === 'world' ? 'w-1' : 'u-1';
    const { result } = renderHook(() => useHere(scope, id));
    expect(result.current.known).toBe(true);
    expect(result.current.here).toMatchObject({ count: 0, bots: 21 });
    expect(result.current.byRoom.get('r-workshop')).toMatchObject({ count: 0, bots: 21 });
  });

  it('leaves another universe out', () => {
    const { result } = renderHook(() => useHere('universe', 'u-other'));
    expect(result.current.here).toMatchObject({ count: 0, bots: 0 });
  });
});
