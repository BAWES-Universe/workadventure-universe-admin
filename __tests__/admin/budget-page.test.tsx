/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The Budget page: a raise outside the range is refused with a plain line before anything is sent, and "In effect" is said only when the
 * backend saved the number and read it back. Every amount is typed here: the page holds none.
 */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const replace = jest.fn();
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => replace }));
const mockAddToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: mockAddToast }) }));
let query = '';
jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(query) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import BudgetPage from '@/app/admin/ai-providers/budget/page';
import type { AccountView, BudgetReport } from '@/lib/budget/types';

const MILLION = 1_000_000;

const report: BudgetReport = {
  readAt: '2026-11-18T09:00:00.000Z',
  monthTurns: '2026-12-01T00:00:00.000Z',
  covers: 'Covers Speech, Apps, Computers and new Storage. Chat is not in it.',
  basis: 'Forecasts use the last 7 days.',
  total: { budgetMicros: 50 * MILLION, spentMicros: 20 * MILLION, heldMicros: 0, forecastMicros: 40 * MILLION, platformMicros: 45 * MILLION, unsetAreas: [] },
  alerts: [],
  areas: [
    {
      key: 'computers',
      title: 'Computers',
      covers: 'Computer time for Bricks.',
      budgetMicros: 50 * MILLION,
      spentMicros: 20 * MILLION,
      heldMicros: 0,
      forecastMicros: 40 * MILLION,
      runsOutAt: null,
      usedPercent: 40,
      state: 'ok',
      stateLine: 'On track',
      facts: [],
      offers: [{ micros: 60 * MILLION, words: 'What the month needs' }],
      numberId: 'meter:poolCeilingMicros',
      reading: null,
      unpricedEvents: 0,
    },
  ],
  accounts: [],
  numbers: [
    {
      id: 'meter:poolCeilingMicros',
      label: 'Computers budget',
      hint: 'What Universe pays for computers in a month.',
      unit: 'micros',
      group: 'budget',
      area: 'computers',
      value: 50 * MILLION,
      range: { min: 1, max: 200 * MILLION },
      lastChange: null,
    },
  ],
  changes: [],
  asks: [],
  funding: { grossMicros: 20 * MILLION, paidByMembersMicros: 0, perTask: [] },
};

const ok = (data: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(data) });
let putAnswer: { status: number; body: unknown };
const puts = () => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'PUT');

beforeEach(() => {
  fetchMock.mockReset();
  mockAddToast.mockReset();
  query = 'raise=meter:poolCeilingMicros';
  putAnswer = { status: 200, body: { ok: true, value: 70 * MILLION, inEffect: true } };
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/admin/budget' && method === 'GET') return ok(report);
    if (url === '/api/admin/budget/numbers' && method === 'PUT') return ok(putAnswer.body, putAnswer.status);
    return ok({}, 404);
  });
});

async function openOther() {
  render(<BudgetPage />);
  fireEvent.click(await screen.findByText('Another amount'));
  return screen.getByTestId('raise-other') as HTMLInputElement;
}

