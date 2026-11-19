import { windDownWords } from '@/lib/capability-pause-words';

describe('the words for a wind-down', () => {
  it('says it is done only when no job and no machine is left, and says what is left until then', () => {
    expect(windDownWords(0, 0)).toBe('Wound down: every job ended and every machine stopped');
    expect(windDownWords(1, 0)).toBe('Winding down: 1 job still ending');
    expect(windDownWords(3, 2)).toBe('Winding down: 3 jobs still ending, 2 machines still stopping');
    expect(windDownWords(0, 1)).toBe('Winding down: 1 machine still stopping');
  });
});
