/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The Grants page (spec v3 O3): the defaults for Universe AI, Instant Apps and computers, the exceptions, the gifts, and the
 * three-part preview before anything is saved. Every amount here is typed in the test: the page has no built-in value.
 */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const replace = jest.fn();
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => replace }));
const mockAddToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: mockAddToast }) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import GrantsPage from '@/app/admin/ai-providers/grants/page';
import type { ClashView, GrantsOverview, PreviewNumbers } from '@/lib/grants-view';

const unset: GrantsOverview = {
  ai: { signedIn: 30, guest: 10, windowHours: 5 },
  money: {
    instant_apps: { set: false, amountMicros: null, interval: 'none', recipients: null },
    computers: { set: false, amountMicros: null, interval: 'none', recipients: null },
  },
  exceptions: [],
  gifts: [],
  totals: { people: 61, issuedMonthMicros: 0, usedMonthMicros: 0, budgetMicros: null },
};

const omar = { id: 'omar', name: 'Omar', woka: [] };
const set: GrantsOverview = {
  ...unset,
  money: {
    instant_apps: { set: true, amountMicros: 2_000_000, interval: 'once', recipients: { kind: 'all' } },
    computers: { set: true, amountMicros: 10_000_000, interval: 'monthly', recipients: { kind: 'all' } },
  },
  exceptions: [{ id: 'e1', audience: { kind: 'people', people: [omar], universe: null, count: 1 }, instant_apps: { mode: 'own', amountMicros: 10_000_000, interval: 'monthly' }, computers: { mode: 'same' } }],
  gifts: [{ id: 'g1', audience: { kind: 'people', people: [omar], universe: null, count: 1 }, amountMicros: 5_000_000, shared: false, totalMicros: 5_000_000, scope: 'both', endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), ended: false, usedMicros: 1_000_000, givenByName: 'Khalid', settlement: 'gift', billedAt: null, payer: 'Paid by Universe' }],
  totals: { people: 61, issuedMonthMicros: 122_000_000, usedMonthMicros: 214_000_000, budgetMicros: 1_000_000_000 },
};

const nums = (over: Partial<PreviewNumbers> = {}): PreviewNumbers => ({ people: 56, ownRules: 0, laterToo: true, amountMicros: 2_000_000, interval: 'once', shared: false, mostNowMicros: 112_000_000, noLifetimeMax: true, already: [], budget: { budgetMicros: 1_000_000_000, roomMicros: 900_000_000 }, ...over });

let overview: GrantsOverview;
let preview: { numbers: PreviewNumbers | null; clash: ClashView | null };
const calls = (method: string, urlPart: string) => fetchMock.mock.calls.filter(([url, init]) => String(url).includes(urlPart) && (init?.method ?? 'GET') === method);
const body = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

beforeEach(() => {
  fetchMock.mockReset();
  mockAddToast.mockReset();
  overview = unset;
  preview = { numbers: nums(), clash: null };
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const ok = (data: unknown, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(data) });
    if (url === '/api/admin/grants' && method === 'GET') return ok(overview);
    if (url === '/api/admin/grants/preview') return ok(preview);
    if (url.startsWith('/api/admin/grants/find')) return ok({ results: [{ id: 'omar', name: 'Omar', woka: [] }, { id: 'noor', name: 'Noor', woka: [] }] });
    return ok({ ok: true }, 201);
  });
});

