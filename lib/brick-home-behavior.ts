import { homeBehaviorConfig } from '@/lib/bot-config-helpers';

export type HomeBehavior = { behaviorType?: 'idle' | 'patrol' | 'social'; behaviorConfig?: Record<string, unknown> };

const TYPES = ['idle', 'patrol', 'social'] as const;
const typeOf = (value: unknown): (typeof TYPES)[number] => (TYPES as readonly unknown[]).includes(value) ? (value as (typeof TYPES)[number]) : 'idle';

/**
 * What a home is written with when its owner places the Brick (game #2005). A Brick that already has a home in the same
 * room is being moved: what the request does not carry stays as it is (a patrol stays a patrol, with its route and
 * settings), and what it carries (its spot) is merged over it, as a manager's move does. A first home, or one moved from
 * another room (a route of another map means nothing here), is written from the request alone, idle when it says nothing.
 */
export function homeBehaviorForPlacement(
  existing: { roomId: string; behaviorType: string; behaviorConfig: unknown } | null,
  roomId: string,
  input: HomeBehavior
): { behaviorType: (typeof TYPES)[number]; behaviorConfig: Record<string, unknown> } {
  const sent = homeBehaviorConfig(input.behaviorConfig);
  if (!existing || existing.roomId !== roomId) return { behaviorType: input.behaviorType ?? 'idle', behaviorConfig: sent };
  return {
    behaviorType: input.behaviorType ?? typeOf(existing.behaviorType),
    behaviorConfig: input.behaviorConfig === undefined ? homeBehaviorConfig(existing.behaviorConfig) : { ...homeBehaviorConfig(existing.behaviorConfig), ...sent },
  };
}
