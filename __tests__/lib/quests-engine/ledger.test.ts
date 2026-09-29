import { openObjectives, questComplete, type LoadedProgress } from '@/lib/quests/engine/ledger';

type Obj = { id: string; action: string; anyOfGroup: string | null; requiredForCompletion: boolean };

function progress(objectives: Obj[], satisfied: string[]): LoadedProgress {
  return {
    version: { objectives },
    objectives: satisfied.map((objectiveId) => ({ objectiveId, satisfiedAt: new Date() })),
  } as unknown as LoadedProgress;
}

describe('any-of groups', () => {
  const group: Obj[] = [
    { id: 'a', action: 'x', anyOfGroup: 'g', requiredForCompletion: true },
    { id: 'b', action: 'y', anyOfGroup: 'g', requiredForCompletion: true },
    { id: 'c', action: 'z', anyOfGroup: null, requiredForCompletion: false },
  ];

  it('one member meets the group, closes the others, and completes the quest', () => {
    const done = progress(group, ['b']);
    expect(openObjectives(done, 'x')).toEqual([]);
    expect(questComplete(done)).toBe(true);
    expect(questComplete(progress(group, []))).toBe(false);
    expect(questComplete(progress(group, ['c']))).toBe(false);
  });

  it('a group closed by any member never leaves the quest unable to complete', () => {
    // A mixed group is refused at publish time; if one exists anyway, the member that closed it also completes it.
    const mixed: Obj[] = [
      { id: 'a', action: 'x', anyOfGroup: 'g', requiredForCompletion: true },
      { id: 'b', action: 'y', anyOfGroup: 'g', requiredForCompletion: false },
    ];
    const closed = progress(mixed, ['b']);
    expect(openObjectives(closed, 'x')).toEqual([]);
    expect(questComplete(closed)).toBe(true);
  });

  it('an optional group does not hold completion back', () => {
    const optional: Obj[] = [
      { id: 'a', action: 'x', anyOfGroup: null, requiredForCompletion: true },
      { id: 'b', action: 'y', anyOfGroup: 'g', requiredForCompletion: false },
    ];
    expect(questComplete(progress(optional, ['a']))).toBe(true);
  });
});
