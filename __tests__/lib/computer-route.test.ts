import { appQuote, chooseRoute, computerQuote, stepsReview, CHAT_TURN_MICROS, COMPUTER_JOB_CALLS, COMPUTER_JOB_MINUTES, HERMES_CALL_MICROS, MAX_PLANNED_STEPS, UNKNOWN_APP_STEP_MICROS, cleanSteps } from '@/lib/computer-route';
import { RATE_MICROS } from '@/lib/composio-rates';
import { keptDiskMonthMicros } from '@/lib/agent37/rates';

describe('choosing the route by what the whole task is expected to cost', () => {
  describe('the app way', () => {
    it('costs each step at the app’s rate plus the model turn that makes it', () => {
      expect(appQuote({ app: 'Notion', steps: 4, stepMicros: RATE_MICROS.managed_other }).expectedMicros).toBe(4 * (RATE_MICROS.managed_other + CHAT_TURN_MICROS));
    });

    it('never costs a step at nothing when the app’s rate is not known', () => {
      const quote = appQuote({ app: 'Mystery', steps: 3, stepMicros: null });
      expect(UNKNOWN_APP_STEP_MICROS).toBeGreaterThan(0);
      expect(quote.expectedMicros).toBe(3 * (UNKNOWN_APP_STEP_MICROS + CHAT_TURN_MICROS));
    });

    it('is a plan of at least one step, never more than a day’s sensible work, and a number that is not one is the least', () => {
      expect(cleanSteps(0)).toBe(1);
      expect(cleanSteps(-5)).toBe(1);
      expect(cleanSteps(Number.NaN)).toBe(1);
      expect(cleanSteps('7' as unknown)).toBe(1);
      expect(cleanSteps(3.7)).toBe(4);
      expect(cleanSteps(1e9)).toBe(MAX_PLANNED_STEPS);
    });
  });

  describe('the computer way', () => {
    it('costs the awake minutes a job usually takes, the agent’s own calls, and nothing for a disk that already exists', () => {
      const quote = computerQuote({ awakeMicrosPerMinute: 110, hasMachine: true });
      expect(quote.route).toBe('computer');
      expect(quote.expectedMicros).toBe(COMPUTER_JOB_MINUTES * 110 + COMPUTER_JOB_CALLS * HERMES_CALL_MICROS);
    });

    it('adds a month of the disk for a Brick that has no machine yet, because the job makes one', () => {
      const quote = computerQuote({ awakeMicrosPerMinute: 110, hasMachine: false });
      expect(quote.expectedMicros).toBe(COMPUTER_JOB_MINUTES * 110 + COMPUTER_JOB_CALLS * HERMES_CALL_MICROS + keptDiskMonthMicros());
    });

    it('never costs a minute at nothing when the provider has not said what one costs', () => {
      expect(computerQuote({ awakeMicrosPerMinute: null, hasMachine: true }).expectedMicros).toBeGreaterThan(COMPUTER_JOB_CALLS * HERMES_CALL_MICROS);
    });
  });

  describe('the lowest', () => {
    it('is the app for a few steps, and the computer once the steps cost more than the job', () => {
      const computer = computerQuote({ awakeMicrosPerMinute: 110, hasMachine: true });
      expect(chooseRoute([appQuote({ app: 'Notion', steps: 3, stepMicros: 500 }), computer]).route).toBe('app');
      expect(chooseRoute([appQuote({ app: 'Notion', steps: 60, stepMicros: 500 }), computer]).route).toBe('computer');
    });

    it('has no fixed number of steps where the app stops being chosen: it is whatever the cost says, so a free app (no rate) goes on while it is the cheaper way', () => {
      const computer = computerQuote({ awakeMicrosPerMinute: 110, hasMachine: true });
      expect(chooseRoute([appQuote({ app: 'Notion', steps: 12, stepMicros: 0 }), computer]).route).toBe('app');
      expect(chooseRoute([appQuote({ app: 'Notion', steps: 14, stepMicros: 0 }), computer]).route).toBe('computer');
    });

    it('is the app when the two cost the same: it wakes nothing', () => {
      expect(chooseRoute([{ route: 'computer', expectedMicros: 10 }, { route: 'app', expectedMicros: 10, app: 'Notion' }]).route).toBe('app');
    });

    it('is the computer when there is nothing else', () => {
      expect(chooseRoute([computerQuote({ awakeMicrosPerMinute: 110, hasMachine: true })]).route).toBe('computer');
    });
  });

  describe('the review at the checkpoint', () => {
    const computer = computerQuote({ awakeMicrosPerMinute: 110, hasMachine: true });

    it('asks for a look once the steps taken so far have cost what the whole job on the computer would', () => {
      expect(stepsReview({ steps: 20, stepMicros: 300, computer })).toBe(true);
      expect(stepsReview({ steps: 5, stepMicros: 0, computer })).toBe(false);
    });

    it('prices the steps taken so far like any app route, an unknown rate as the dearest, never nothing', () => {
      expect(stepsReview({ steps: 11, stepMicros: null, computer })).toBe(true);
      expect(stepsReview({ steps: 11, stepMicros: 0, computer })).toBe(false);
      expect(stepsReview({ steps: 12, stepMicros: 0, computer })).toBe(false);
      expect(stepsReview({ steps: 14, stepMicros: 0, computer })).toBe(true);
    });
  });
});
