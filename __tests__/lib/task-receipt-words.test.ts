import { actionWords, appLabel, dollars, HOLD_BEING_RELEASED, NOTHING_TAKEN, OUTCOME_WORDS, outcomeNote } from '@/lib/task-receipt-words';

describe('the words for how a task came to end (mock M2)', () => {
  it('names the outcomes as the mock does, and the two it did not have: a task that did not finish but took something, and one nobody could confirm', () => {
    expect(OUTCOME_WORDS).toEqual({ done: 'Done', partial: 'Partly done', refunded: 'Refunded, nothing taken', failed: 'Didn’t finish', unconfirmed: 'Couldn’t confirm' });
    expect(NOTHING_TAKEN).toBe('Nothing taken');
    expect(HOLD_BEING_RELEASED).toBe('Hold being released');
  });

  it('says each action as the App’s name and how it went', () => {
    expect(actionWords('gmail', 'worked')).toBe('Gmail · worked');
    expect(actionWords('gmail', 'failed')).toBe("Gmail · didn't work");
    expect(actionWords('gmail', 'unknown')).toBe('Gmail · couldn’t confirm delivery');
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

  it('says what the computer took and what each App took, as dollars, when a task did not finish', () => {
    expect(outcomeNote('failed', [{ outcome: 'failed', label: 'gmail' }], { job: 'failed', computerMicros: 30_000 })).toBe('It didn’t finish. Computer time used $0.03. Gmail charged $0.');
    expect(outcomeNote('failed', [], { job: 'failed', computerMicros: 20_000 })).toBe('It didn’t finish. Computer time used $0.02.');
    expect(outcomeNote('failed', [], { job: 'failed', computerMicros: null })).toBe('It didn’t finish. Computer time price not known yet.');
    expect(outcomeNote('partial', [{ outcome: 'failed', label: 'gmail' }], { job: 'worked', computerMicros: 30_000 })).toBe('One step worked and one didn’t. Computer time used $0.03. Gmail charged $0.');
  });

  it('says an action nobody could confirm as exactly that, never as a failure', () => {
    expect(outcomeNote('unconfirmed', [{ outcome: 'unknown', label: 'gmail' }])).toBe('We couldn’t confirm that Gmail finished. Nothing was taken for it.');
    expect(outcomeNote('partial', [{ outcome: 'worked' }, { outcome: 'unknown', label: 'gmail' }])).toBe('One step worked and one couldn’t be confirmed. Nothing was taken for it.');
    expect(outcomeNote('partial', [{ outcome: 'worked' }, { outcome: 'failed' }, { outcome: 'unknown', label: 'gmail' }])).toBe('One step worked and one didn’t and one couldn’t be confirmed. Nothing was taken for them.');
    expect(outcomeNote('unconfirmed', [{ outcome: 'unknown', label: 'exa' }], { holdPending: true })).toBe('We couldn’t confirm that Exa finished. We’re releasing your hold.');
  });

  it('writes dollars the way a reader says them', () => {
    expect(dollars(0)).toBe('$0');
    expect(dollars(30_000)).toBe('$0.03');
    expect(dollars(1_200)).toBe('less than $0.01');
    expect(dollars(1_250_000)).toBe('$1.25');
  });
});
