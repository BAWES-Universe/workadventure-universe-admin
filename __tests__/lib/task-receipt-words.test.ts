import { actionWords, appLabel, dollars, HOLD_BEING_RELEASED, HOLD_RELEASED, NOTHING_TAKEN, OUTCOME_WORDS, outcomeNote, REACHED_WORDS, outcomeTextOf, SETTLEMENT_PENDING, STILL_CHECKING, STOPPED_AT_RULE, UNREACHABLE_WORDS } from '@/lib/task-receipt-words';

describe('the words for how a task came to end (mock M2)', () => {
  it('names the outcomes as the mock does, and the two it did not have: a task that did not finish but took something, and one nobody could confirm', () => {
    expect(OUTCOME_WORDS).toEqual({ done: 'Done', partial: 'Partly done', refunded: 'Refunded, nothing taken', failed: 'Didn’t finish', unconfirmed: 'Couldn’t confirm', stopped: 'Stopped', deciding: 'Still checking', refund_pending: 'Refund pending' });
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

  describe('round 2: mixed, stopped, pending and deciding receipts (Opus R1a-R1d)', () => {
    const gmail = { outcome: 'worked' as const, label: 'gmail' };
    it('headlines: each stop says what stopped the job, the pending refund says its amount, deciding says it is still being checked', () => {
      expect(outcomeTextOf('stopped', { stoppedBy: 'rule' })).toBe(STOPPED_AT_RULE);
      expect(STOPPED_AT_RULE).toBe('Stopped at your spending rule');
      expect(outcomeTextOf('stopped', { stoppedBy: 'allowance' })).toBe('Stopped: your computer time ran out');
      expect(outcomeTextOf('stopped', { stoppedBy: 'person' })).toBe('Stopped by you');
      expect(outcomeTextOf('stopped', { stoppedBy: 'pool' })).toBe('Stopped: our computers were busy');
      expect(outcomeTextOf('stopped', { stoppedBy: 'pool', givenBack: true })).toBe('Stopped: our computers were busy, and its time was given back');
      expect(outcomeTextOf('stopped', { stoppedBy: null })).toBe('Stopped');
      expect(outcomeTextOf('refund_pending', { refundPendingMicros: 30_000 })).toBe('$0.03 refund pending');
      expect(outcomeTextOf('deciding')).toBe('Still checking');
      expect(outcomeTextOf('done')).toBe('Done');
    });

    it('GPT round 3, finding 5: a computer given back that the relay says was reached has its own sentence, and never says it could not be reached', () => {
      expect(REACHED_WORDS).toBe('The computer part didn’t finish, and its time was given back.');
      expect(outcomeNote('refunded', [], { job: 'returned', reached: true })).toBe(REACHED_WORDS);
      expect(outcomeNote('refunded', [], { job: 'returned', reached: true })).not.toContain('couldn’t reach');
      expect(outcomeNote('refunded', [], { job: 'returned', unreachable: true })).toBe(UNREACHABLE_WORDS);
      // Only a job given back says it
      expect(outcomeNote('refunded', [], { job: 'failed', reached: true })).toBeNull();
      expect(outcomeNote('refunded', [], { job: 'returned' })).toBeNull();
    });

    it('GPT round 3, finding 2: an App let go unconfirmed that was delivered after all is said first, in the approved words, beside a computer given back', () => {
      const late = { job: 'returned' as const, returnedMicros: 30_000, deliveredAfterRelease: ['gmail'] };
      expect(outcomeNote('partial', [gmail], late)).toBe('Gmail was delivered. Its hold was released. The computer part didn’t finish and its cost was returned.');
      // The refund still pending: the cost is not yet back, and the words do not say it is
      expect(outcomeNote('partial', [gmail], { job: 'returned', refundPendingMicros: 30_000, deliveredAfterRelease: ['gmail'] })).toBe('Gmail was delivered. Its hold was released. The computer part didn’t finish and its cost is being returned.');
      // The hold itself still being given back
      expect(outcomeNote('partial', [gmail], { ...late, holdPending: true })).toBe('Gmail was delivered. Its hold is being released. The computer part didn’t finish and its cost was returned.');
      // Two Apps
      expect(outcomeNote('partial', [gmail, gmail], { ...late, deliveredAfterRelease: ['gmail', 'slack'] })).toBe('Gmail and Slack were delivered. Their holds were released. The computer part didn’t finish and its cost was returned.');
      // A relay that could not be reached keeps its own lead
      expect(outcomeNote('partial', [gmail], { ...late, unreachable: true })).toContain('We couldn’t reach our own service');
      // Without a late delivery the words are the ones they were
      expect(outcomeNote('partial', [gmail], { job: 'returned', returnedMicros: 30_000 })).toBe('The computer part didn’t finish because of a problem on our side, and its time ($0.03) was given back.');
    });

    it('a computer given back beside a Gmail that was charged: the problem on our side, the cost given back, the Gmail charge and the net are each said', () => {
      expect(outcomeNote('partial', [gmail], { job: 'returned', returnedMicros: 30_000, appCharges: [{ label: 'gmail', micros: 9_000 }], netMicros: 9_000 })).toBe(
        'The computer part didn’t finish because of a problem on our side, and its time ($0.03) was given back. Gmail worked and was charged $0.009. You pay $0.009 in all.',
      );
      // While the refund is pending the net waits
      expect(outcomeNote('partial', [gmail], { job: 'returned', refundPendingMicros: 30_000, appCharges: [{ label: 'gmail', micros: 9_000 }], netMicros: 9_000 })).toBe(
        'The computer part didn’t finish because of a problem on our side. Its time ($0.03) is refund pending. Gmail worked and was charged $0.009.',
      );
      // A price not known yet is not a charge of nothing
      expect(outcomeNote('partial', [gmail], { job: 'returned', returnedMicros: 30_000, appCharges: [{ label: 'gmail', micros: null }] })).toContain('Gmail worked. Its price is not known yet.');
      // A known provider cost whose charge the books have not acknowledged is settlement pending, a returned computer included, never a price nobody knows
      expect(outcomeNote('partial', [gmail], { job: 'returned', returnedMicros: 30_000, appCharges: [{ label: 'gmail', micros: null, settling: true }] })).toContain('Gmail worked. Its charge is settlement pending.');
      expect(outcomeNote('partial', [gmail], { job: 'returned', returnedMicros: 30_000, appCharges: [{ label: 'gmail', micros: null, settling: true }] })).not.toContain('price is not known');
      expect(outcomeNote('failed', [], { job: 'failed', computerMicros: 30_000, appCharges: [{ label: 'gmail', micros: null, settling: true }] })).toBe('It didn’t finish. Computer time used $0.03. Gmail: settlement pending.');
    });

    it('stopped, refund pending and deciding each say what is true now', () => {
      expect(outcomeNote('stopped', [], { job: 'stopped', stoppedBy: 'rule', computerMicros: 20_000 })).toBe('It stopped before it finished, and nothing was confirmed as done. Computer time used $0.02.');
      expect(outcomeNote('stopped', [], { job: 'returned', stoppedBy: 'pool', returnedMicros: 20_000 })).toBe('It stopped before it finished, and nothing was confirmed as done. Computer cost of $0.02 was given back.');
      const partlyStopped = (stoppedBy: string) => outcomeNote('partial', [gmail], { job: 'stopped', stoppedBy, computerMicros: 20_000, appCharges: [{ label: 'gmail', micros: 9_000 }] });
      expect(partlyStopped('rule')).toBe('One step worked and one didn’t. The computer stopped at your spending rule. Computer time used $0.02. Gmail charged $0.009.');
      expect(partlyStopped('allowance')).toContain('The computer stopped because your computer time ran out.');
      expect(partlyStopped('person')).toContain('You stopped the computer.');
      expect(outcomeNote('refund_pending', [], { job: 'returned', refundPendingMicros: 30_000 })).toBe('We’re returning $0.03 to your credit.');
      expect(outcomeNote('deciding', [], { job: 'failed', computerMicros: 30_000, deciding: 'limits' })).toBe(`${STILL_CHECKING} Computer time $0.03 is charged for now.`);
      expect(STILL_CHECKING).toBe('We’re still checking this one. If it was our fault, the time comes back.');
    });

    it('a computer that could not reach our own service says so in the approved words, and never "you weren’t charged" while a refund is pending or an App was charged', () => {
      expect(UNREACHABLE_WORDS).toBe('We couldn’t reach our own service, you weren’t charged.');
      // Given back in full: the words, for the refunded headline too (which says nothing more otherwise)
      expect(outcomeNote('refunded', [], { job: 'returned', unreachable: true })).toBe(UNREACHABLE_WORDS);
      expect(outcomeNote('refunded', [], { job: 'returned' })).toBeNull();
      expect(outcomeNote('failed', [], { job: 'returned', unreachable: true, returnedMicros: 30_000 })).toBe(`${UNREACHABLE_WORDS} Computer cost of $0.03 was given back.`);
      expect(outcomeNote('failed', [], { job: 'returned', returnedMicros: 30_000 })).toBe('It didn’t finish. Computer cost of $0.03 was given back.');
      // Not the person's refund yet: never said as not charged
      expect(outcomeNote('refund_pending', [], { job: 'returned', unreachable: true, refundPendingMicros: 30_000 })).toBe('We couldn’t reach our own service. We’re returning $0.03 to your credit.');
      // Beside an App that worked and was charged
      const note = outcomeNote('partial', [gmail], { job: 'returned', unreachable: true, returnedMicros: 30_000, appCharges: [{ label: 'gmail', micros: 9_000 }], netMicros: 9_000 });
      expect(note).toBe('We couldn’t reach our own service, so the computer part didn’t finish, and its time ($0.03) was given back. Gmail worked and was charged $0.009. You pay $0.009 in all.');
      expect(note).not.toContain('weren’t charged');
      // Only a job given back says it
      expect(outcomeNote('failed', [], { job: 'failed', unreachable: true, computerMicros: 30_000 })).toBe('It didn’t finish. Computer time used $0.03.');
    });
  });
});
