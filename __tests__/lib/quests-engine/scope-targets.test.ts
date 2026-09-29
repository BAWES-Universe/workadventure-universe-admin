import { scopeApplies, scopeWhere, scopesOf, EMPTY_SCOPE_CHAIN } from '@/lib/quests/engine/scope';
import { parseTarget, targetMatches } from '@/lib/quests/engine/targets';

const chain = { roomId: 'r1', worldId: 'w1', universeId: 'u1' };

describe('scope', () => {
  it('a quest applies in its own scope and below, never across', () => {
    expect(scopeApplies({ scopeType: 'PLATFORM', scopeId: '' }, EMPTY_SCOPE_CHAIN)).toBe(true);
    expect(scopeApplies({ scopeType: 'UNIVERSE', scopeId: 'u1' }, chain)).toBe(true);
    expect(scopeApplies({ scopeType: 'WORLD', scopeId: 'w1' }, chain)).toBe(true);
    expect(scopeApplies({ scopeType: 'ROOM', scopeId: 'r1' }, chain)).toBe(true);
    expect(scopeApplies({ scopeType: 'ROOM', scopeId: 'r2' }, chain)).toBe(false);
    expect(scopeApplies({ scopeType: 'WORLD', scopeId: 'w1' }, EMPTY_SCOPE_CHAIN)).toBe(false);
    expect(scopeApplies({ scopeType: 'UNIVERSE', scopeId: '' }, { ...chain, universeId: '' })).toBe(false);
  });

  it('lists scopes nearest first and filters to the chain', () => {
    expect(scopesOf(chain).map((scope) => scope.scopeType)).toEqual(['ROOM', 'WORLD', 'UNIVERSE', 'PLATFORM']);
    expect(scopesOf(EMPTY_SCOPE_CHAIN)).toEqual([{ scopeType: 'PLATFORM', scopeId: '' }]);
    expect(scopeWhere({ roomId: null, worldId: null, universeId: 'u1' })).toEqual({
      OR: [{ scopeType: 'PLATFORM' }, { scopeType: 'UNIVERSE', scopeId: 'u1' }],
    });
  });
});

describe('targets', () => {
  it('parses an entity or the host role and nothing else', () => {
    expect(parseTarget({ kind: 'entity', id: 'bot-1' })).toEqual({ kind: 'entity', id: 'bot-1' });
    expect(parseTarget({ kind: 'role', role: 'host' })).toEqual({ kind: 'role', role: 'host' });
    expect(parseTarget({ kind: 'role', role: 'admin' })).toBeNull();
    expect(parseTarget({ kind: 'entity', id: '' })).toBeNull();
    expect(parseTarget('host')).toBeNull();
    expect(parseTarget(null)).toBeNull();
  });

  it('matches subjects to targets, with a bot named either way', () => {
    expect(targetMatches(null, null, null)).toBe(true);
    expect(targetMatches({ kind: 'entity', id: 'b1' }, 'b1', null)).toBe(true);
    expect(targetMatches({ kind: 'entity', id: 'b1' }, 'bot-b1', null)).toBe(true);
    expect(targetMatches({ kind: 'entity', id: 'b1' }, 'b2', null)).toBe(false);
    expect(targetMatches({ kind: 'role', role: 'host' }, 'bot-b1', { kind: 'bot', id: 'b1' })).toBe(true);
    expect(targetMatches({ kind: 'role', role: 'host' }, 'a1', { kind: 'area', id: 'a1' })).toBe(true);
    expect(targetMatches({ kind: 'role', role: 'host' }, 'b1', null)).toBe(false);
    expect(targetMatches({ kind: 'role', role: 'host' }, null, { kind: 'bot', id: 'b1' })).toBe(false);
  });
});
