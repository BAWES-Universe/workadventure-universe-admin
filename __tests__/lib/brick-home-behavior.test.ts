jest.mock('@/lib/db', () => ({ prisma: {} }));

import { homeBehaviorForPlacement } from '@/lib/brick-home-behavior';

const patrol = {
  roomId: 'room-1',
  behaviorType: 'patrol',
  behaviorConfig: { assignedSpace: { center: { x: 1, y: 2 }, radius: 80 }, patrolWaypoints: [{ x: 1, y: 2 }], wanderSpeed: 3, showToolCalls: true },
};
const spot = { assignedSpace: { center: { x: 64, y: 96 }, radius: 0 } };

describe('what a Brick’s home is written with when it is placed (game #2005)', () => {
  it('keeps a patrol or social home as it is when the same room is placed again with no behavior', () => {
    expect(homeBehaviorForPlacement(patrol, 'room-1', {})).toEqual({
      behaviorType: 'patrol',
      behaviorConfig: { assignedSpace: { center: { x: 1, y: 2 }, radius: 80 }, patrolWaypoints: [{ x: 1, y: 2 }], wanderSpeed: 3 },
    });
    expect(homeBehaviorForPlacement({ ...patrol, behaviorType: 'social' }, 'room-1', {}).behaviorType).toBe('social');
  });

  it('moves only the spot when the request carries just the spot: the route and settings stay, and idle is not made up', () => {
    const written = homeBehaviorForPlacement(patrol, 'room-1', { behaviorConfig: spot });
    expect(written.behaviorType).toBe('patrol');
    expect(written.behaviorConfig).toEqual({ assignedSpace: spot.assignedSpace, patrolWaypoints: [{ x: 1, y: 2 }], wanderSpeed: 3 });
  });

  it('takes the behavior the request names', () => {
    expect(homeBehaviorForPlacement(patrol, 'room-1', { behaviorType: 'idle', behaviorConfig: spot }).behaviorType).toBe('idle');
  });

  it('is idle with the request’s own spot for a first home, and for one moved from another room', () => {
    expect(homeBehaviorForPlacement(null, 'room-1', { behaviorConfig: spot })).toEqual({ behaviorType: 'idle', behaviorConfig: spot });
    expect(homeBehaviorForPlacement(patrol, 'room-2', { behaviorConfig: spot })).toEqual({ behaviorType: 'idle', behaviorConfig: spot });
  });

  it('reads an unknown stored type as idle', () => {
    expect(homeBehaviorForPlacement({ ...patrol, behaviorType: 'odd' }, 'room-1', {}).behaviorType).toBe('idle');
  });
});
