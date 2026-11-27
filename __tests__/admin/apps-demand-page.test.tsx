/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** "Apps: use and demand" (spec "Paying for Apps", sections 21 and 22), in the words of the approved mock. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const replace = jest.fn();
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => replace }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import AppsDemandPage from '@/app/admin/ai-providers/apps/page';
import type { AppRow, DemandReport } from '@/lib/app-demand';

const app = (over: Partial<AppRow> = {}): AppRow => ({
  key: 'video',
  name: 'Instant video',
  kind: 'instant',
  uses: 412,
  people: 96,
  costMicros: 118_400_000,
  unpriced: 0,
  ended: 100,
  failed: 4,
  refundedMicros: 3_000_000,
  allFailedRefunded: true,
  byRoute: { composio: { uses: 412, costMicros: 118_400_000, unpriced: 0 }, universe: { uses: 0, costMicros: null, unpriced: 0 } },
  route: 'composio',
  routeVersion: 0,
  routeChangedAt: null,
  own: { ready: false, why: ['We have no version of our own for this App yet.'], passedChecksOn: null, topPriceMicros: null },
  onOwnVersionAtMostMicros: null,
  ...over,
});

const report = (over: Partial<DemandReport> = {}): DemandReport => ({
  from: '2026-10-17',
  to: '2026-11-15',
  days: 30,
  totals: { uses: 14017, people: 402, costMicros: 170_950_000, asks: 156, cost: { state: 'measured', unpriced: 0, estimated: 0, notCounted: 0, mismatched: 0 } },
  apps: [
    app(),
    app({ key: 'gmail', name: 'Gmail', kind: 'own', uses: 5940, people: 188, costMicros: 1_780_000, ended: 5940, failed: 24, allFailedRefunded: false, refundedMicros: null, route: 'universe', routeVersion: 2, own: { ready: true, why: [], passedChecksOn: '2026-11-12T00:00:00.000Z', topPriceMicros: 100 } }),
  ],
  asked: [
    { name: 'Talabat orders', times: 64, people: 41 },
    { name: 'WhatsApp messages', times: 52, people: 37 },
  ],
  askedMore: 3,
  ...over,
});

const answer = (data: DemandReport | number = report()) =>
  fetchMock.mockImplementation(() => (typeof data === 'number' ? Promise.resolve({ ok: false, status: data, json: () => Promise.resolve({}) }) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })));

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
});