describe('the raise sheet on the Budget page', () => {
  it('opens from a notice, with the amounts from the forecast', async () => {
    render(<BudgetPage />);
    expect(await screen.findByTestId('raise-now')).toHaveTextContent('$20 spent of $50');
    expect(screen.getByText('$60 a month')).toBeInTheDocument();
  });

  it('refuses an amount outside the range with a plain line, and sends nothing', async () => {
    const input = await openOther();
    fireEvent.change(input, { target: { value: '500' } });
    expect(screen.getByTestId('raise-range')).toHaveTextContent('That is outside what can be saved. Up to $200.');
    expect(screen.getByTestId('raise-confirm')).toBeDisabled();
    expect(puts()).toHaveLength(0);
  });

  it('shows the new monthly total before saving', async () => {
    const input = await openOther();
    fireEvent.change(input, { target: { value: '70' } });
    expect(screen.getByTestId('raise-total')).toHaveTextContent('becomes $70');
    expect(screen.getByTestId('raise-total')).toHaveTextContent('now $50');
  });

  it('says "In effect" only after the backend read the number back', async () => {
    const input = await openOther();
    fireEvent.change(input, { target: { value: '70' } });
    fireEvent.click(screen.getByTestId('raise-confirm'));
    await waitFor(() => expect(mockAddToast).toHaveBeenCalled());
    expect(mockAddToast.mock.calls[0][0].description).toMatch(/^In effect: Computers budget is now \$70/);
    expect(JSON.parse((puts()[0][1] as RequestInit).body as string)).toEqual({ id: 'meter:poolCeilingMicros', value: 70 * MILLION });
  });

  it('does not say "In effect" when the read-back did not confirm it', async () => {
    putAnswer = { status: 200, body: { ok: true, value: 70 * MILLION, inEffect: false } };
    const input = await openOther();
    fireEvent.change(input, { target: { value: '70' } });
    fireEvent.click(screen.getByTestId('raise-confirm'));
    expect(await screen.findByTestId('raise-error')).toHaveTextContent('could not confirm it is in effect');
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('shows the backend’s own line when it refuses the number', async () => {
    putAnswer = { status: 422, body: { ok: false, error: 'That is above the most that can be saved.' } };
    const input = await openOther();
    fireEvent.change(input, { target: { value: '70' } });
    fireEvent.click(screen.getByTestId('raise-confirm'));
    expect(await screen.findByTestId('raise-error')).toHaveTextContent('That is above the most that can be saved.');
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('sends a person who is not a super admin back to the admin home', async () => {
    fetchMock.mockImplementation(() => ok({ error: 'Forbidden' }, 403));
    render(<BudgetPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'));
  });
});

const account = (over: Partial<AccountView>): AccountView => ({
  key: 'x',
  name: 'X',
  paysFor: 'Things',
  kind: 'balance',
  balanceMicros: 5 * MILLION,
  planLeftPercent: null,
  planRenewsAt: null,
  state: 'ok',
  line: 'Fine.',
  checkedAt: '2026-11-18T09:00:00.000Z',
  checkedBy: 'company',
  url: 'https://billing.example.test',
  daysLeft: null,
  thirtyDayMicros: null,
  canVerify: true,
  facts: [],
  overdue: false,
  addFunds: false,
  ...over,
});

describe('the company rows', () => {
  const soniox = account({ key: 'soniox', name: 'Soniox', kind: 'unknown', balanceMicros: null, state: 'unknown', line: 'Not connected. Soniox gives its balance only to an organization key.', canVerify: true, connection: { connected: false, what: 'Soniox organization key' } });
  const agent37 = account({ key: 'agent37', name: 'Agent37', state: 'zero', overdue: true, line: 'The wallet is overdrawn.', facts: ['Auto top up is off (it is set on Agent37’s own page)'], addFunds: true, balanceMicros: -3 * MILLION });

  beforeEach(() => {
    query = '';
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/admin/budget' && method === 'GET') return ok({ ...report, accounts: [soniox, agent37] });
      if (url === '/api/admin/budget/soniox-key' && method === 'PUT') return ok({ account: { ...soniox, state: 'ok', line: 'About 20 days left.', balanceMicros: 31 * MILLION, connection: { connected: true, what: 'Soniox organization key' } } });
      if (url === '/api/admin/budget/funds' && method === 'POST') return ok({ url: 'https://checkout.example.test/pay/1', amountUsd: 25 });
      return ok({}, 404);
    });
    window.open = jest.fn();
  });

  it('shows what a company tells us, an overdue wallet, and "Not connected" instead of a number', async () => {
    render(<BudgetPage />);
    expect(await screen.findByTestId('account-soniox-line')).toHaveTextContent('Not connected');
    expect(screen.queryByTestId('verify-soniox')).toBeNull();
    expect(screen.getByTestId('account-agent37-line')).toHaveTextContent('overdrawn');
    expect(screen.getByText('Auto top up is off (it is set on Agent37’s own page)')).toBeInTheDocument();
  });

  it('connects Soniox with an organization key and says so', async () => {
    render(<BudgetPage />);
    fireEvent.click(await screen.findByTestId('connect-soniox'));
    fireEvent.change(screen.getByTestId('connect-key'), { target: { value: 'snx_org_abc' } });
    fireEvent.click(screen.getByTestId('connect-save'));
    await waitFor(() => expect(mockAddToast).toHaveBeenCalled());
    expect(mockAddToast.mock.calls[0][0].description).toContain('Soniox is connected');
    expect(JSON.parse((puts()[0][1] as RequestInit).body as string)).toEqual({ key: 'snx_org_abc' });
  });

  it('asks Agent37 for a payment link for the typed amount and opens it', async () => {
    render(<BudgetPage />);
    fireEvent.click(await screen.findByTestId('funds-agent37'));
    fireEvent.change(screen.getByTestId('funds-amount'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('funds-ask'));
    expect(await screen.findByTestId('funds-link')).toHaveAttribute('href', 'https://checkout.example.test/pay/1');
    expect(window.open).toHaveBeenCalledWith('https://checkout.example.test/pay/1', '_blank', 'noopener,noreferrer');
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/admin/budget/funds')!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ company: 'agent37', amountUsd: 25 });
  });
});
