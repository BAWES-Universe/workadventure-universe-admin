import { z } from 'zod';

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const count = (max: number) => z.number().finite().min(0).max(max);

/**
 * What a home's behavior config may carry, each with its shape: where the Brick stands and how it moves there (game
 * #2005). The same bounds as the Brick page's editor. Keys outside this list are dropped (lib/bot-config-helpers.ts
 * `homeBehaviorConfig` keeps the same list), so what a room manager or the owner sends can only ever be a spot, a route
 * or how it walks up to people.
 */
export const homeBehaviorConfigSchema = z
  .object({
    assignedSpace: z.object({ center: point, radius: count(100000) }),
    moves: z.enum(['stay', 'wander', 'route']),
    goesToPeople: z.boolean(),
    facing: z.enum(['down', 'left', 'right', 'up']),
    patrolWaypoints: z.array(point).max(200),
    waypoints: z.array(point).max(200),
    loop: z.boolean(),
    pauseAtWaypoints: count(86_400),
    speed: count(1000),
    respondToPlayers: z.boolean(),
    conversationRadius: count(10000),
    minTimeBetweenConversations: count(86_400_000),
    maxConversationDuration: count(86_400_000),
    conversationHistorySize: count(1000),
    respectPlayerStatus: z.boolean(),
    maxConcurrentConversations: count(100),
    wanderSpeed: count(1000),
    approachDistance: count(10000),
  })
  .partial();
