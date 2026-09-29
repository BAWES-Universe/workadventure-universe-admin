import { advance, evidenceStep, minimalEvidence, validThreshold } from '@/lib/quests/engine/aggregation';
import { MAX_COUNTER_STEP, MAX_DURATION_STEP_SECONDS } from '@/lib/quests/engine/limits';

describe('evidenceStep', () => {
  it('a state, an event and a distinct entity are each worth one, whatever the evidence says', () => {
    expect(evidenceStep({ aggregation: 'STATE' }, null)).toBe(1);
    expect(evidenceStep({ aggregation: 'EVENT_COUNT' }, { amount: 50 })).toBe(1);
    expect(evidenceStep({ aggregation: 'UNIQUE_SET' }, { seconds: 9 })).toBe(1);
  });

  it('a duration takes whole positive seconds up to the bound', () => {
    expect(evidenceStep({ aggregation: 'DURATION' }, { seconds: 30 })).toBe(30);
    expect(evidenceStep({ aggregation: 'DURATION' }, { seconds: MAX_DURATION_STEP_SECONDS })).toBe(MAX_DURATION_STEP_SECONDS);
    expect(evidenceStep({ aggregation: 'DURATION' }, { seconds: MAX_DURATION_STEP_SECONDS + 1 })).toBeNull();
    expect(evidenceStep({ aggregation: 'DURATION' }, { seconds: 0 })).toBeNull();
    expect(evidenceStep({ aggregation: 'DURATION' }, { seconds: -5 })).toBeNull();
    expect(evidenceStep({ aggregation: 'DURATION' }, { seconds: 1.5 })).toBeNull();
    expect(evidenceStep({ aggregation: 'DURATION' }, { seconds: Number.POSITIVE_INFINITY })).toBeNull();
    expect(evidenceStep({ aggregation: 'DURATION' }, null)).toBeNull();
  });

  it('a counter takes whole positive units up to the bound', () => {
    expect(evidenceStep({ aggregation: 'COUNTER' }, { amount: 3 })).toBe(3);
    expect(evidenceStep({ aggregation: 'COUNTER' }, { amount: MAX_COUNTER_STEP + 1 })).toBeNull();
    expect(evidenceStep({ aggregation: 'COUNTER' }, { seconds: 3 })).toBeNull();
  });
});

describe('advance', () => {
  it('never passes the threshold and says when it is met', () => {
    expect(advance({ aggregation: 'COUNTER', threshold: 10 }, 4, 3)).toEqual({ count: 7, satisfied: false });
    expect(advance({ aggregation: 'COUNTER', threshold: 10 }, 8, 100)).toEqual({ count: 10, satisfied: true });
    expect(advance({ aggregation: 'STATE', threshold: 1 }, 0, 1)).toEqual({ count: 1, satisfied: true });
    expect(advance({ aggregation: 'COUNTER', threshold: 10 }, -3, -3)).toEqual({ count: 0, satisfied: false });
  });
});

describe('validThreshold', () => {
  it('bounds thresholds by aggregation', () => {
    expect(validThreshold('STATE', 1)).toBe(true);
    expect(validThreshold('STATE', 2)).toBe(false);
    expect(validThreshold('EVENT_COUNT', 10_000)).toBe(true);
    expect(validThreshold('EVENT_COUNT', 10_001)).toBe(false);
    expect(validThreshold('DURATION', 0)).toBe(false);
    expect(validThreshold('COUNTER', '5')).toBe(false);
  });
});

describe('minimalEvidence', () => {
  it('keeps only the typed fields and drops everything else', () => {
    expect(minimalEvidence({ seconds: 5, amount: 2, objectiveId: 'x', text: 'hi' })).toEqual({ seconds: 5, amount: 2 });
    expect(minimalEvidence({ seconds: 'five' })).toBeNull();
    expect(minimalEvidence({ seconds: Number.NaN })).toBeNull();
    expect(minimalEvidence(['seconds'])).toBeNull();
    expect(minimalEvidence(null)).toBeNull();
  });
});
