/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { LimitChoices, codeJobLimits, type CodeJobLimitViews } from '@/app/admin/components/limits';

/**
 * The code job rows of the Limits screen: a row whose range starts at 0 can be saved as 0 ("never"), a row that may be empty can be emptied
 * again, and a row that needs a number never saves an empty or zero one.
 */

jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: jest.fn() }));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));

const view = (over: Partial<CodeJobLimitViews[string]>): CodeJobLimitViews[string] => ({ value: 3, range: { min: 0, max: 100 }, recommended: 3, label: 'A limit', help: 'Help', unit: 'count', required: true, ...over });

const row = (key: string, v: CodeJobLimitViews[string]) => {
  const limit = codeJobLimits({ [key]: v }).find((entry) => entry.id === key)!;
  const onDone = jest.fn();
  render(<LimitChoices limit={limit} onDone={onDone} onCancel={() => undefined} />);
  return onDone;
};

describe('code job rows on the Limits screen', () => {
  it('saves an explicit 0 on a row whose range starts at 0, and not an empty box', async () => {
    const onDone = row('maxReads', view({ label: 'Reads in one job' }));
    fireEvent.click(screen.getByRole('radio', { name: /Other/ }));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    // An emptied box is not a choice
    fireEvent.change(screen.getByLabelText(/Reads in one job, in/), { target: { value: '' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reads in one job, in/), { target: { value: '0' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onDone).toHaveBeenCalledWith(0);
  });

  it('does not save 0 on a row that needs at least 1', () => {
    row('maxSeconds', view({ label: 'Longest job', unit: 'seconds', range: { min: 1, max: 600 } }));
    fireEvent.click(screen.getByRole('radio', { name: /Other/ }));
    fireEvent.change(screen.getByLabelText(/Longest job, in/), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Longest job, in/), { target: { value: '30' } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['keepDays', 'days' as const],
    ['maxAnswerBytes', 'bytes' as const],
  ])('can empty %s again, and says what empty means', (key, unit) => {
    const onDone = row(key, view({ label: 'May be empty', unit, value: unit === 'days' ? 30 : 204_800, range: { min: 1, max: 100_000_000 }, required: false }));
    fireEvent.click(screen.getByRole('radio', { name: /Not set/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // Handed to the saver as -1, which it saves as empty
    expect(onDone).toHaveBeenCalledWith(-1);
  });

  it('offers no way to empty a row that must have a value', () => {
    row('maxCells', view({ label: 'Runs in one job', range: { min: 1, max: 20 } }));
    expect(screen.queryByRole('radio', { name: /Not set/ })).toBeNull();
  });

  it('starts on "Not set" for an empty row that may be empty', () => {
    row('keepDays', view({ label: 'Days kept', unit: 'days', value: null, required: false, recommended: null, range: { min: 1, max: 3650 } }));
    expect((screen.getByRole('radio', { name: /Not set/ }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
  });
});
