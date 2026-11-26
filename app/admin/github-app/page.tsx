'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';
import { PageHeader } from '../components/ds';
import { GITHUB_WINDOW } from './github-window';

type Existing = { slug?: string; url?: string; appId?: number };
type Answer = { existing?: Existing; action?: string; manifest?: string; replaces?: number | null; error?: string };
type Form = { action: string; manifest: string };
type Step = 'loading' | 'ready' | 'waiting' | 'made' | 'confirm' | 'failed';

/** How often a waiting page asks whether the app has been made, and for how long (GitHub's own limit for the setup is an hour). */
const POLL_MS = 2500;
const POLL_FOR_MS = 60 * 60 * 1000;
/** The form Orbit hands out is good for an hour; one older than this is asked for again before it is sent. */
const FORM_FRESH_MS = 50 * 60 * 1000;

/** Asks Orbit for the filled-in form (or says the app is already made). */
async function load(again: boolean): Promise<{ answer?: Answer; failed?: string }> {
  try {
    const response = await authenticatedFetch('/api/admin/github-app/create', { method: 'POST', body: JSON.stringify(again ? { again: true } : {}) });
    const body = (await response.json()) as Answer;
    return response.ok ? { answer: body } : { failed: body.error ?? 'Could not open GitHub' };
  } catch {
    return { failed: 'Could not open GitHub' };
  }
}

/**
 * The one step that makes Universe's GitHub App (game #2041). The page says what is about to happen, and only when the super
 * admin presses Continue it opens GitHub's "Create GitHub App" page, filled in for the BAWES-Universe organization, in a window of
 * its own (so the game tab is never taken over). The super admin presses Create there; nothing else is asked of them. This page
 * waits, and shows "Set up" by itself once the app is made. Once made, the same page can make it again (it replaces the app).
 */
