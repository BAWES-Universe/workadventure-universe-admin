/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** The Costs page (game #1999): what Universe AI costs us, from the meter's books, in the words the mock uses. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const replace = jest.fn();
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => replace }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import CostsPage from '@/app/admin/ai-providers/costs/page';
import type { CostsReport } from '@/lib/meter-costs';

const report = (over: Partial<CostsReport> = {}): CostsReport => ({
  from: '2026-11-04',
  to: '2026-11-10',
  totals: { costMicros: 39_800_000, people: 38, guests: 84, bricks: 57, computers: 6 },
  goes: [
    { key: 'models', title: 'AI models', ourMicros: 28_400_000, settledMicros: 26_000_000, uses: null, bytes: null, unpriced: 0, sure: 'Measured' },
    { key: 'voice', title: 'Voice', ourMicros: 4_600_000, settledMicros: 0, uses: null, bytes: null, unpriced: 3, sure: 'Estimated' },
    { key: 'computers', title: 'Computers', ourMicros: null, settledMicros: null, uses: null, bytes: null, unpriced: 0, sure: 'Unknown' },
    { key: 'apps', title: 'Apps', ourMicros: 0, settledMicros: 0, uses: 1240, bytes: null, unpriced: 0, sure: 'Estimated' },
    { key: 'files', title: 'Files we keep', ourMicros: null, settledMicros: null, uses: null, bytes: 3_100_000_000, unpriced: 0, sure: 'Unknown' },
  ],
  people: {
    rows: [
      { id: 'khalid', name: 'Khalid', woka: [], costMicros: 11_900_000, bricks: 3, replies: 264, appUses: 96, computerSeconds: 26 * 3600, extraUntil: null },
      { id: 'sara', name: 'Sara', woka: [], costMicros: 6_120_000, bricks: 2, replies: 188, appUses: 41, computerSeconds: 9 * 3600, extraUntil: '2026-11-30T20:00:00.000Z' },
    ],
    total: 38,
    more: { count: 36, costMicros: 21_780_000 },
  },
  bricks: {
    rows: [
      { id: 'b1', name: 'Brick', ownerId: 'khalid', ownerName: 'Khalid', costMicros: 9_710_000, replies: 168, appUses: 71, computerSeconds: 26 * 3600, ownKeyReplies: 0, sure: 'Measured' },
      { id: 'b2', name: 'Studio Brick', ownerId: 'khalid', ownerName: 'Khalid', costMicros: 0, replies: 0, appUses: 0, computerSeconds: 0, ownKeyReplies: 111, sure: 'Paid by someone else' },
    ],
    total: 57,
    more: { count: 55, costMicros: 1 },
  },
  ways: [
    { key: 'answered', title: 'Just answered', costMicros: 22_870_000, replies: 2498, appUses: 0, jobs: 0, computerSeconds: 0 },
    { key: 'app', title: 'Used an app', costMicros: 7_260_000, replies: 0, appUses: 1240, jobs: 0, computerSeconds: 0 },
    { key: 'computer', title: 'Used its computer', costMicros: 9_670_000, replies: 0, appUses: 0, jobs: 38, computerSeconds: 41 * 3600 },
  ],
  guests: [{ universeKey: 'u1', name: 'BAWES Universe', guests: 61, replies: 148, costMicros: 1_320_000 }],
  days: [{ day: '2026-11-10', people: 31, costMicros: 8_900_000 }],
  asked: [{ personId: 'sara', name: 'Sara', woka: [], askedAt: new Date().toISOString() }],
  given: [
    { grantKey: 'g1', personId: 'sara', name: 'Sara', woka: [], multiplier: 5, noLimit: false, startsAt: '2026-11-10T09:00:00.000Z', endsAt: '2026-11-30T20:00:00.000Z', ended: false, givenByName: 'Khalid', settlement: 'to_bill', billedAt: null, note: null, aboveUsualMicros: 4_200_000 },
    { grantKey: 'g2', personId: 'faisal', name: 'Faisal', woka: [], multiplier: 2, noLimit: false, startsAt: '2026-11-01T09:00:00.000Z', endsAt: '2026-11-07T12:00:00.000Z', ended: true, givenByName: 'Khalid', settlement: 'gift', billedAt: null, note: null, aboveUsualMicros: 1_100_000 },
  ],
  ...over,
});

const answer = (data: CostsReport | number = report()) =>
  fetchMock.mockImplementation(() => (typeof data === 'number' ? Promise.resolve({ ok: false, status: data, json: () => Promise.resolve({}) }) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })));

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
});

