'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Earth, X } from 'lucide-react';
import { EntityRow, KindIcon } from './ds';
import { PersonIcon } from './profile-card';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import { INVITATIONS_DISMISSED_KEY } from '@/lib/user-preferences';
import { DeclineWithConfirm, declineInvitation, roleLabel } from '../invitations/invitation-role';
import { announceAttentionChanged } from './shell/attention-badge';
import styles from './pending-invitations.module.css';

interface Invitation {
  id: string;
  tags?: string[];
  message?: string | null;
  world: { id: string; name: string; slug: string; universe: { id: string; name: string; slug: string } };
  invitedBy: { id: string; name: string | null; email: string | null };
  invitedAt: string;
}

/** The most recent dismissed invitation ids kept; older ones are gone from the account anyway. */
const DISMISSED_IDS_KEPT = 40;

async function readDismissed(): Promise<string[]> {
  try {
    const response = await authenticatedFetch(`/api/me/preferences?key=${encodeURIComponent(INVITATIONS_DISMISSED_KEY)}`);
    if (!response.ok) return [];
    const data = (await response.json()) as { preferences?: Record<string, unknown> };
    const value = data.preferences?.[INVITATIONS_DISMISSED_KEY] as { ids?: unknown } | undefined;
    return Array.isArray(value?.ids) ? value.ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

async function writeDismissed(ids: string[]): Promise<void> {
  try {
    await authenticatedFetch('/api/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ key: INVITATIONS_DISMISSED_KEY, value: { ids: ids.slice(-DISMISSED_IDS_KEPT) } }),
    });
  } catch {
    // The dismissal still holds for this visit.
  }
  announceAttentionChanged();
}

/**
 * Invitations waiting for an answer. One: who invited you to what, as what, and View invitation or Decline. Several:
 * one row each, leading to its invitation. Dismissing hides the ones shown now, on this account, on every device; a
 * new invitation shows again.
 */
export default function PendingInvitationsAlert() {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [dismissedIds, setDismissedIds] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Try again was pressed and its answer hasn't come: say so instead of leaving the error up. */
  const [retrying, setRetrying] = useState(false);
  /** The inviter's Woka, for the one invitation shown on its own. */
  const [wokas, setWokas] = useState<Record<string, string[]>>({});
  const [declineError, setDeclineError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      authenticatedFetch('/api/memberships/invitations')
        .then(async (response) => {
          if (!response.ok) throw new Error('Invitations unavailable');
          return (((await response.json()).invitations as Invitation[]) ?? []);
        })
        .catch(() => null),
      readDismissed(),
    ]).then(([list, dismissed]) => {
      if (cancelled) return;
      setRetrying(false);
      setFailed(!list);
      if (!list) return;
      setInvitations(list);
      setDismissedIds(dismissed);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const shown = invitations && dismissedIds ? invitations.filter((invitation) => !dismissedIds.includes(invitation.id)) : [];
  const single = shown.length === 1 ? shown[0] : null;

  useEffect(() => {
    if (!single || wokas[single.id]) return;
    let cancelled = false;
    authenticatedFetch(`/api/memberships/invitations/${encodeURIComponent(single.id)}`)
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        const woka = data?.invitation?.invitedBy?.woka;
        if (!cancelled && Array.isArray(woka)) setWokas((current) => ({ ...current, [single.id]: woka }));
      })
      .catch(() => {
        // Without the Woka, the people chip stands in.
      });
    return () => {
      cancelled = true;
    };
  }, [single, wokas]);

  const retry = useCallback(() => {
    setFailed(false);
    setRetrying(true);
    setAttempt((value) => value + 1);
  }, []);

  if (retrying) {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-testid="pending-invitations-retrying">
        Checking your invitations…
      </p>
    );
  }
  if (failed) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="pending-invitations-error">
        <span>We couldn’t check your invitations.</span>
        <Button type="button" variant="outline" className="h-11 px-4" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (!invitations || !dismissedIds || shown.length === 0) return null;

  function dismiss() {
    const ids = [...(dismissedIds ?? []), ...shown.map((invitation) => invitation.id)];
    setDismissedIds(ids);
    void writeDismissed(ids);
  }

  const dismissButton = (
    <button
      type="button"
      onClick={dismiss}
      aria-label="Dismiss"
      className="orbit-press absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  );

  if (!single) {
    return (
      <div
        role="status"
        className={`orbit-rise ${styles.several}`}
        data-testid="pending-invitations"
      >
        <p className="text-[15px] font-semibold">You have {shown.length} invitations</p>
        <div className="space-y-2">
          {shown.map((invitation) => (
            <EntityRow
              key={invitation.id}
              href={`/admin/invitations/${invitation.id}`}
              kind="world"
              tone="waiting"
              title={invitation.world.name}
              context={
                <span className="text-sm text-muted-foreground">
                  From {inviterOf(invitation)} · {invitation.world.universe.name}
                </span>
              }
              testId="pending-invitation-row"
            />
          ))}
        </div>
        {dismissButton}
      </div>
    );
  }

  const inviterName = inviterOf(single);
  const invitation = single;

  async function decline() {
    setDeclineError(null);
    try {
      await declineInvitation(invitation.id, invitation.world.name);
      setInvitations((current) => (current ?? []).filter((item) => item.id !== invitation.id));
    } catch (cause) {
      setDeclineError(cause instanceof Error ? cause.message : 'Couldn’t decline the invitation. Try again.');
    }
  }

  return (
    <div role="status" className={`orbit-rise ${styles.card}`} data-testid="pending-invitations">
      <span className={styles.face}>
        {wokas[invitation.id] ? <PersonIcon woka={wokas[invitation.id]} name={inviterName} size={44} /> : <KindIcon kind="people" />}
      </span>
      <p className={styles.title}>
        <b>{inviterName}</b> invited you to{' '}
        <span className={styles.world}>
          <Earth size={15} aria-hidden="true" />
          <b>{invitation.world.name}</b>
        </span>
      </p>
      <span className={styles.meta}>
        {invitation.world.universe.name} · as {roleLabel(invitation.tags)}
        {invitation.invitedAt && <> · {timeAgo(new Date(invitation.invitedAt))}</>}
      </span>
      {invitation.message && (
        <p className={styles.message} title={invitation.message} data-testid="pending-invitation-message">
          “{invitation.message}”
        </p>
      )}
      {declineError && (
        <p className={styles.error} role="alert">
          {declineError}
        </p>
      )}
      <div className={styles.actions}>
        <Button asChild className="h-11 px-5">
          <Link href={`/admin/invitations/${invitation.id}`}>View invitation</Link>
        </Button>
        <DeclineWithConfirm inviterName={inviterName} worldName={invitation.world.name} onConfirm={decline} />
      </div>
      {dismissButton}
    </div>
  );
}

function inviterOf(invitation: Invitation): string {
  return invitation.invitedBy?.name || invitation.invitedBy?.email || 'Someone';
}
