/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/** The person's page: what they use, and giving them extra usage (game #1999). A gift is never owed; billing is a mark for the super admin only. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const mockAddToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: mockAddToast }) }));

import { ExtraUsage } from '@/app/admin/users/[id]/extra-usage';
import type { PersonUsage } from '@/lib/meter-person';
import { day } from '@/lib/costs-words';

// The running grant ends 20 days from now, so the tests never depend on today's date
const ENDS = new Date(Date.now() + 20 * 86_400_000);
const endsOn = day(ENDS.toISOString());

const usage = (over: Partial<PersonUsage> = {}): PersonUsage => ({
  chatWeekMicros: 6_120_000,
  bricks: 2,
  computerMonthMicros: 3_100_000,
  allowanceMicros: 5_000_000,
  noLimit: false,
  allowanceSet: true,
  keptBytes: 1_200_000_000,
  asked: null,
  extra: null,
  ...over,
});

const running = (over: object = {}): NonNullable<PersonUsage['extra']> => ({
  grantKey: 'sara:k1',
  multiplier: 5,
  noLimit: false,
  startsAt: new Date().toISOString(),
  endsAt: ENDS.toISOString(),
  givenById: 'admin',
  givenByName: 'Khalid',
  settlement: 'to_bill',
  billedAt: null,
  note: 'Agreed with Sara on 11 Nov',
  ...over,
});

function answer(first: PersonUsage, after?: PersonUsage) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ usage: after ?? first }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(first) });
  });
}

const bodyOf = (method: string) => JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === method)?.[1].body));

let keys = 0;
beforeEach(() => {
  keys = 0;
  fetchMock.mockReset();
  mockAddToast.mockReset();
  Object.defineProperty(globalThis.crypto ?? (globalThis as unknown as { crypto: object }).crypto, 'randomUUID', { value: () => `key-${++keys}`, configurable: true });
});

describe('what a person uses', () => {
  it('says chat and voice for the week, Bricks, and computer against this month’s allowance, with what is kept', async () => {
    answer(usage());
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText('Usage')).toBeTruthy();
    expect(screen.getByText('Chat and voice · $6.12 in the last 7 days · 2 Bricks')).toBeTruthy();
    expect(screen.getByText('Computer · $3.10 of $5.00 this month · 1.2 GB kept')).toBeTruthy();
    expect(screen.getByText('On the usual allowance, like every member.')).toBeTruthy();
  });

  it('counts against the raised allowance while extra usage runs, and says no limit when it has none', async () => {
    answer(usage({ allowanceMicros: 25_000_000, extra: running() }));
    const { unmount } = render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText('Computer · $3.10 of $25.00 this month · 1.2 GB kept')).toBeTruthy();
    unmount();
    answer(usage({ allowanceMicros: null, noLimit: true, extra: running({ multiplier: null, noLimit: true }) }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText('Computer · $3.10 this month, no limit · 1.2 GB kept')).toBeTruthy();
  });

  it('says no limit first when a no-limit grant runs and the usual allowance is not set', async () => {
    answer(usage({ allowanceSet: false, allowanceMicros: null, noLimit: true, extra: running({ multiplier: null, noLimit: true }) }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText('Computer · $3.10 this month, no limit · 1.2 GB kept')).toBeTruthy();
  });

  it('shows no allowance to count against until one is set', async () => {
    answer(usage({ allowanceSet: false, allowanceMicros: null }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText('Computer · $3.10 this month · 1.2 GB kept')).toBeTruthy();
  });

  it('says it could not load, with a way to try again', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText(/We couldn’t load Sara’s usage/)).toBeTruthy();
    answer(usage());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Usage')).toBeTruthy();
  });
});

describe('someone asked for more', () => {
  it('shows who asked and when, until extra usage answers it', async () => {
    answer(usage({ asked: { at: new Date().toISOString() } }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText('Sara asked for more')).toBeTruthy();
    expect(screen.getByText(/Today at .* Computer time is used up for this month/)).toBeTruthy();
    expect(screen.queryByText('On the usual allowance, like every member.')).toBeNull();
  });

  it('still shows the request while extra usage runs, since a raised allowance can be used up too', async () => {
    answer(usage({ asked: { at: new Date().toISOString() }, extra: running() }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText(new RegExp(`Extra usage until ${endsOn}`))).toBeTruthy();
    expect(screen.getByText('Sara asked for more')).toBeTruthy();
  });
});

describe('giving extra usage', () => {
  it('asks how much, until when, and a gift or a bill, and says what the person will see', async () => {
    answer(usage());
    render(<ExtraUsage userId="sara" name="Sara" />);
    fireEvent.click(await screen.findByTestId('extra-usage-give'));
    expect(await screen.findByText('Give Sara extra usage')).toBeTruthy();
    for (const label of ['Double', '5 times', 'No limit', '7 days', '30 days', 'A date', 'A gift', 'I’ll bill for it']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('A gift is never owed.')).toBeTruthy();
    expect(screen.getByText(/Sara sees one line on their Usage page: “You have extra usage until .*\.” Nothing about billing shows in Universe\./)).toBeTruthy();
  });

  it('gives a gift: the amount, an end in the future, and a key made when the sheet opened', async () => {
    answer(usage(), usage({ extra: running({ settlement: 'gift' }) }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    fireEvent.click(await screen.findByTestId('extra-usage-give'));
    fireEvent.click(await screen.findByRole('radio', { name: /Double/ }));
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    fireEvent.click(screen.getByTestId('extra-usage-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const sent = bodyOf('POST');
    expect(sent).toMatchObject({ grantKey: 'key-1', amount: 'double', settlement: 'gift', note: null });
    expect(new Date(sent.endsAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(new Date(sent.endsAt).getTime()).toBeLessThan(Date.now() + 8 * 86_400_000);
    // The page then shows it running, as a gift: nothing to bill
    expect(await screen.findByText(new RegExp(`Extra usage until ${endsOn}`))).toBeTruthy();
    expect(screen.queryByText('Mark as billed')).toBeNull();
  });

  it('records "I’ll bill for it" with its note, and says nothing is charged here', async () => {
    answer(usage(), usage({ extra: running() }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    fireEvent.click(await screen.findByTestId('extra-usage-give'));
    fireEvent.click(screen.getByRole('radio', { name: 'I’ll bill for it' }));
    expect(screen.getByText('Nothing is charged here. It stays marked “To bill” on the Costs page until you mark it billed.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Note for the bill'), { target: { value: 'Agreed with Sara on 11 Nov' } });
    fireEvent.click(screen.getByTestId('extra-usage-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    expect(bodyOf('POST')).toMatchObject({ amount: 'five', settlement: 'to_bill', note: 'Agreed with Sara on 11 Nov' });
  });

  it('keeps the same key when an answer never came back, and makes a new one once the server has said no', async () => {
    let attempt = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(usage()) });
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('offline'));
      if (attempt === 2) return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'No' }) });
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ usage: usage({ extra: running({ settlement: 'gift' }) }) }) });
    });
    render(<ExtraUsage userId="sara" name="Sara" />);
    fireEvent.click(await screen.findByTestId('extra-usage-give'));
    const keysSent = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init.body)).grantKey);
    fireEvent.click(screen.getByTestId('extra-usage-confirm'));
    await waitFor(() => expect(keysSent()).toHaveLength(1));
    // No answer: the sheet is closed and opened again, and the same thing sent again keeps the same key
    await waitFor(() => expect((screen.getByTestId('extra-usage-confirm') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('extra-usage-confirm'));
    await waitFor(() => expect(keysSent()).toHaveLength(2));
    expect(keysSent()[1]).toBe(keysSent()[0]);
    // The server said no to that one, so the next try is a new request with a new key
    await waitFor(() => expect((screen.getByTestId('extra-usage-confirm') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('extra-usage-confirm'));
    await waitFor(() => expect(keysSent()).toHaveLength(3));
    expect(keysSent()[2]).not.toBe(keysSent()[1]);
  });

  it('keeps the sheet open and says why when it was turned down', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'That key was used for a different grant. The first one stands.' }) }) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(usage()) }),
    );
    render(<ExtraUsage userId="sara" name="Sara" />);
    fireEvent.click(await screen.findByTestId('extra-usage-give'));
    fireEvent.click(screen.getByTestId('extra-usage-confirm'));
    await waitFor(() => expect(mockAddToast).toHaveBeenCalledWith({ description: 'That key was used for a different grant. The first one stands.', variant: 'error' }));
    expect(screen.getByText('Give Sara extra usage')).toBeTruthy();
  });
});

describe('extra usage that is running', () => {
  it('says what it is, who gave it and whether it is to bill, with Change, End it now and Mark as billed', async () => {
    answer(usage({ extra: running() }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText(`Extra usage until ${endsOn}`)).toBeTruthy();
    expect(screen.getByText(/5 times the usual · given by Khalid today · to bill/)).toBeTruthy();
    expect(screen.getByText('Agreed with Sara on 11 Nov')).toBeTruthy();
    for (const label of ['Change', 'End it now', 'Mark as billed']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
    expect(screen.queryByTestId('extra-usage-give')).toBeNull();
  });

  it('marks it billed, and ends it, through the person’s own route', async () => {
    answer(usage({ extra: running() }), usage({ extra: running({ billedAt: new Date().toISOString() }) }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as billed' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    expect(bodyOf('PATCH')).toEqual({ grantKey: 'sara:k1', action: 'billed' });
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[0]).toBe('/api/admin/users/sara/extra-usage');
    // Billed: no more Mark as billed and no Change (what was agreed is not rewritten)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark as billed' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.getByText(/billed /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'End it now' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2));
    expect(JSON.parse(String(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')[1][1].body))).toEqual({ grantKey: 'sara:k1', action: 'end' });
  });

  it('never offers Mark as billed for a gift', async () => {
    answer(usage({ extra: running({ settlement: 'gift', note: null }) }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    expect(await screen.findByText(/a gift/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as billed' })).toBeNull();
  });

  it('changes the amount and the end without asking again whether it is a gift or a bill', async () => {
    answer(usage({ extra: running({ multiplier: 2 }) }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect(await screen.findByText('Change Sara’s extra usage')).toBeTruthy();
    expect(screen.queryByTestId('extra-usage-billing')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /No limit/ }));
    fireEvent.click(screen.getByTestId('extra-usage-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    // Only what changed is sent: the end date and the note were not touched
    expect(bodyOf('PATCH')).toEqual({ grantKey: 'sara:k1', action: 'change', amount: 'none' });
  });

  it('sends nothing when nothing was changed', async () => {
    answer(usage({ extra: running({ multiplier: 2 }) }));
    render(<ExtraUsage userId="sara" name="Sara" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByTestId('extra-usage-confirm'));
    await waitFor(() => expect(screen.queryByText('Change Sara’s extra usage')).toBeNull());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});
