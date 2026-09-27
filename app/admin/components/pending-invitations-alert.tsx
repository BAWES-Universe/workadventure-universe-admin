'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Mail, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';

interface Invitation {
  id: string;
  world: { id: string; name: string; slug: string; universe: { id: string; name: string; slug: string } };
  invitedBy: { id: string; name: string | null; email: string | null };
  invitedAt: string;
}

/** Where the dismissal lives on the account (see lib/user-preferences.ts), so it holds on every device. */
export const INVITATIONS_DISMISSED_KEY = 'guidance.dismissed.invitations';
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
}

/**
 * Invitations waiting for an answer. Dismissing hides the ones shown now, on this account, on every device; a new
 * invitation shows again. Answering happens on My Memberships.
 */
export default function PendingInvitationsAlert() {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [dismissedIds, setDismissedIds] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      authenticatedFetch('/api/memberships/invitations')
        .then(async (response) => (response.ok ? ((await response.json()).invitations as Invitation[]) ?? [] : []))
        .catch(() => [] as Invitation[]),
      readDismissed(),
    ]).then(([list, dismissed]) => {
      if (cancelled) return;
      setInvitations(list);
      setDismissedIds(dismissed);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!invitations || !dismissedIds) return null;
  const shown = invitations.filter((invitation) => !dismissedIds.includes(invitation.id));
  if (shown.length === 0) return null;

  const first = shown[0];
  const inviterName = first.invitedBy.name || first.invitedBy.email || 'Someone';

  function dismiss() {
    const ids = [...(dismissedIds ?? []), ...shown.map((invitation) => invitation.id)];
    setDismissedIds(ids);
    void writeDismissed(ids);
  }

  return (
    <div
      role="status"
      className="orbit-card orbit-glow relative flex gap-3 p-4 pr-12 orbit-rise"
      data-testid="pending-invitations"
    >
      <span className="orbit-brand-fill flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
        <Mail className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="text-[15px] font-semibold">
            {shown.length === 1 ? 'You have an invitation' : `You have ${shown.length} invitations`}
          </p>
          <p className="text-sm text-muted-foreground">
            {shown.length === 1 ? (
              <>
                {inviterName} invited you to join <strong className="text-foreground">{first.world.name}</strong> in{' '}
                {first.world.universe.name}
              </>
            ) : (
              <>People invited you to join their worlds</>
            )}
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/memberships">View invitations</Link>
        </Button>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="orbit-press absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
