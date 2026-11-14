'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';
import { PageHeader } from '../components/ds';

type Answer = { existing?: { slug: string; url: string }; action?: string; manifest?: string; error?: string };

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
 * The one step that makes Universe's GitHub App (game #2041): this page opens GitHub's "Create GitHub App" page with everything
 * filled in, for the BAWES-Universe organization. The super admin presses Create there; nothing else is asked of them.
 */
export default function GitHubAppSetupPage() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const apply = (result: { answer?: Answer; failed?: string }) => {
    setFailed(result.failed ?? null);
    if (result.answer) setAnswer(result.answer);
  };
  const ask = () => void load(false).then(apply);

  useEffect(() => {
    let alive = true;
    void load(false).then((result) => {
      if (alive) apply(result);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The filled-in form goes to GitHub as soon as it is here
  useEffect(() => {
    if (answer?.action) form.current?.submit();
  }, [answer]);

  return (
    <div>
      <PageHeader title="GitHub for Universe" />
      {failed && (
        <div role="alert">
          <p>{failed}</p>
          <Button type="button" variant="outline" onClick={ask}>
            Try again
          </Button>
        </div>
      )}
      {answer?.existing && (
        <div>
          <p>
            GitHub is set up: Universe&apos;s GitHub App is <a href={answer.existing.url} target="_blank" rel="noreferrer">{answer.existing.slug}</a>. Everyone can connect GitHub in Apps.
          </p>
        </div>
      )}
      {answer?.action && (
        <form ref={form} method="post" action={answer.action} target="_top">
          <input type="hidden" name="manifest" value={answer.manifest} />
          <p>GitHub opens with everything filled in. Press Create GitHub App there.</p>
          <Button type="submit">Continue to GitHub</Button>
        </form>
      )}
      {!answer && !failed && <p>Opening GitHub…</p>}
    </div>
  );
}
