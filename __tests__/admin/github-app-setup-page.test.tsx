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
import { GITHUB_WINDOW } from '@/app/admin/github-app/window';

const FORM = { action: 'https://github.com/organizations/BAWES-Universe/settings/apps/new?state=abc', manifest: '{"name":"BAWES Universe"}' };
const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });

let submit: jest.SpyInstance;
/** What each form sent to GitHub carried: where it was posted, to which window, and the filled-in form. */
let sent: { action: string; target: string; manifest: string }[];
let open: jest.SpyInstance;

/** Answers by method and address: the form (or the existing app) on POST, whether it is made on GET. */
function backend(options: { existing?: { slug: string; url: string; appId: number }; made?: () => { made: boolean; appId?: number; slug?: string; url?: string } } = {}) {
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') return json(options.existing && !JSON.parse(init.body ?? '{}').again ? { existing: options.existing } : FORM);
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

  it('two presses of Continue on an old form: the earlier one failing does not close the window the later one owns', async () => {
    const popup = { close: jest.fn() };
    open.mockReturnValue(popup as unknown as Window);
    let calls = 0;
    const answers: ((value: unknown) => void)[] = [];
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method !== 'POST') return json({ made: false });
      calls += 1;
      if (calls === 1) return json(FORM);
      return new Promise((resolve) => answers.push(resolve));
    });
    render(<GitHubAppSetupPage />);
    await settle();
    await act(async () => {
      jest.advanceTimersByTime(51 * 60 * 1000);
    });
    const button = screen.getByRole('button', { name: 'Continue to GitHub' });
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();
    expect(answers).toHaveLength(2);
    // the second press's form arrives first and is sent; then the first press's request fails
    await act(async () => {
      answers[1](await json({ action: `${FORM.action}-second`, manifest: FORM.manifest }));
    });
    await act(async () => {
      answers[0](await json({ error: 'Could not open GitHub' }, false));
    });
    expect(popup.close).not.toHaveBeenCalled();
    expect(sent).toEqual([{ action: `${FORM.action}-second`, target: GITHUB_WINDOW, manifest: FORM.manifest }]);
    expect(screen.getByText(/Waiting for you on GitHub/)).toBeTruthy();
  });

  it('"Keep this app" pressed while "Make it again" is on its way stays on the kept app when the answer arrives', async () => {
    let answer: ((value: unknown) => void) | undefined;
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        if (JSON.parse(init.body ?? '{}').again) return new Promise((resolve) => (answer = resolve));
        return json({ existing: { slug: 'universe-app', url: 'https://github.com/apps/universe-app', appId: 7 } });
      }
      return json({ made: false });
    });
    render(<GitHubAppSetupPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Make the app again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make it again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep this app' }));
    expect(screen.getByTestId('github-setup-card').getAttribute('data-step')).toBe('made');
    await act(async () => {
      answer?.(await json(FORM));
    });
    expect(screen.getByTestId('github-setup-card').getAttribute('data-step')).toBe('made');
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
});
