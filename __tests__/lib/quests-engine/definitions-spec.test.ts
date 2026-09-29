import { validateVersionSpec, type VersionSpec } from '@/lib/quests/engine/definitions';

const good: VersionSpec = {
  purpose: 'Meet someone',
  objectives: [{ key: 'hello', action: 'hello-exchanged', aggregation: 'STATE' }],
  rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: 'first-hello' }],
};

const paths = (spec: VersionSpec) => validateVersionSpec(spec).map((problem) => problem.path);

describe('validateVersionSpec', () => {
  it('accepts a runnable version', () => {
    expect(validateVersionSpec(good)).toEqual([]);
  });

  it('needs at least one objective, required for completion, with unique keys and a real action', () => {
    expect(paths({ ...good, objectives: [] })).toContain('objectives');
    expect(paths({ ...good, objectives: [{ ...good.objectives[0], requiredForCompletion: false }] })).toContain('objectives');
    expect(paths({ ...good, objectives: [good.objectives[0], good.objectives[0]] })).toContain('objectives[1].key');
    expect(paths({ ...good, objectives: [{ ...good.objectives[0], action: 'Hello World' }] })).toContain('objectives[0].action');
    expect(paths({ ...good, objectives: [{ ...good.objectives[0], threshold: 2 }] })).toContain('objectives[0].threshold');
    expect(paths({ ...good, objectives: [{ ...good.objectives[0], target: { kind: 'role', role: 'boss' } as never }] })).toContain('objectives[0].target');
  });

  it('bounds reward values by the evidence they ask for', () => {
    expect(paths({ ...good, rewards: [{ key: 'p', kind: 'POINTS', value: 10 }] })).toEqual([]);
    expect(paths({ ...good, rewards: [{ key: 'p', kind: 'POINTS', value: 11 }] })).toContain('rewards[0].value');
    expect(paths({ ...good, rewards: [{ key: 'p', kind: 'POINTS', value: 11, evidence: 'SERVER' }] })).toEqual([]);
    expect(paths({ ...good, rewards: [{ key: 'p', kind: 'POINTS', value: 0, evidence: 'SERVER' }] })).toContain('rewards[0].value');
    expect(paths({ ...good, rewards: [{ key: 'p', kind: 'POINTS', value: 1.5, evidence: 'SERVER' }] })).toContain('rewards[0].value');
  });

  it('a badge has an id and is worth one', () => {
    expect(paths({ ...good, rewards: [{ key: 'b', kind: 'BADGE' }] })).toContain('rewards[0].badgeId');
    expect(paths({ ...good, rewards: [{ key: 'b', kind: 'BADGE', badgeId: 'x', value: 2 }] })).toContain('rewards[0].value');
    expect(paths({ ...good, rewards: [{ key: 'p', kind: 'POINTS', badgeId: 'x' }] })).toContain('rewards[0].badgeId');
  });

  it('a rule tied to an objective names a real one whose evidence can cause it', () => {
    expect(paths({ ...good, rewards: [{ ...good.rewards![0], objectiveKey: 'missing' }] })).toContain('rewards[0].objectiveKey');
    expect(paths({ ...good, rewards: [{ ...good.rewards![0], objectiveKey: 'hello' }] })).toEqual([]);
    expect(paths({ ...good, rewards: [{ ...good.rewards![0], objectiveKey: 'hello', evidence: 'SERVER' }] })).toContain('rewards[0].evidence');
  });
});
