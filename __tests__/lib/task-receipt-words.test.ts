import { actionWords, appLabel, dollars, HOLD_BEING_RELEASED, HOLD_RELEASED, NOTHING_TAKEN, OUTCOME_WORDS, outcomeNote, outcomeTextOf, SETTLEMENT_PENDING, STOPPED_AT_RULE } from '@/lib/task-receipt-words';

describe('the words for how a task came to end (mock M2)', () => {
  it('names the outcomes as the mock does, and the two it did not have: a task that did not finish but took something, and one nobody could confirm', () => {
    expect(OUTCOME_WORDS).toEqual({ done: 'Done', partial: 'Partly done', refunded: 'Refunded, nothing taken', failed: 'Didn’t finish', unconfirmed: 'Couldn’t confirm', stopped: 'Stopped', deciding: 'Still deciding', refund_pending: 'Refund pending' });
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
    expect(outcomeNote('unconfirmed', [{ outcome: 'unknown', label: 'gmail' }])).toBe('We couldn’t confirm whether Gmail finished. Nothing was taken for it.');
    expect(outcomeNote('partial', [{ outcome: 'worked' }, { outcome: 'unknown', label: 'gmail' }])).toBe('One step worked and one couldn’t be confirmed. Nothing was taken for it.');
    expect(outcomeNote('partial', [{ outcome: 'worked' }, { outcome: 'failed' }, { outcome: 'unknown', label: 'gmail' }])).toBe('One step worked and one didn’t and one couldn’t be confirmed. Nothing was taken for them.');
    expect(outcomeNote('unconfirmed', [{ outcome: 'unknown', label: 'exa' }], { holdPending: true })).toBe('We couldn’t confirm whether Exa finished. We’re releasing your hold.');
  });

  it('once the books acknowledge giving a hold back it says the amount that came back, and never before', () => {
    expect(outcomeNote('unconfirmed', [{ outcome: 'unknown', label: 'exa' }], { releasedMicros: 7_600 })).toBe('We couldn’t confirm whether Exa finished. Your hold of $0.008 was released.');
    expect(outcomeNote('unconfirmed', [{ outcome: 'unknown', label: 'exa' }], { holdPending: true, releasedMicros: 7_600 })).toBe('We couldn’t confirm whether Exa finished. We’re releasing your hold.');
    expect(outcomeNote('unconfirmed', [{ outcome: 'unknown', label: 'exa' }], { releasedMicros: 0 })).toBe('We couldn’t confirm whether Exa finished. Nothing was taken for it.');
    expect(HOLD_RELEASED).toBe('Hold released');
    expect(SETTLEMENT_PENDING).toBe('Settlement pending');
  });

  it('writes dollars the way a reader says them', () => {
    expect(dollars(0)).toBe('$0');
    expect(dollars(30_000)).toBe('$0.03');
    expect(dollars(1_200)).toBe('$0.001');
    expect(dollars(9_000)).toBe('$0.009');
    expect(dollars(300)).toBe('less than $0.001');
    expect(dollars(10_000)).toBe('$0.01');
    expect(dollars(1_250_000)).toBe('$1.25');
  });

  describe('round 2: mixed, stopped, pending and deciding receipts', () => {
    const gmail = { outcome: 'worked' as const, label: 'gmail' };
    it('headlines: the spending rule and the pending refund are said in their own words, with the amount', () => {
      expect(outcomeTextOf('stopped', { stoppedBy: 'rule' })).toBe(STOPPED_AT_RULE);
      expect(STOPPED_AT_RULE).toBe('Stopped at your spending rule');
      expect(outcomeTextOf('stopped', { stoppedBy: 'person' })).toBe('Stopped');
      expect(outcomeTextOf('refund_pending', { refundPendingMicros: 30_000 })).toBe('$0.03 refund pending');
      expect(outcomeTextOf('deciding')).toBe('Still deciding');
      expect(outcomeTextOf('done')).toBe('Done');
    });

    it('a returned computer beside a Gmail that was charged: the Gmail charge, the returned cost and the net are each said', () => {
      expect(outcomeNote('partial', [gmail], { job: 'returned', returnedMicros: 30_000, appCharges: [{ label: 'gmail', micros: 9_000 }], netMicros: 9_000 })).toBe(
        'One step worked and one didn’t. Computer cost of $0.03 was returned. Gmail charged $0.009. You pay $0.009 in all.',
      );
      // While the refund is pending the net waits
      expect(outcomeNote('partial', [gmail], { job: 'returned', refundPendingMicros: 30_000, appCharges: [{ label: 'gmail', micros: 9_000 }], netMicros: 9_000 })).toBe('One step worked and one didn’t. Computer cost of $0.03 refund pending. Gmail charged $0.009.');
      // A price not known yet is not a charge of nothing
      expect(outcomeNote('partial', [gmail], { job: 'returned', returnedMicros: 30_000, appCharges: [{ label: 'gmail', micros: null }] })).toContain('Gmail price not known yet.');
    });

    it('stopped, refund pending and deciding each say what is true now', () => {
      expect(outcomeNote('stopped', [], { job: 'stopped', computerMicros: 20_000 })).toBe('It stopped before it finished, and nothing was confirmed as done. Computer time used $0.02.');
      expect(outcomeNote('partial', [gmail], { job: 'stopped', stoppedAtRule: true, computerMicros: 20_000, appCharges: [{ label: 'gmail', micros: 9_000 }] })).toBe(
        'One step worked and one didn’t. The computer stopped at your spending rule. Computer time used $0.02. Gmail charged $0.009.',
      );
      expect(outcomeNote('refund_pending', [], { job: 'returned', refundPendingMicros: 30_000 })).toBe('We’re giving back the computer cost. It shows in your credit as soon as it’s confirmed.');
      expect(outcomeNote('deciding', [], { job: 'failed', computerMicros: 30_000, deciding: 'limits' })).toBe('We’re still deciding whether to give back the computer cost. Computer time $0.03 is charged for now.');
      expect(outcomeNote('deciding', [], { job: 'failed', computerMicros: 30_000, deciding: 'effect' })).toContain('A step outside the computer isn’t confirmed yet');
    });
  });
});