export default function GitHubAppSetupPage() {
  const [step, setStep] = useState<Step>('loading');
  const [existing, setExisting] = useState<Existing | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  // Counts each time GitHub is opened, so the wait starts afresh (and asking again after an hour of waiting) even while still waiting
  const [opened, setOpened] = useState(0);
  const loadedAt = useRef(0);
  const again = useRef(false);
  // The app the form last given is set to replace (none while the first one is made): the waiting page waits for another app than that
  const replaces = useRef<number | null>(null);
  // Counts each press of Open GitHub: of two forms asked for again at once, only the latest press is sent (and owns GitHub's window)
  const opening = useRef(0);
  // Counts each time the app is seen made: a form asked for again before that is dropped, and its window closed
  const completed = useRef(0);
  // Counts each press of Make it again, and each Keep: a form asked for before a Keep is dropped
  const making = useRef(0);

  const apply = useCallback((result: { answer?: Answer; failed?: string }) => {
    if (result.failed) {
      setFailed(result.failed);
      setStep('failed');
      return;
    }
    const answer = result.answer ?? {};
    setFailed(null);
    if (answer.existing) {
      setExisting(answer.existing);
      setStep('made');
    } else if (answer.action && answer.manifest) {
      setForm({ action: answer.action, manifest: answer.manifest });
      replaces.current = typeof answer.replaces === 'number' ? answer.replaces : null;
      loadedAt.current = Date.now();
      setStep('ready');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void load(false).then((result) => {
      if (alive) apply(result);
    });
    return () => {
      alive = false;
    };
  }, [apply]);

  // While GitHub's window is open, ask now and then whether the app is made
  useEffect(() => {
    if (step !== 'waiting') return;
    let alive = true;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > POLL_FOR_MS) {
        clearInterval(timer);
        return;
      }
      try {
        const response = await authenticatedFetch('/api/admin/github-app');
        if (!response.ok) return;
        const body = (await response.json()) as { made?: unknown; appId?: unknown; slug?: unknown; url?: unknown };
        if (!alive || body.made !== true) return;
        const appId = typeof body.appId === 'number' ? body.appId : undefined;
        // The first app: any app is new. A replacement: only another app than the one it replaces
        if (replaces.current !== null && appId === replaces.current) return;
        clearInterval(timer);
        // Done: a form still being asked for must not open GitHub again
        completed.current += 1;
        setExisting({ appId, slug: typeof body.slug === 'string' ? body.slug : undefined, url: typeof body.url === 'string' ? body.url : undefined });
        setStep('made');
      } catch {
        // Asked again in a moment
      }
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [step, opened]);

  /** Posts the filled-in form to GitHub's page, which opens in the window already opened for it. */
  const send = (answer: Form) => {
    const element = document.createElement('form');
    element.method = 'post';
    element.action = answer.action;
    element.target = GITHUB_WINDOW;
    element.hidden = true;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'manifest';
    input.value = answer.manifest;
    element.appendChild(input);
    document.body.appendChild(element);
    element.submit();
    element.remove();
  };

  /**
   * Opens GitHub's page in a window of its own. The window is opened right now, inside the tap (a browser can refuse one opened
   * after a wait); a form kept too long to still be good is asked for again before it is sent to that window.
   */
  const openGitHub = async () => {
    if (!form) return;
    const popup = window.open('', GITHUB_WINDOW, 'width=980,height=820');
    if (!popup) {
      setBlocked(true);
      return;
    }
    setBlocked(false);
    const mine = ++opening.current;
    const seenMade = completed.current;
    let toSend = form;
    if (Date.now() - loadedAt.current > FORM_FRESH_MS) {
      const result = await load(again.current);
      // The app was seen made while this was asked for: nothing to open, and the window opened for it is closed
      if (completed.current !== seenMade) {
        popup.close();
        return;
      }
      // GitHub was opened again meanwhile: that press owns the window (the same named one), so this one leaves it alone
      if (opening.current !== mine) return;
      // Made meanwhile (another tab): nothing to open
      if (result.answer?.existing) {
        popup.close();
        apply(result);
        return;
      }
      if (!result.answer?.action || !result.answer.manifest) {
        popup.close();
        setFailed(result.failed ?? 'Could not open GitHub');
        setStep('failed');
        return;
      }
      toSend = { action: result.answer.action, manifest: result.answer.manifest };
      replaces.current = typeof result.answer.replaces === 'number' ? result.answer.replaces : null;
      setForm(toSend);
      loadedAt.current = Date.now();
    }
    send(toSend);
    setOpened((count) => count + 1);
    setStep('waiting');
  };

  const makeAgain = async () => {
    const mine = ++making.current;
    setBusy(true);
    again.current = true;
    const result = await load(true);
    // Keep this app was chosen while this was asked for: the answer is dropped and the page stays where Keep put it
    if (making.current === mine) apply(result);
    setBusy(false);
  };

  const keep = () => {
    making.current += 1;
    again.current = false;
    setBusy(false);
    setStep('made');
  };

  const retry = () => {
    setStep('loading');
    void load(again.current).then(apply);
  };

  return (
    <div>
      <PageHeader title="GitHub for Universe" />
      <div className="mt-6 grid max-w-xl gap-4 rounded-[18px] border border-border bg-card p-5 text-sm leading-relaxed" data-testid="github-setup-card" data-step={step}>
        {step === 'loading' && <p>One moment…</p>}

        {step === 'failed' && (
          <div role="alert" className="grid gap-3">
            <p>{failed}</p>
            <Button type="button" variant="outline" onClick={retry} className="w-max">
              Try again
            </Button>
          </div>
        )}

        {(step === 'ready' || step === 'waiting') && (
          <>
            {step === 'ready' ? (
              <p>
                GitHub opens in its own window with everything filled in. Press <strong>Create GitHub App</strong> there. That is the only step.
              </p>
            ) : (
              <p role="status">
                Waiting for you on GitHub. Press <strong>Create GitHub App</strong> in the window that opened. This page updates by itself.
              </p>
            )}
            <p className="text-muted-foreground">Only an owner of BAWES-Universe on GitHub can press it.</p>
            {blocked && (
              <p role="alert" className="text-destructive">
                Your browser blocked the window. Allow pop-ups for Orbit, then press the button again.
              </p>
            )}
            <Button type="button" variant={step === 'ready' ? 'default' : 'outline'} onClick={() => void openGitHub()} className="w-max">
              {step === 'ready' ? 'Continue to GitHub' : 'Open GitHub again'}
            </Button>
          </>
        )}

        {step === 'made' && (
          <>
            <p>
              GitHub is set up: Universe&apos;s GitHub App is{' '}
              {existing?.slug && existing.url ? (
                <a href={existing.url} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-4">
                  {existing.slug}
                </a>
              ) : (
                'made'
              )}
              . Everyone can connect GitHub in Apps.
            </p>
            <Button type="button" variant="outline" onClick={() => setStep('confirm')} className="w-max">
              Make the app again
            </Button>
          </>
        )}

        {step === 'confirm' && (
          <>
            <p>
              <strong>Make the app again?</strong> Universe&apos;s GitHub App is replaced by a new one. Everyone who connected GitHub has to sign in again.
            </p>
            <p className="text-muted-foreground">
              GitHub names are unique, so delete the old app on GitHub first
              {existing?.url ? (
                <>
                  {' '}
                  (<a href={existing.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">its page</a>)
                </>
              ) : null}
              , or choose a new name on GitHub&apos;s page.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void makeAgain()} disabled={busy}>
                Make it again
              </Button>
              <Button type="button" variant="outline" onClick={keep}>
                Keep this app
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
