/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

/**
 * The one-time "GitHub for Universe" setup page (game #2041). It says what is about to happen and opens GitHub's Create page
 * only when asked, in a window of its own (never taking over the game tab), waits, and shows "Set up" by itself.
 */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('@/app/admin/components/ds', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));

import GitHubAppSetupPage from '@/app/admin/github-app/page';
import { GITHUB_WINDOW } from '@/app/admin/github-app/github-window';

const FORM = { action: 'https://github.com/organizations/BAWES-Universe/settings/apps/new?state=abc', manifest: '{"name":"BAWES Universe"}' };
const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });

let submit: jest.SpyInstance;
/** What each form sent to GitHub carried: where it was posted, to which window, and the filled-in form. */
let sent: { action: string; target: string; manifest: string }[];
let open: jest.SpyInstance;

/** Answers by method and address: the form (or the existing app) on POST, whether it is made on GET. */
function backend(
  options: {
    existing?: { slug: string; url: string; appId: number };
    made?: () => { made: boolean; appId?: number; slug?: string; url?: string };
    /** The app a form asked for again is set to replace: the one the store holds now, which another admin may have changed since the page loaded */
    kept?: () => number | null;
    /** Holds the answer to the next form asked for until released */
    hold?: () => Promise<void> | undefined;
  } = {},
) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      const wait = options.hold?.();
      if (wait) await wait;
      const again = JSON.parse(init.body ?? '{}').again === true;
      if (options.existing && !again) return json({ existing: options.existing });
      return json({ ...FORM, replaces: options.kept ? options.kept() : (options.existing?.appId ?? null) });
    }
    return json(options.made ? options.made() : { made: false });
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  sent = [];
  submit = jest.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
    sent.push({ action: this.getAttribute('action') ?? '', target: this.getAttribute('target') ?? '', manifest: (this.querySelector('input[name=manifest]') as HTMLInputElement).value });
  });
  open = jest.spyOn(window, 'open').mockReturnValue({} as Window);
});
afterEach(() => {
  jest.useRealTimers();
  submit.mockRestore();
  open.mockRestore();
});

