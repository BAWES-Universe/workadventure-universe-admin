import type { Prisma, QuestScopeType } from '@prisma/client';
import type { QuestDb } from './db';

/** Where an action happened, from the room outwards. A platform quest applies everywhere. */
export interface ScopeChain {
  roomId: string | null;
  worldId: string | null;
  universeId: string | null;
}

export const EMPTY_SCOPE_CHAIN: ScopeChain = { roomId: null, worldId: null, universeId: null };

/** A scope as the ledger stores it: the platform's id is "". */
export interface QuestScope {
  scopeType: QuestScopeType;
  scopeId: string;
}

export const PLATFORM_SCOPE_ID = '';

/** The room's world and universe, or an empty chain when the room does not exist. */
export async function scopeChainForRoom(db: QuestDb, roomId: string | null | undefined): Promise<ScopeChain> {
  if (!roomId) return EMPTY_SCOPE_CHAIN;
  const room = await db.room.findUnique({
    where: { id: roomId },
    select: { id: true, worldId: true, world: { select: { universeId: true } } },
  });
  if (!room) return EMPTY_SCOPE_CHAIN;
  return { roomId: room.id, worldId: room.worldId, universeId: room.world.universeId };
}

/** Whether a quest of this scope applies to an action in this chain. */
export function scopeApplies(scope: QuestScope, chain: ScopeChain): boolean {
  switch (scope.scopeType) {
    case 'PLATFORM':
      return true;
    case 'UNIVERSE':
      return scope.scopeId !== '' && scope.scopeId === chain.universeId;
    case 'WORLD':
      return scope.scopeId !== '' && scope.scopeId === chain.worldId;
    case 'ROOM':
      return scope.scopeId !== '' && scope.scopeId === chain.roomId;
  }
}

/** The definitions that apply in a chain, as a Prisma filter. */
export function scopeWhere(chain: ScopeChain): Prisma.QuestDefinitionWhereInput {
  const or: Prisma.QuestDefinitionWhereInput[] = [{ scopeType: 'PLATFORM' }];
  if (chain.universeId) or.push({ scopeType: 'UNIVERSE', scopeId: chain.universeId });
  if (chain.worldId) or.push({ scopeType: 'WORLD', scopeId: chain.worldId });
  if (chain.roomId) or.push({ scopeType: 'ROOM', scopeId: chain.roomId });
  return { OR: or };
}

/** The scopes of a chain from the nearest outwards: room, world, universe, platform. */
export function scopesOf(chain: ScopeChain): QuestScope[] {
  const scopes: QuestScope[] = [];
  if (chain.roomId) scopes.push({ scopeType: 'ROOM', scopeId: chain.roomId });
  if (chain.worldId) scopes.push({ scopeType: 'WORLD', scopeId: chain.worldId });
  if (chain.universeId) scopes.push({ scopeType: 'UNIVERSE', scopeId: chain.universeId });
  scopes.push({ scopeType: 'PLATFORM', scopeId: PLATFORM_SCOPE_ID });
  return scopes;
}
