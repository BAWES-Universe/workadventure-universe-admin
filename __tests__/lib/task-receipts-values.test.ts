import { activityIdOf, categoryOf, jobActivityIdOf, outcomeOfRuns, readActions, readActivityId, receiptLines, receiptLink, spentOf, stateOfOutcome, type LineEvent } from '@/lib/task-receipts-values';

const event = (over: Partial<LineEvent>): LineEvent => ({ kind: 'app_use', route: 'instant', quantity: 1, costMicros: 30_000, detail: null, ...over });

describe('what a task’s receipt says it used', () => {
  it('adds the uses up into one line each, in a fixed order, with Nothing where nothing was charged', () => {
    const lines = receiptLines(
      [
        event({ kind: 'model_call', route: 'universe-ai', quantity: 1, costMicros: 4_000 }),
        event({ detail: { app: 'research' } }),
        event({ detail: { app: 'research' } }),
        event({ kind: 'app_use', route: 'app', costMicros: 0 }),
      ],
      'Brick',
    );
    expect(lines).toEqual([
      { label: 'Instant research, 2 uses', amountMicros: 60_000 },
      { label: 'Apps you connected, 1 use', note: 'Nothing' },
      { label: "Brick's own thinking", note: 'Universe AI' },
    ]);
  });

  it('time of a job that failed on our side is shown as Nothing taken, never as an amount', () => {
    const lines = receiptLines([event({ kind: 'computer_time', route: 'computer', quantity: 300, costMicros: 30_000, detail: { givenBack: true, forPersonId: 'p1' } })], 'Brick');
    expect(lines).toEqual([{ label: 'Computer, 5 minutes', note: 'Nothing' }]);
    expect(spentOf('refunded', null, lines)).toBeNull();
  });

  it('a computer line says its minutes; its own key is named as the key it ran on', () => {
    const lines = receiptLines([event({ kind: 'computer_time', route: 'computer', quantity: 600, costMicros: 60_000 }), event({ kind: 'model_call', route: 'own-key', costMicros: null })], 'Scout');
    expect(lines).toEqual([
      { label: 'Computer, 10 minutes', amountMicros: 60_000 },
      { label: "Scout's own thinking", note: 'Your own key' },
    ]);
    expect(receiptLines([event({ kind: 'computer_time', route: 'computer', quantity: 7200, costMicros: 1 })], 'B')[0].label).toBe('Computer, 2 hours');
  });

  it('a use with no price yet says so and never counts as 0', () => {
    const lines = receiptLines([event({ costMicros: 20_000 }), event({ costMicros: null })], 'Brick');
    expect(lines).toEqual([{ label: 'Instant Apps, 2 uses', note: 'Price not known yet' }]);
    expect(spentOf('done', null, lines)).toBeNull();
  });

  it('leaves out disk sizes and other bookkeeping, and a name that is long or missing is not used', () => {
    expect(receiptLines([event({ kind: 'size_change', route: 'computer' }), event({ kind: 'stored_bytes', route: null })], 'Brick')).toEqual([]);
    expect(receiptLines([event({ detail: { app: 'x'.repeat(41) } })], 'Brick')[0].label).toBe('Instant Apps, 1 use');
  });
});

describe('what a task took from credit', () => {
  it('the figure set when it settled wins; a refunded task took nothing, and zero reads as nothing', () => {
    expect(spentOf('done', 920_000, [])).toBe(920_000);
    expect(spentOf('done', 0, [])).toBeNull();
    expect(spentOf('refunded', 500_000, [{ label: 'x', amountMicros: 1 }])).toBeNull();
  });

  it('without a settled figure, the charged lines added up when every one has a price', () => {
    expect(spentOf('done', null, [{ label: 'a', amountMicros: 60_000 }, { label: 'b', amountMicros: 40_000 }, { label: 'c', note: 'Nothing' }])).toBe(100_000);
    expect(spentOf('done', null, [{ label: 'c', note: 'Nothing' }])).toBeNull();
  });
});

describe('the category and the ids', () => {
  it('is what it was opened as, else what it was charged as', () => {
    expect(categoryOf('computer', [])).toBe('computer');
    expect(categoryOf(null, [event({})])).toBe('apps');
    expect(categoryOf(null, [event({ kind: 'computer_time', route: 'computer' })])).toBe('computer');
    expect(categoryOf(null, [event({ kind: 'model_call', route: 'universe-ai' })])).toBeNull();
  });

  it('an id reads back to what it was made from, and the chat link opens Usage on that receipt', () => {
    expect(readActivityId(activityIdOf('abc'))).toEqual({ kind: 'receipt', id: 'abc' });
    expect(readActivityId(jobActivityIdOf('job-1'))).toEqual({ kind: 'job', id: 'job-1' });
    expect(readActivityId('act_')).toBeNull();
    expect(readActivityId('nope')).toBeNull();
    expect(receiptLink('act_abc')).toBe('[What it used](#usage=act_abc)');
  });
});

describe('how a task came to end, from its runs', () => {
  const runs = (...states: string[]) => states.map((state, index) => ({ id: `r${index}`, state, toolkit: index % 2 === 0 ? 'gmail' : 'exa' }));

  it('every action worked is done; some worked is partly done; none worked is refunded, nothing taken', () => {
    expect(outcomeOfRuns(runs('succeeded', 'succeeded'))).toMatchObject({ open: false, outcome: 'done' });
    expect(outcomeOfRuns(runs('succeeded', 'failed'))).toMatchObject({ open: false, outcome: 'partial' });
    expect(outcomeOfRuns(runs('failed', 'failed'))).toMatchObject({ open: false, outcome: 'refunded' });
    // No run at all is nothing worked
    expect(outcomeOfRuns([])).toEqual({ open: false, outcome: 'refunded', actions: [] });
  });

  it('keeps each action’s own outcome, in order; a refused run never went out and is not an action', () => {
    expect(outcomeOfRuns(runs('succeeded', 'refused', 'failed')).actions).toEqual([
      { run: 'r0', label: 'gmail', outcome: 'worked' },
      { run: 'r2', label: 'gmail', outcome: 'failed' },
    ]);
    expect(outcomeOfRuns(runs('refused', 'refused'))).toEqual({ open: false, outcome: 'refunded', actions: [] });
  });

  it('a run that has not ended means the task cannot be settled yet, and is not counted as an action', () => {
    for (const state of ['reserving', 'held', 'sent', 'ambiguous']) {
      expect(outcomeOfRuns(runs('succeeded', state))).toMatchObject({ open: true, actions: [{ run: 'r0', outcome: 'worked' }] });
    }
  });

  it('partly done is still a done receipt (something worked); only none-worked is refunded', () => {
    expect(stateOfOutcome('done')).toBe('done');
    expect(stateOfOutcome('partial')).toBe('done');
    expect(stateOfOutcome('refunded')).toBe('refunded');
  });

  it('reads stored actions back and drops anything that is not the shape written', () => {
    expect(readActions([{ run: 'a', label: 'gmail', outcome: 'worked' }, { run: 'b', label: 'exa', outcome: 'refunded' }, null, 'x', { run: 1, label: 'x', outcome: 'failed' }])).toEqual([{ run: 'a', label: 'gmail', outcome: 'worked' }]);
    expect(readActions(null)).toEqual([]);
    expect(readActions({})).toEqual([]);
  });
});