describe('GitHub for Universe setup page', () => {
  it('explains the step first and does not open GitHub on its own', async () => {
    backend();
    render(<GitHubAppSetupPage />);
    await settle();
    expect(screen.getByText(/GitHub opens in its own window with everything filled in/)).toBeTruthy();
    expect(screen.getByText('Create GitHub App')).toBeTruthy();
    expect(screen.getByText('Only an owner of BAWES-Universe on GitHub can press it.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue to GitHub' })).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens GitHub in its own window inside the tap, then waits', async () => {
    backend();
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    expect(open).toHaveBeenCalledWith('', GITHUB_WINDOW, expect.any(String));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ action: FORM.action, target: GITHUB_WINDOW, manifest: FORM.manifest }]);
    // The form is not left behind on the page
    expect(document.querySelector('form')).toBeNull();
    expect(screen.getByText(/Waiting for you on GitHub/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open GitHub again' })).toBeTruthy();
  });

  it('asks for the form again when it has waited too long, and sends the new one to the window already open', async () => {
    let calls = 0;
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return json({ action: `${FORM.action}-${++calls}`, manifest: FORM.manifest });
      return json({ made: false });
    });
    render(<GitHubAppSetupPage />);
    await settle();
    await act(async () => {
      jest.advanceTimersByTime(51 * 60 * 1000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    // The window is opened inside the tap, before the wait for the new form
    expect(open).toHaveBeenCalledTimes(1);
    await settle();
    await settle();
    expect(calls).toBe(2);
    expect(sent).toEqual([{ action: `${FORM.action}-2`, target: GITHUB_WINDOW, manifest: FORM.manifest }]);
    expect(screen.getByText(/Waiting for you on GitHub/)).toBeTruthy();
  });

  it('closes the window and says so when the new form cannot be had', async () => {
    const popup = { close: jest.fn() };
    open.mockReturnValue(popup as unknown as Window);
    let first = true;
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        if (first) {
          first = false;
          return json(FORM);
        }
        return json({ error: 'Could not open GitHub' }, false);
      }
      return json({ made: false });
    });
    render(<GitHubAppSetupPage />);
    await settle();
    await act(async () => {
      jest.advanceTimersByTime(51 * 60 * 1000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    await settle();
    await settle();
    expect(popup.close).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Could not open GitHub/);
  });

  it('says so, and goes nowhere, when the browser blocks the window', async () => {
    backend();
    open.mockReturnValue(null);
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    expect(screen.getByRole('alert').textContent).toMatch(/blocked the window/);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue to GitHub' })).toBeTruthy();
  });

  it('shows Set up by itself once the app is made', async () => {
    let made = false;
    backend({ made: () => (made ? { made: true, appId: 7, slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe' } : { made: false }) });
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByText(/Waiting for you on GitHub/)).toBeTruthy();
    made = true;
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByText(/GitHub is set up/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'bawes-universe' }).getAttribute('href')).toBe('https://github.com/apps/bawes-universe');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/github-app');
  });

  it('asks again after an hour of waiting when GitHub is opened again', async () => {
    let made = false;
    backend({ made: () => (made ? { made: true, appId: 7, slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe' } : { made: false }) });
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    // An hour passes without the app being made: the page stops asking
    await act(async () => {
      jest.advanceTimersByTime(60 * 60 * 1000 + 5000);
    });
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    // Opening GitHub again starts the wait afresh, so finishing there is still noticed
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub again' }));
    // The form is that old by now, so a new one is asked for first
    await settle();
    await settle();
    made = true;
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByText(/GitHub is set up/)).toBeTruthy();
  });

  it('shows the set-up state when the app is already made, with the way to make it again', async () => {
    backend({ existing: { slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe', appId: 7 } });
    render(<GitHubAppSetupPage />);
    await settle();
    expect(screen.getByText(/GitHub is set up/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make the app again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue to GitHub' })).toBeNull();
  });

  it('asks before replacing the app, and can be left alone', async () => {
    backend({ existing: { slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe', appId: 7 } });
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Make the app again' }));
    expect(screen.getByText(/Everyone who connected GitHub has to sign in again/)).toBeTruthy();
    expect(screen.getByText(/GitHub names are unique/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep this app' }));
    expect(screen.getByText(/GitHub is set up/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes it again only after the confirmation, and waits for another app than the old one', async () => {
    let appId = 7;
    backend({ existing: { slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe', appId: 7 }, made: () => ({ made: true, appId, slug: appId === 7 ? 'bawes-universe' : 'bawes-universe-2', url: 'https://github.com/apps/x' }) });
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Make the app again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make it again' }));
    await settle();
    const post = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').pop();
    expect(JSON.parse(post[1].body)).toEqual({ again: true });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    // The old app is still the one kept: not done yet
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByText(/Waiting for you on GitHub/)).toBeTruthy();
    appId = 8;
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByRole('link', { name: 'bawes-universe-2' })).toBeTruthy();
  });

  it('says what went wrong and offers Try again', async () => {
    fetchMock.mockImplementationOnce(() => json({ error: 'Only a super admin can set up GitHub for Universe' }, false));
    backend();
    render(<GitHubAppSetupPage />);
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/Only a super admin/);
    fetchMock.mockReset();
    backend();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Continue to GitHub' })).toBeTruthy();
  });

  it('waits for another app than the one this form replaces, even when another admin replaced the app the page showed', async () => {
    let appId = 7;
    backend({
      existing: { slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe', appId: 7 },
      made: () => ({ made: true, appId, slug: `app-${appId}`, url: 'https://github.com/apps/x' }),
      // Between the page loading and "Make it again", another admin replaced app 7 with app 8: this form replaces 8
      kept: () => 8,
    });
    render(<GitHubAppSetupPage />);
    await settle();
    appId = 8;
    fireEvent.click(screen.getByRole('button', { name: 'Make the app again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make it again' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    // App 8 is what this form replaces: it is not done
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByText(/Waiting for you on GitHub/)).toBeTruthy();
    appId = 9;
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByRole('link', { name: 'app-9' })).toBeTruthy();
  });

  it('drops a form asked for again after fifty minutes when the app was seen made while it was on its way', async () => {
    let made = false;
    let release: () => void = () => undefined;
    let holding = false;
    backend({
      made: () => (made ? { made: true, appId: 7, slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe' } : { made: false }),
      hold: () => (holding ? new Promise<void>((resolve) => (release = resolve)) : undefined),
    });
    const close = jest.fn();
    open.mockReturnValue({ close } as unknown as Window);
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    expect(sent).toHaveLength(1);
    // Fifty-one minutes of waiting, then GitHub is opened again: the form is asked for again, and the answer is slow
    await act(async () => {
      jest.advanceTimersByTime(51 * 60 * 1000);
    });
    holding = true;
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub again' }));
    // Meanwhile the first window finishes: the app is made
    made = true;
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByText(/GitHub is set up/)).toBeTruthy();
    // The slow answer comes: it is dropped, nothing is sent and the page stays Set up
    await act(async () => {
      release();
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(close).toHaveBeenCalled();
    expect(screen.getByText(/GitHub is set up/)).toBeTruthy();
    expect(screen.queryByText(/Waiting for you on GitHub/)).toBeNull();
  });

  it('still sends a form asked for again after fifty minutes when nothing was made meanwhile', async () => {
    backend();
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    await act(async () => {
      jest.advanceTimersByTime(51 * 60 * 1000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub again' }));
    await settle();
    await settle();
    expect(sent).toHaveLength(2);
    expect(screen.getByText(/Waiting for you on GitHub/)).toBeTruthy();
  });

  it('keeps the app when Keep this app is chosen while the form for making it again is on its way', async () => {
    let release: () => void = () => undefined;
    let holding = false;
    backend({
      existing: { slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe', appId: 7 },
      hold: () => (holding ? new Promise<void>((resolve) => (release = resolve)) : undefined),
    });
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Make the app again' }));
    holding = true;
    fireEvent.click(screen.getByRole('button', { name: 'Make it again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep this app' }));
    expect(screen.getByText(/GitHub is set up/)).toBeTruthy();
    await act(async () => {
      release();
    });
    await settle();
    // The late form does not bring the cancelled setup back
    expect(screen.getByText(/GitHub is set up/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue to GitHub' })).toBeNull();
  });

  it('leaves the window alone when a newer press owns it: two presses while a form is asked for again', async () => {
    const releases: (() => void)[] = [];
    let holding = false;
    backend({ hold: () => (holding ? new Promise<void>((resolve) => releases.push(resolve)) : undefined) });
    const close = jest.fn();
    open.mockReturnValue({ close } as unknown as Window);
    render(<GitHubAppSetupPage />);
    await settle();
    // The form is older than fifty minutes by the time it is used
    await act(async () => {
      jest.advanceTimersByTime(51 * 60 * 1000);
    });
    holding = true;
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to GitHub' }));
    expect(releases).toHaveLength(2);
    // The second press answers first and sends; the first answers after and must not close the window the second uses
    await act(async () => {
      releases[1]();
    });
    await settle();
    await act(async () => {
      releases[0]();
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText(/Waiting for you on GitHub/)).toBeTruthy();
  });
});
