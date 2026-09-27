'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';

/**
 * What an invitation's role lets you do, in plain words. Kept in one place so it can later read from the world's
 * own roles and capabilities (custom roles, issue #530) instead of this fixed list.
 */
const BUILT_IN_ROLES: { tag: string; label: string; can: string }[] = [
  { tag: 'admin', label: 'an admin', can: 'enter the world’s members-only rooms, edit its maps, rooms and bots, and invite and manage members' },
  { tag: 'editor', label: 'an editor', can: 'enter the world’s members-only rooms and edit its maps, rooms and bots' },
  { tag: 'member', label: 'a member', can: 'enter the world’s members-only rooms' },
];

export interface RoleDescription {
  /** The built-in role that says the most (admin over editor over member); member when there are no tags. */
  role: { tag: string; label: string; can: string };
  /** Tags that aren't built-in roles: roles the world's admins set up themselves. */
  custom: string[];
}

export function describeRole(tags: string[] | null | undefined): RoleDescription {
  const names = [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  const role = BUILT_IN_ROLES.find((known) => names.includes(known.tag)) ?? BUILT_IN_ROLES[BUILT_IN_ROLES.length - 1];
  const custom = names.filter((name) => !BUILT_IN_ROLES.some((known) => known.tag === name));
  return { role, custom };
}

/** "a member", "an editor"; a custom role by its name when that's all the invitation has. */
export function roleLabel(tags: string[] | null | undefined): string {
  const names = (tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const { role, custom } = describeRole(names);
  if (names.some((name) => name === role.tag) || custom.length === 0) return role.label;
  return custom.join(', ');
}

/** Declines an invitation; throws a sentence to show when it couldn't. */
export async function declineInvitation(id: string, worldName: string): Promise<void> {
  const response = await authenticatedFetch(`/api/memberships/invitations/${id}/reject`, { method: 'POST' });
  if (!response.ok) throw new Error(`Couldn’t decline the invitation to ${worldName}. Try again.`);
}

/**
 * Decline, asked twice: the button, then "Decline Sara's invitation to Studio? They'd need to invite you again."
 * One request at a time.
 */
export function DeclineWithConfirm({
  inviterName,
  worldName,
  disabled,
  onConfirm,
  onBusyChange,
}: {
  inviterName: string;
  worldName: string;
  disabled?: boolean;
  onConfirm: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  async function confirm() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    onBusyChange?.(true);
    try {
      await onConfirm();
    } finally {
      running.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  if (!asking) {
    return (
      <Button type="button" variant="outline" className="h-11 px-5" disabled={disabled} onClick={() => setAsking(true)}>
        Decline
      </Button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2" role="group" aria-label="Confirm declining" data-testid="decline-confirm">
      <p className="text-sm">
        Decline {inviterName}’s invitation to <strong>{worldName}</strong>? They’d need to invite you again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="destructive" className="h-11 px-5" disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Declining…' : 'Decline invitation'}
        </Button>
        <Button type="button" variant="outline" className="h-11 px-5" disabled={busy} onClick={() => setAsking(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