describe('the defaults', () => {
  it('says Not set and what that means, and shows no number the admin did not type', async () => {
    render(<GrantsPage />);
    expect(await screen.findByTestId('grants-instant_apps')).toHaveTextContent('Not set');
    expect(screen.getByTestId('grants-instant_apps')).toHaveTextContent('Nobody gets Instant Apps credit yet');
    expect(screen.getByTestId('grants-computers')).toHaveTextContent('Computer jobs are refused until you set it');
    expect(screen.getByTestId('grants-instant_apps')).toHaveTextContent('Set');
  });

  it('shows the set defaults, the exception and the gift in the mock’s words', async () => {
    overview = set;
    render(<GrantsPage />);
    expect(await screen.findByTestId('grants-instant_apps')).toHaveTextContent('$2 once, when someone joins');
    expect(screen.getByTestId('grants-computers')).toHaveTextContent('$10 a month, renews on the 1st');
    expect(screen.getByTestId('grants-exception')).toHaveTextContent('Omar');
    expect(screen.getByTestId('grants-exception')).toHaveTextContent('Instant Apps $10 a month');
    expect(screen.getByTestId('grants-gift')).toHaveTextContent('$5 each, $5 in total');
    expect(screen.getByTestId('grants-gift')).toHaveTextContent('Paid by Universe');
    expect(screen.getByTestId('grants-gift')).toHaveTextContent('A gift');
  });

  it('sends a super admin who is not one back out', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'no' }) }));
    render(<GrantsPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'));
  });

  it('keeps Save shut until an amount is typed, then previews and saves exactly what was typed', async () => {
    render(<GrantsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set', hidden: false, description: undefined }).catch(() => within(screen.getByTestId('grants-instant_apps')).getByRole('button')));
    const save = await screen.findByTestId('grants-save');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('grants-amount'), { target: { value: '2.50' } });
    await waitFor(() => expect(calls('POST', '/preview').length).toBeGreaterThan(0));
    expect(body(calls('POST', '/preview').at(-1)!)).toMatchObject({ what: 'default', category: 'instant_apps', amountMicros: 2_500_000, interval: 'once', recipients: { kind: 'all' } });
    expect(await screen.findByTestId('grants-preview')).toHaveTextContent('Most credit issued');
    fireEvent.click(screen.getByTestId('grants-save'));
    await waitFor(() => expect(calls('PUT', '/defaults/instant_apps')).toHaveLength(1));
    expect(body(calls('PUT', '/defaults/instant_apps')[0])).toEqual({ amountMicros: 2_500_000, interval: 'once', recipients: { kind: 'all' } });
  });

  it('refuses an amount that is not dollars and sends nothing', async () => {
    render(<GrantsPage />);
    fireEvent.click(within(await screen.findByTestId('grants-computers')).getByRole('button'));
    fireEvent.change(await screen.findByTestId('grants-amount'), { target: { value: 'ten' } });
    expect(screen.getByText('Type an amount in dollars, like 2 or 2.50.')).toBeInTheDocument();
    expect(screen.getByTestId('grants-save')).toBeDisabled();
    expect(calls('POST', '/preview')).toHaveLength(0);
  });

  it('lets a default be none, with no amount, and says gifts still work', async () => {
    render(<GrantsPage />);
    fireEvent.click(within(await screen.findByTestId('grants-computers')).getByRole('button'));
    fireEvent.click(await screen.findByRole('radio', { name: 'None' }));
    expect(screen.getByText('No credit from the default. Exceptions and gifts still work.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('grants-save'));
    await waitFor(() => expect(calls('PUT', '/defaults/computers')).toHaveLength(1));
    expect(body(calls('PUT', '/defaults/computers')[0])).toMatchObject({ amountMicros: null, interval: 'none' });
  });
});