describe('the Costs page', () => {
  it('shows our count beside the provider’s, each with how sure it is, and says what is not priced yet', async () => {
    answer();
    render(<CostsPage />);
    const goes = await screen.findByTestId('costs-goes');
    expect(within(goes).getByText('Our count $28.40 · settled by the provider $26.00')).toBeTruthy();
    expect(within(goes).getByTestId('costs-goes-models').textContent).toContain('Measured');
    // A price we do not have is never shown as nothing
    expect(within(goes).getByTestId('costs-goes-voice').textContent).toContain('3 uses have no price yet');
    expect(within(goes).getByTestId('costs-goes-computers').textContent).toContain('Our count not known yet');
    expect(within(goes).getByTestId('costs-goes-apps').textContent).toContain('1,240 uses');
    expect(within(goes).getByTestId('costs-goes-files').textContent).toContain('3.1 GB kept · no price set yet');
    expect(within(goes).getByTestId('costs-goes-files').textContent).toContain('Unknown');
  });

  it('lists people with what they did, their extra usage, and one line for the rest', async () => {
    answer();
    render(<CostsPage />);
    const people = await screen.findByTestId('costs-people');
    expect(within(people).getByText('$11.90 · 3 Bricks')).toBeTruthy();
    expect(within(people).getByText('264 replies · 96 app uses · 26 hours of computer')).toBeTruthy();
    expect(within(people).getByText('$6.12 · 2 Bricks · Extra usage until 30 Nov')).toBeTruthy();
    expect(within(people).getByText('36 more people · $21.78')).toBeTruthy();
    expect(within(people).getByRole('link', { name: 'Sara' }).getAttribute('href')).toBe('/admin/users/sara');
  });

  it('says a Brick on its own key is paid by someone else, with no cost to us', async () => {
    answer();
    render(<CostsPage />);
    const bricks = await screen.findByTestId('costs-bricks');
    expect(within(bricks).getByText('$9.71 · 168 replies · 71 app uses · 26 hours of computer')).toBeTruthy();
    expect(within(bricks).getByText('111 replies on their own key')).toBeTruthy();
    expect(within(bricks).getByText('Paid by someone else')).toBeTruthy();
    expect(within(bricks).getByText(/55 more Bricks · /)).toBeTruthy();
  });

  it('shows who asked for more and nobody waiting when none did', async () => {
    answer();
    const { unmount } = render(<CostsPage />);
    const asked = await screen.findByTestId('costs-asked');
    expect(within(asked).getByText(/Today at .* · Computer time is used up for this month/)).toBeTruthy();
    expect(within(asked).getByRole('link', { name: 'Sara' }).getAttribute('href')).toBe('/admin/users/sara');
    unmount();
    answer(report({ asked: [] }));
    render(<CostsPage />);
    expect(await screen.findByText('Nobody is waiting.')).toBeTruthy();
  });

  it('lists everything given, "To bill" or "A gift", with what it cost above the usual and who gave it', async () => {
    answer();
    render(<CostsPage />);
    const given = await screen.findByTestId('costs-given');
    expect(within(given).getByText('5 times the usual · 10 Nov to 30 Nov')).toBeTruthy();
    expect(within(given).getByText('$4.20 above the usual so far · given by Khalid')).toBeTruthy();
    expect(within(given).getByText('To bill')).toBeTruthy();
    expect(within(given).getByText('Twice the usual · 1 Nov to 7 Nov, ended')).toBeTruthy();
    expect(within(given).getByText('A gift')).toBeTruthy();
    expect(within(given).getByText(/A gift is never owed\. “To bill” stays until you mark it billed on the person’s page\./)).toBeTruthy();
  });

  it('shows what a Brick did, guests by universe and the days', async () => {
    answer();
    render(<CostsPage />);
    const ways = await screen.findByTestId('costs-ways');
    expect(within(ways).getByText('$22.87 · 2,498 replies')).toBeTruthy();
    expect(within(ways).getByText('$7.26 · 1,240 app uses')).toBeTruthy();
    expect(within(ways).getByText('$9.67 · 38 jobs · 41 hours of computer')).toBeTruthy();
    expect(within(screen.getByTestId('costs-guests')).getByText('$1.32 · 61 guests · 148 replies')).toBeTruthy();
    expect(within(screen.getByTestId('costs-days')).getByText('31 people')).toBeTruthy();
  });

  it('reads the dates again when they change, and sends only real dates', async () => {
    answer();
    render(<CostsPage />);
    await screen.findByTestId('costs-goes');
    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/admin\/meter-costs\?from=2026-10-01&to=\d{4}-\d{2}-\d{2}$/);
    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows no figures while the first date is after the last, and reads again once they are in order', async () => {
    answer();
    render(<CostsPage />);
    await screen.findByTestId('costs-goes');
    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2999-01-01' } });
    expect((await screen.findByTestId('costs-dates-note')).textContent).toBe('The first date comes after the last one. Put them in order to see the costs.');
    expect(screen.queryByTestId('costs-goes')).toBeNull();
    expect(screen.queryByText('cost to us')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    expect((await screen.findByTestId('costs-dates-note')).textContent).toBe('Pick both dates to see the costs.');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    expect(await screen.findByTestId('costs-goes')).toBeTruthy();
    expect(screen.queryByTestId('costs-dates-note')).toBeNull();
  });

  it('sends someone who is not a super admin away, and says when it could not load', async () => {
    answer(403);
    const { unmount } = render(<CostsPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'));
    unmount();
    answer(500);
    render(<CostsPage />);
    expect(await screen.findByText(/We couldn’t load the costs/)).toBeTruthy();
  });
});
