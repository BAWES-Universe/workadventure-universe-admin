import { actionWords, appLabel, dollarsOf, NOTHING_TAKEN, OUTCOME_WORDS, outcomeNote, unconfirmedActionWords, unconfirmedWords } from '@/lib/task-receipt-words';

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

describe('the words for an App whose result could not be confirmed', () => {
  it('says we could not confirm it and are releasing the hold while the credit is still reserved, never refunded or nothing taken', () => {
    expect(unconfirmedWords(['exa'], true, 0)).toBe("We couldn't confirm whether Exa finished. We're releasing your hold.");
    expect(unconfirmedWords(['exa', 'gmail'], true, 0)).toBe("We couldn't confirm whether Exa and Gmail finished. We're releasing your hold.");
    expect(unconfirmedWords(['exa', 'exa'], true, 0)).toBe("We couldn't confirm whether Exa finished. We're releasing your hold.");
  });

  it('shows the amount released once the books have said so, and keeps delivery unknown', () => {
    expect(unconfirmedWords(['exa'], false, 7_600)).toBe("We couldn't confirm whether Exa finished. Your hold of $0.0076 was released.");
    expect(unconfirmedWords(['exa'], false, 0)).toBe("We couldn't confirm whether Exa finished. Your hold was released.");
    expect(unconfirmedActionWords('exa')).toBe("Exa · couldn't confirm");
  });

  it('writes whole micros as dollars with at least two decimals', () => {
    expect(dollarsOf(7_600)).toBe('$0.0076');
    expect(dollarsOf(1_000_000)).toBe('$1.00');
    expect(dollarsOf(1_500_000)).toBe('$1.50');
    expect(dollarsOf(992_400)).toBe('$0.9924');
    expect(dollarsOf(1)).toBe('$0.000001');
  });
});