describe('exceptions', () => {
  it('keeps a clash from being saved until the admin chooses which rule applies', async () => {
    overview = set;
    preview = { numbers: nums({ people: 2, interval: 'monthly', mostNowMicros: 20_000_000, laterToo: false }), clash: { people: ['Omar', 'Noor'], other: { name: 'Kuwait Makers', text: 'Computers $5 a month' }, thisText: '$25' } };
    render(<GrantsPage />);
    fireEvent.click(await screen.findByTestId('grants-add-exception'));
    fireEvent.change(await screen.findByLabelText('Search people by name'), { target: { value: 'o' } });
    fireEvent.click(await screen.findByText('Omar', { selector: 'button *' }));
    fireEvent.click(screen.getAllByRole('radio', { name: 'Its own' })[1]);
    fireEvent.change(screen.getByLabelText('Computers amount'), { target: { value: '25' } });
    const clash = await screen.findByTestId('grants-clash');
    expect(clash).toHaveTextContent('Omar and Noor are also covered by Kuwait Makers, whose rule gives Computers $5 a month');
    expect(screen.getByTestId('grants-save')).toBeDisabled();
    fireEvent.click(within(clash).getByRole('radio', { name: /This one, \$25/ }));
    expect(screen.getByTestId('grants-save')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('grants-save'));
    await waitFor(() => expect(calls('POST', '/exceptions')).toHaveLength(1));
    expect(body(calls('POST', '/exceptions')[0])).toMatchObject({ audience: { kind: 'people', userIds: ['omar'] }, computers: { mode: 'own', amountMicros: 25_000_000, interval: 'monthly' }, clashChoice: 'this' });
  });

  it('offers only people and a universe for an exception, never universe roles', async () => {
    render(<GrantsPage />);
    fireEvent.click(await screen.findByTestId('grants-add-exception'));
    const group = await screen.findByRole('radiogroup', { name: 'Give credit to' });
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([expect.stringContaining('People you pick'), expect.stringContaining('A universe’s members')]);
    expect(screen.queryByText(/role/i)).toBeNull();
  });
});

