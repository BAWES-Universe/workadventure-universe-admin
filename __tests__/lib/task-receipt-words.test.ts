import { actionWords, appLabel, NOTHING_TAKEN, OUTCOME_WORDS, outcomeNote } from '@/lib/task-receipt-words';

describe('the words for how a task came to end (mock M2)', () => {
  it('names the three outcomes as the mock does', () => {
    expect(OUTCOME_WORDS).toEqual({ done: 'Done', partial: 'Partly done', refunded: 'Refunded, nothing taken' });
    expect(NOTHING_TAKEN).toBe('Nothing taken');
  });

  it('says each action as the App’s name and how it went', () => {
    expect(actionWords('gmail', 'worked')).toBe('Gmail · worked');
    expect(actionWords('gmail', 'failed')).toBe("Gmail · didn't work");
    expect(appLabel('google_sheets')).toBe('Google sheets');
    expect(appLabel('')).toBe('App');
  });

  it('under a partly done receipt says how many worked and that nothing was taken for the rest', () => {
    const worked = { outcome: 'worked' as const };
    const failed = { outcome: 'failed' as const };
    expect(outcomeNote('partial', [worked, worked, failed])).toBe('Two steps worked and one didn’t. Nothing was taken for the one that didn’t.');
    expect(outcomeNote('partial', [worked, failed, failed])).toBe('One step worked and two didn’t. Nothing was taken for the ones that didn’t.');
    expect(outcomeNote('partial', Array.from({ length: 12 }, (_, i) => (i === 0 ? failed : worked)))).toBe('11 steps worked and one didn’t. Nothing was taken for the one that didn’t.');
  });

  it('has no sentence for any other outcome', () => {
    expect(outcomeNote('done', [{ outcome: 'worked' }])).toBeNull();
    expect(outcomeNote('refunded', [{ outcome: 'failed' }])).toBeNull();
  });
});