describe('Apps: use and demand', () => {
  it('shows the totals, the Apps by cost to us with what each runs on, and the names asked for', async () => {
    answer();
    render(<AppsDemandPage />);
    expect(await screen.findByText('14,017')).toBeInTheDocument();
    expect(screen.getByText('402')).toBeInTheDocument();
    expect(screen.getByText('$170.95')).toBeInTheDocument();
    expect(screen.getByText('cost to us')).toBeInTheDocument();
    expect(screen.queryByTestId('apps-cost-note')).not.toBeInTheDocument();
    expect(screen.getByText('156')).toBeInTheDocument();

    const video = screen.getByTestId('apps-row-video');
    expect(within(video).getByText('Instant video')).toBeInTheDocument();
    expect(video).toHaveTextContent('412 uses');
    expect(video).toHaveTextContent('96 people');
    expect(video).toHaveTextContent('Instant');
    expect(video).toHaveTextContent('$118.40 to us');
    expect(video).toHaveTextContent('4% failed');
    expect(screen.getByTestId('apps-runs-on-video')).toHaveTextContent('Runs on Composio');
    expect(screen.getByTestId('apps-runs-on-gmail')).toHaveTextContent('Runs on Universe');
    expect(screen.getByTestId('apps-row-gmail')).toHaveTextContent('Their own account');

    const askedRows = screen.getAllByTestId('apps-asked-row');
    expect(askedRows).toHaveLength(2);
    expect(askedRows[0]).toHaveTextContent('Talabat orders');
    expect(askedRows[0]).toHaveTextContent('64 times · by 41 people');
    expect(screen.getByText(/3 more App names were asked for/)).toBeInTheDocument();
    // Only the name is kept, and the page says so
    expect(screen.getByText(/Only the App’s name is kept, never what people wrote/)).toBeInTheDocument();
  });

  it('says the headline cost is a part, never the whole, while some uses have no price or some runs are not settled yet; a measured total says nothing extra', async () => {
    answer(report({ totals: { uses: 10, people: 3, costMicros: 70_000, asks: 0, cost: { state: 'incomplete', unpriced: 2, estimated: 1, notCounted: 3, mismatched: 0 } } }));
    render(<AppsDemandPage />);
    expect(await screen.findByText('cost to us so far')).toBeInTheDocument();
    expect(screen.queryByText('cost to us')).not.toBeInTheDocument();
    expect(screen.getByTestId('apps-cost-note')).toHaveTextContent('only part of it');
    expect(screen.getByTestId('apps-cost-note')).toHaveTextContent('2 uses have no price yet');
    expect(screen.getByTestId('apps-cost-note')).toHaveTextContent('3 runs are not in this total yet');
  });

  it('a total that holds a run at a wrong figure says it is being corrected, and never calls it a part', async () => {
    answer(report({ totals: { uses: 10, people: 3, costMicros: 70_000, asks: 0, cost: { state: 'correcting', unpriced: 0, estimated: 0, notCounted: 0, mismatched: 2 } } }));
    render(<AppsDemandPage />);
    expect(await screen.findByText('cost to us (being corrected)')).toBeInTheDocument();
    expect(screen.getByTestId('apps-cost-note')).toHaveTextContent('2 runs are counted at a figure that differs from the provider’s own, and will be corrected');
    expect(screen.getByTestId('apps-cost-note')).not.toHaveTextContent('only part of it');
  });

  it('a total priced partly with estimates says so', async () => {
    answer(report({ totals: { uses: 10, people: 3, costMicros: 70_000, asks: 0, cost: { state: 'estimated', unpriced: 0, estimated: 4, notCounted: 0, mismatched: 0 } } }));
    render(<AppsDemandPage />);
    expect(await screen.findByText('cost to us (partly estimated)')).toBeInTheDocument();
    expect(screen.getByTestId('apps-cost-note')).toHaveTextContent('4 uses are priced with our estimate');
  });

  it('uses only the word Apps: never tool, MCP or connector', async () => {
    answer();
    const { container } = render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    const text = `${container.textContent} ${document.body.textContent}`;
    expect(text).not.toMatch(/\b(tools?|mcp|connectors?)\b/i);
  });

  it('opens an App to choose what it runs on, with the note that people see no change, and cannot pick our own version before it is ready', async () => {
    answer();
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    const sheet = await screen.findByTestId('apps-sheet');
    expect(within(sheet).getByTestId('apps-sheet-line')).toHaveTextContent('412 uses · 96 people · 4% failed, all refunded');
    expect(within(sheet).getByTestId('apps-sheet-note')).toHaveTextContent('People see no change: same name, same price, same credit.');
    expect(within(sheet).getByTestId('apps-sheet-note')).toHaveTextContent('Runs already going finish where they started. You can move it back any time.');
    expect(within(sheet).getByTestId('apps-route-universe')).toBeDisabled();
    expect(within(sheet).getByText('We have no version of our own for this App yet.')).toBeInTheDocument();
    expect(within(sheet).getByTestId('apps-route-save')).toBeDisabled();
  });

  it('saves a move with the version the admin was looking at, and reads the page again', async () => {
    const ready = report({ apps: [app({ own: { ready: true, why: [], passedChecksOn: '2026-11-12T00:00:00.000Z', topPriceMicros: 100 }, onOwnVersionAtMostMicros: 41_200_000 })] });
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(init?.method === 'PUT' ? { route: 'universe', version: 1 } : ready) }));
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    const sheet = await screen.findByTestId('apps-sheet');
    expect(within(sheet).getByText(/Our own version passed its checks on 12 Nov/)).toBeInTheDocument();
    expect(within(sheet).getByTestId('apps-sheet-note')).toHaveTextContent('would cost us at most $41.20 on our own version');
    fireEvent.click(within(sheet).getByTestId('apps-route-universe'));
    fireEvent.click(within(sheet).getByTestId('apps-route-save'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe('/api/admin/app-routes/video');
    expect(JSON.parse(put[1].body)).toEqual({ route: 'universe', expectedVersion: 0 });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/apps-demand')).length).toBeGreaterThanOrEqual(2));
  });

  it('says so when someone else moved the App meanwhile, and shows the newer state instead of saving over it', async () => {
    const ready = report({ apps: [app({ own: { ready: true, why: [], passedChecksOn: null, topPriceMicros: 100 } })] });
    fetchMock.mockImplementation((url: string, init?: { method?: string }) =>
      init?.method === 'PUT'
        ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ code: 'stale', route: 'universe', version: 1 }) })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ready) }),
    );
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    const sheet = await screen.findByTestId('apps-sheet');
    fireEvent.click(within(sheet).getByTestId('apps-route-universe'));
    fireEvent.click(within(sheet).getByTestId('apps-route-save'));
    expect(await within(sheet).findByTestId('apps-sheet-error')).toHaveTextContent('Someone moved this App since you opened it');
  });

  it('keeps the stale-save note when reading the page again shows the newer version of the App', async () => {
    let version = 0;
    const read = () => report({ apps: [app({ routeVersion: version, route: version > 0 ? 'universe' : 'composio', own: { ready: true, why: [], passedChecksOn: null, topPriceMicros: 100 } })] });
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') {
        version = 1;
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ code: 'stale', route: 'universe', version: 1 }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read()) });
    });
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    let sheet = await screen.findByTestId('apps-sheet');
    fireEvent.click(within(sheet).getByTestId('apps-route-universe'));
    fireEvent.click(within(sheet).getByTestId('apps-route-save'));
    // The sheet is made again for the newer version, and the note is still there to read
    await waitFor(() => expect(screen.getByTestId('apps-runs-on-video')).toHaveTextContent('Runs on Universe'));
    sheet = screen.getByTestId('apps-sheet');
    expect(within(sheet).getByTestId('apps-sheet-error')).toHaveTextContent('Someone moved this App since you opened it');
    // Opening it again later starts clean
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('apps-sheet')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('apps-row-video'));
    expect(within(await screen.findByTestId('apps-sheet')).queryByTestId('apps-sheet-error')).not.toBeInTheDocument();
  });

  it('a save that finishes after its sheet was closed does not close or warn in the same App opened again', async () => {
    let finish: (value: unknown) => void = () => {};
    const ready = report({ apps: [app({ own: { ready: true, why: [], passedChecksOn: null, topPriceMicros: 100 } })] });
    fetchMock.mockImplementation((url: string, init?: { method?: string }) =>
      init?.method === 'PUT' ? new Promise((resolve) => (finish = resolve)) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ready) }),
    );
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    let sheet = await screen.findByTestId('apps-sheet');
    fireEvent.click(within(sheet).getByTestId('apps-route-universe'));
    fireEvent.click(within(sheet).getByTestId('apps-route-save'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    // Close it while the save is still going, then open the same App again
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('apps-sheet')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('apps-row-video'));
    sheet = await screen.findByTestId('apps-sheet');
    // The first save now ends with "someone moved it": the new sheet must not show that, and a success must not close it
    finish({ ok: false, status: 409, json: () => Promise.resolve({ code: 'stale', route: 'universe', version: 1 }) });
    // The first save has ended: it asked for the page again
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'PUT')).toHaveLength(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByTestId('apps-sheet')).toBeInTheDocument();
    expect(within(screen.getByTestId('apps-sheet')).queryByTestId('apps-sheet-error')).not.toBeInTheDocument();
  });

  it('does not say the page is reloaded when reading it again failed', async () => {
    const ready = report({ apps: [app({ own: { ready: true, why: [], passedChecksOn: null, topPriceMicros: 100 } })] });
    let reads = 0;
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ code: 'stale', route: 'universe', version: 1 }) });
      // The GitHub App read is not a read of the page
      if (url === '/api/admin/github-app') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      reads += 1;
      return reads === 1 ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ready) }) : Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    });
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    const sheet = await screen.findByTestId('apps-sheet');
    fireEvent.click(within(sheet).getByTestId('apps-route-universe'));
    fireEvent.click(within(sheet).getByTestId('apps-route-save'));
    const said = await within(await screen.findByTestId('apps-sheet')).findByTestId('apps-sheet-error');
    expect(said).toHaveTextContent('could not be reloaded');
    expect(said).not.toHaveTextContent('It is reloaded');
    // It says what to do: the sheet cannot reload the Apps itself, so it is told to try loading them again, then open the App again
    expect(said).toHaveTextContent('try loading the Apps again, then open the App again');
  });

  it('moves between the two routes with the arrow keys, Tab stops only on the picked one, and the one that is off is skipped', async () => {
    const ready = report({ apps: [app({ own: { ready: true, why: [], passedChecksOn: null, topPriceMicros: 100 } })] });
    answer(ready);
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    const sheet = await screen.findByTestId('apps-sheet');
    const composio = within(sheet).getByTestId('apps-route-composio');
    const universe = within(sheet).getByTestId('apps-route-universe');
    expect([composio.tabIndex, universe.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(composio, { key: 'ArrowDown' });
    expect(universe).toHaveAttribute('aria-checked', 'true');
    expect(universe).toHaveFocus();
    expect([composio.tabIndex, universe.tabIndex]).toEqual([-1, 0]);
    fireEvent.keyDown(universe, { key: 'ArrowUp' });
    expect(composio).toHaveAttribute('aria-checked', 'true');
  });

  it('shows no figures of the days that were selected before while the new days are read', async () => {
    let finish: (value: unknown) => void = () => undefined;
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('days=7') ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(report()) }),
    );
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-range-7'));
    expect(screen.queryByText('14,017')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('days=7'))).toBe(true));
    await act(async () => finish({ ok: true, status: 200, json: () => Promise.resolve(report({ days: 7, totals: { uses: 99, people: 5, costMicros: 1_000_000, asks: 1, cost: { state: 'measured', unpriced: 0, estimated: 0, notCounted: 0, mismatched: 0 } } })) }));
    expect(await screen.findByText('99')).toBeInTheDocument();
  });

  it('goes back to Orbit home for anyone who is not a super admin, and offers a retry when the read fails', async () => {
    answer(403);
    const { unmount } = render(<AppsDemandPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'));
    unmount();
    answer(500);
    render(<AppsDemandPage />);
    expect(await screen.findByText(/the Apps/i)).toBeInTheDocument();
  });

  it('reads a different range when asked', async () => {
    answer();
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-range-7'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('days=7'))).toBe(true));
  });
});