describe('gifts', () => {
  async function pickOmar() {
    fireEvent.click(await screen.findByTestId('grants-give'));
    fireEvent.change(await screen.findByLabelText('Search people by name'), { target: { value: 'o' } });
    fireEvent.click(await screen.findByText('Omar', { selector: 'button *' }));
    fireEvent.click(screen.getByTestId('grants-recipients-done'));
  }

  it('offers all four kinds of recipient and no universe roles', async () => {
    render(<GrantsPage />);
    fireEvent.click(await screen.findByTestId('grants-give'));
    const group = await screen.findByRole('radiogroup', { name: 'Give credit to' });
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      expect.stringContaining('People you pick'),
      expect.stringContaining('A universe’s members'),
      expect.stringContaining('All signed-in members'),
      expect.stringContaining('New people from a date'),
    ]);
  });

  it('says each or shared before it saves, and gives once under one key even on a double tap', async () => {
    render(<GrantsPage />);
    await pickOmar();
    fireEvent.change(await screen.findByLabelText('Gift amount'), { target: { value: '5' } });
    preview = { numbers: nums({ people: 1, amountMicros: 5_000_000, laterToo: false, mostNowMicros: 5_000_000, noLifetimeMax: false, endsOn: '31 Dec' }), clash: null };
    await waitFor(() => expect(screen.getByTestId('grants-preview')).toHaveTextContent('This person gets one $5'));
    const give = await screen.findByRole('button', { name: 'Give $5 each' });
    await waitFor(() => expect(give).not.toBeDisabled());
    fireEvent.click(give);
    await waitFor(() => expect(calls('POST', '/gifts').length).toBeGreaterThan(0));
    const first = body(calls('POST', '/gifts')[0]);
    expect(first).toMatchObject({ audience: { kind: 'people', userIds: ['omar'] }, scope: 'both', amountMicros: 5_000_000, shared: false, settlement: 'gift' });
    expect(typeof first.grantKey).toBe('string');
    expect(first.grantKey.length).toBeGreaterThan(10);
  });

  it('keeps the same key for a retry after no answer came back, and a new one after an answer', async () => {
    render(<GrantsPage />);
    await pickOmar();
    fireEvent.change(await screen.findByLabelText('Gift amount'), { target: { value: '5' } });
    const give = await screen.findByRole('button', { name: 'Give $5 each' });
    await waitFor(() => expect(give).not.toBeDisabled());
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => (url === '/api/admin/grants/gifts' ? Promise.reject(new Error('offline')) : original(url, init)));
    fireEvent.click(give);
    await waitFor(() => expect(mockAddToast).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Give $5 each' }));
    await waitFor(() => expect(calls('POST', '/gifts')).toHaveLength(2));
    expect(body(calls('POST', '/gifts')[0]).grantKey).toBe(body(calls('POST', '/gifts')[1]).grantKey);
  });

  it('keeps the key after a server error (it may have saved) and drops it after a clear refusal', async () => {
    render(<GrantsPage />);
    await pickOmar();
    fireEvent.change(await screen.findByLabelText('Gift amount'), { target: { value: '5' } });
    const give = await screen.findByRole('button', { name: 'Give $5 each' });
    await waitFor(() => expect(give).not.toBeDisabled());
    const original = fetchMock.getMockImplementation()!;
    let status = 500;
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url === '/api/admin/grants/gifts' ? Promise.resolve({ ok: false, status, json: async () => ({ error: 'Nope' }) } as Response) : original(url, init),
    );
    fireEvent.click(give);
    await waitFor(() => expect(calls('POST', '/gifts')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Give $5 each' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Give $5 each' }));
    await waitFor(() => expect(calls('POST', '/gifts')).toHaveLength(2));
    expect(body(calls('POST', '/gifts')[0]).grantKey).toBe(body(calls('POST', '/gifts')[1]).grantKey);
    // A clear refusal ends the key: the next try is a new one
    status = 400;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Give $5 each' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Give $5 each' }));
    await waitFor(() => expect(calls('POST', '/gifts')).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Give $5 each' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Give $5 each' }));
    await waitFor(() => expect(calls('POST', '/gifts')).toHaveLength(4));
    expect(body(calls('POST', '/gifts')[3]).grantKey).not.toBe(body(calls('POST', '/gifts')[2]).grantKey);
  });

  it('records what was agreed only for extra usage that will be billed', async () => {
    render(<GrantsPage />);
    await pickOmar();
    fireEvent.change(await screen.findByLabelText('Gift amount'), { target: { value: '5' } });
    expect(screen.queryByLabelText('What was agreed')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'I’ll bill for it' }));
    fireEvent.change(screen.getByLabelText('What was agreed'), { target: { value: 'Agreed on 15 Nov' } });
    const give = await screen.findByRole('button', { name: 'Give $5 each' });
    await waitFor(() => expect(give).not.toBeDisabled());
    fireEvent.click(give);
    await waitFor(() => expect(calls('POST', '/gifts')).toHaveLength(1));
    expect(body(calls('POST', '/gifts')[0])).toMatchObject({ settlement: 'to_bill', note: 'Agreed on 15 Nov' });
  });

  it('needs the note before credit to be billed can be given', async () => {
    render(<GrantsPage />);
    await pickOmar();
    fireEvent.change(await screen.findByLabelText('Gift amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('radio', { name: 'I’ll bill for it' }));
    await waitFor(() => expect(calls('POST', '/preview').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Give $5 each' })).toBeDisabled();
  });

  it('marks credit to be billed as billed, and only that kind', async () => {
    overview = { ...set, gifts: [{ ...set.gifts[0], id: 'g2', settlement: 'to_bill' }, set.gifts[0]] };
    render(<GrantsPage />);
    const buttons = await screen.findAllByTestId('grants-mark-billed');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(calls('PATCH', '/gifts/g2')).toHaveLength(1));
    expect(body(calls('PATCH', '/gifts/g2')[0])).toEqual({ action: 'billed' });
  });

  it('needs a day in the future', async () => {
    render(<GrantsPage />);
    await pickOmar();
    fireEvent.change(await screen.findByLabelText('Gift amount'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: '2020-01-01' } });
    expect(screen.getByText('Pick a day in the future. Every gift ends.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Give $5 each' })).toBeDisabled();
  });
});

describe('Universe AI replies', () => {
  it('saves the replies through the existing limits, and shows the window as it is', async () => {
    render(<GrantsPage />);
    fireEvent.click(within(await screen.findByTestId('grants-ai')).getByRole('button', { name: 'Change' }));
    expect(await screen.findByLabelText('Window in hours')).toHaveValue('5');
    fireEvent.change(screen.getByLabelText('Replies for signed-in people'), { target: { value: '45' } });
    fireEvent.click(screen.getByTestId('grants-save'));
    await waitFor(() => expect(calls('PATCH', '/api/admin/bot-limits')).toHaveLength(1));
    expect(body(calls('PATCH', '/api/admin/bot-limits')[0])).toEqual({ fairUsage: { signedIn: 45, guest: 10 } });
  });
});
