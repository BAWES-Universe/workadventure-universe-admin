/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** The Brick reports inbox and one problem (mock "Brick reports inbox", screens 1 and 2), in the mock's words. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const replace = jest.fn();
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => replace }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'p1' }) }));

import BrickReportsPage from '@/app/admin/brick-reports/page';
import BrickReportPage from '@/app/admin/brick-reports/[id]/page';
import type { Inbox, ProblemDetail, ProblemRow } from '@/lib/brick-reports';

const row = (over: Partial<ProblemRow> = {}): ProblemRow => ({
  id: 'p1',
  kind: 'problem',
  area: 'pages',
  operation: 'read_page',
  title: 'Links inside pages don’t open',
  state: 'new',
  cameBack: false,
  bricks: 9,
  people: 14,
  times: 22,
  thisWeek: 15,
  lastWeek: 7,
  rising: true,
  stoppedWork: true,
  score: 63,
  level: 'high',
  firstSeenAt: '2026-11-19T08:00:00.000Z',
  lastSeenAt: '2026-11-26T08:00:00.000Z',
  ...over,
});

const ok = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
});

describe('the inbox', () => {
  it('shows the tabs with their counts and the rows, highest first, with counts only', async () => {
    const inbox: Inbox = {
      state: 'new',
      counts: { new: 2, working: 3, fixed: 4 },
      problems: [row(), row({ id: 'p2', title: 'Send a weekly summary by email', kind: 'idea', area: 'apps', level: 'low', bricks: 3, people: 3, rising: false })],
    };
    fetchMock.mockImplementation(() => ok(inbox));
    render(<BrickReportsPage />);
    const rows = await screen.findAllByTestId('brick-reports-row');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/brick-reports?state=new');
    expect(screen.getByText('What Bricks hit. Counts only: no names, no chat words.')).toBeTruthy();
    expect(screen.getByTestId('brick-reports-tab-new').textContent).toBe('New 2');
    expect(screen.getByTestId('brick-reports-tab-working').textContent).toBe('Working on 3');
    expect(screen.getByTestId('brick-reports-tab-fixed').textContent).toBe('Fixed 4');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('href')).toBe('/admin/brick-reports/p1');
    expect(within(rows[0]).getByText('High')).toBeTruthy();
    expect(within(rows[0]).getByText('Problem · Pages')).toBeTruthy();
    expect(within(rows[0]).getByText('9 Bricks · 14 people')).toBeTruthy();
    expect(within(rows[0]).getByText('Rising')).toBeTruthy();
    expect(within(rows[1]).getByText('Idea · Apps')).toBeTruthy();
    expect(within(rows[1]).queryByText('Rising')).toBeNull();
  });

  it('another tab reads that tab, and an empty one says so', async () => {
    fetchMock.mockImplementation((url: string) => ok({ state: url.endsWith('fixed') ? 'fixed' : 'new', counts: { new: 1, working: 0, fixed: 0 }, problems: url.endsWith('fixed') ? [] : [row()] }));
    render(<BrickReportsPage />);
    await screen.findAllByTestId('brick-reports-row');
    await act(async () => {
      fireEvent.click(screen.getByTestId('brick-reports-tab-fixed'));
    });
    expect(await screen.findByTestId('brick-reports-empty')).toBeTruthy();
    expect(screen.getByText('Nothing is marked fixed yet.')).toBeTruthy();
  });

  it('someone who is not a super admin is sent back to Orbit', async () => {
    fetchMock.mockImplementation(() => ok({ error: 'no' }, 403));
    render(<BrickReportsPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'));
  });
});

describe('one problem', () => {
  const detail = (over: Partial<ProblemDetail> = {}): ProblemDetail => ({
    ...row(),
    reasons: [
      { label: 'Stopped the work', points: 5 },
      { label: '9 Bricks', points: 27 },
      { label: '14 people', points: 28 },
      { label: '15 this week, 7 last week', points: 3 },
    ],
    sample: ['Tapping a link on each listing does nothing in the chat preview.', 'Nothing opens. Open links in a new tab?'],
    withWords: 6,
    retried: 4,
    ...over,
  });

  it('shows the counts, why it ranks, how often it tried again, and two people’s words picked at random', async () => {
    fetchMock.mockImplementation(() => ok(detail()));
    render(<BrickReportPage />);
    expect(await screen.findByText('Links inside pages don’t open')).toBeTruthy();
    expect(screen.getByText('Why it’s high')).toBeTruthy();
    expect(screen.getByTestId('brick-report-why').textContent).toBe('Stopped the work+59 Bricks+2714 people+2815 this week, 7 last week+3');
    const notes = screen.getAllByTestId('brick-report-sample');
    expect(notes.map((note) => note.textContent)).toEqual(['Tapping a link on each listing does nothing in the chat preview.', 'Nothing opens. Open links in a new tab?']);
    expect(screen.getByText('2 of 6 notes with words, picked at random')).toBeTruthy();
    expect(screen.getByTestId('brick-report-retried').textContent).toBe('Tried again before sending: 4 of 22');
    // What ran is staff-only detail, as code; titles never use it
    expect(screen.getByTestId('brick-report-operation').textContent).toBe('read_page');
  });

  it('shows no words section when nobody added words', async () => {
    fetchMock.mockImplementation(() => ok(detail({ sample: [], withWords: 0, retried: 0, operation: 'none' })));
    render(<BrickReportPage />);
    expect(await screen.findByText('Links inside pages don’t open')).toBeTruthy();
    expect(screen.queryByText('In people’s own words')).toBeNull();
    expect(screen.queryByTestId('brick-report-retried')).toBeNull();
    expect(screen.queryByTestId('brick-report-operation')).toBeNull();
  });

  it('moves it to another tab and reads it again', async () => {
    let state: ProblemRow['state'] = 'new';
    fetchMock.mockImplementation((_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        state = JSON.parse(init.body ?? '{}').state;
        return ok({ state });
      }
      return ok(detail({ state }));
    });
    render(<BrickReportPage />);
    const button = await screen.findByTestId('brick-report-move-working');
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(screen.getByTestId('brick-report-state').textContent).toBe('Working on'));
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/brick-reports/p1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ state: 'working' }) }));
  });

  it('a problem with no notes left says so', async () => {
    fetchMock.mockImplementation(() => ok({ error: 'Not found' }, 404));
    render(<BrickReportPage />);
    expect(await screen.findByText('This report isn’t here.')).toBeTruthy();
  });
});