/** Universe's own GitHub App on the Apps page (game #2041): the one place a super admin starts it, with no typed address. */
describe('GitHub row: Universe’s GitHub App', () => {
  const github = (over: Partial<AppRow> = {}) => app({ key: 'github', name: 'GitHub', kind: 'own', ...over });
  const serve = (githubAnswer: { made: boolean; slug?: string; url?: string } | number) =>
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/admin/github-app') {
        return typeof githubAnswer === 'number' ? Promise.resolve({ ok: false, status: githubAnswer, json: () => Promise.resolve({}) }) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(githubAnswer) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(report({ apps: [app(), github()] })) });
    });

  it('before the App is made: the row says Composio and points at the setup, and the sheet has the button to the setup page', async () => {
    serve({ made: false });
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    expect(screen.getByTestId('apps-runs-on-github')).toHaveTextContent('Runs on Composio');
    expect(screen.getByTestId('apps-github-hint')).toHaveTextContent('Tap to set up Universe’s GitHub App');
    expect(screen.getByTestId('apps-github-hint')).not.toHaveTextContent('own');
    // Only GitHub gets it
    expect(screen.getByTestId('apps-row-video')).not.toHaveTextContent('GitHub App');

    fireEvent.click(screen.getByTestId('apps-row-github'));
    const sheet = await screen.findByTestId('apps-sheet');
    const button = within(sheet).getByTestId('apps-github-setup');
    expect(button).toHaveTextContent('Set up Universe’s GitHub App');
    // A link Orbit follows itself, not an address someone types
    expect(button.getAttribute('href')).toBe('/admin/github-app');
    expect(within(sheet).getByTestId('apps-github-text')).toHaveTextContent('keep running as they do now');
    // The guidance names no provider: what GitHub runs on is the Runs on choice's job (operator-only)
    expect(within(sheet).getByTestId('apps-github-text')).not.toHaveTextContent('Composio');
    expect(within(sheet).queryByTestId('apps-github-status')).not.toBeInTheDocument();
    // How GitHub runs through Composio is untouched: the Runs on choice is still there, in its old words
    expect(within(sheet).getByTestId('apps-route-composio')).toBeInTheDocument();
    expect(within(sheet).getByTestId('apps-route-universe')).toHaveTextContent('We have no version of our own for this App yet.');
    expect(within(sheet).queryByTestId('apps-github-runs-on-note')).not.toBeInTheDocument();
  });

  it('once the App is made: the row STILL says Runs on Composio (people still use it) with the line about new connections, and the sheet shows the status, where it lives, no setup button and new words under Runs on', async () => {
    serve({ made: true, slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe' });
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    await waitFor(() => expect(screen.getByTestId('apps-github-hint')).toHaveTextContent('New connections use Universe’s GitHub App'));
    expect(screen.getByTestId('apps-runs-on-github')).toHaveTextContent('Runs on Composio');
    // Other Apps are not touched
    expect(screen.getByTestId('apps-runs-on-video')).toHaveTextContent('Runs on Composio');
    expect(screen.getByTestId('apps-row-video')).not.toHaveTextContent('New connections');

    fireEvent.click(screen.getByTestId('apps-row-github'));
    const sheet = await screen.findByTestId('apps-sheet');
    expect(within(sheet).getByTestId('apps-github-status')).toHaveTextContent('Set up');
    expect(within(sheet).queryByTestId('apps-github-setup')).not.toBeInTheDocument();
    expect(within(sheet).getByTestId('apps-github-open').getAttribute('href')).toBe('https://github.com/apps/bawes-universe');
    expect(within(sheet).getByTestId('apps-github-open')).toHaveTextContent('bawes-universe');
    expect(within(sheet).getByTestId('apps-github-runs-on-note')).toHaveTextContent('Only for GitHub connections people made before.');
    expect(within(sheet).getByTestId('apps-github-runs-on-note')).not.toHaveTextContent('Composio');
    expect(within(sheet).getByTestId('apps-route-universe')).toHaveTextContent('New connections use Universe’s GitHub App above.');
    expect(within(sheet).getByTestId('apps-route-universe')).not.toHaveTextContent('no version of our own');
    // The choice itself works as before: still Composio, still not pickable
    expect(within(sheet).getByTestId('apps-route-composio')).toBeInTheDocument();
    expect(within(sheet).getByTestId('apps-route-universe')).toBeDisabled();
  });

  it('made but its address not known (another server just made it): says it is set up and shows no link', async () => {
    serve({ made: true });
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-github'));
    const sheet = await screen.findByTestId('apps-sheet');
    await waitFor(() => expect(within(sheet).getByTestId('apps-github-status')).toBeInTheDocument());
    expect(within(sheet).queryByTestId('apps-github-open')).not.toBeInTheDocument();
    expect(within(sheet).queryByTestId('apps-github-setup')).not.toBeInTheDocument();
  });

  it('when it cannot be read, the setup is still offered (the setup page says when the App is already made), and the page works as before', async () => {
    serve(500);
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    expect(screen.getByTestId('apps-runs-on-github')).toHaveTextContent('Runs on Composio');
    fireEvent.click(screen.getByTestId('apps-row-github'));
    const sheet = await screen.findByTestId('apps-sheet');
    expect(within(sheet).getByTestId('apps-github-setup')).toBeInTheDocument();
  });

  it('no other App’s sheet has the GitHub panel', async () => {
    serve({ made: false });
    render(<AppsDemandPage />);
    await screen.findByText('14,017');
    fireEvent.click(screen.getByTestId('apps-row-video'));
    const sheet = await screen.findByTestId('apps-sheet');
    expect(within(sheet).queryByTestId('apps-github-panel')).not.toBeInTheDocument();
  });
});
