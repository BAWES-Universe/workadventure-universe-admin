'use client';

import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { Button } from '@/components/ui/button';
import { RolePills } from './ds';

interface Membership {
  world: { id: string; name: string };
  status: 'owner' | 'member' | 'invited' | 'none' | 'guest';
  tags: string[];
  canInvite: boolean;
}

/** Mounted anew for each opened card so membership and invitation state are current. */
export function VisitorMembership({ roomId, userId }: { roomId: string; userId: string | null }) {
  const [membership, setMembership] = useState<Membership | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    authenticatedFetch(`/api/admin/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Couldn’t check membership.');
        const data: Membership = await response.json();
        if (!cancelled) setMembership(data);
      })
      .catch(() => { if (!cancelled) setError('Couldn’t check membership.'); });
    return () => { cancelled = true; };
  }, [roomId, userId, attempt]);

  async function invite() {
    if (!membership?.canInvite || !userId || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/admin/users/${encodeURIComponent(userId)}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId: membership.world.id, tags: ['member'] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(typeof data.error === 'string' ? data.error : 'Couldn’t send invitation. Try again.');
      }
      setMembership({ ...membership, status: 'invited', canInvite: false });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t send invitation. Try again.');
    } finally {
      setSending(false);
    }
  }

  if (!userId || membership?.status === 'guest') return <p className="text-sm text-muted-foreground">Not a member. Guests need an account before they can be invited.</p>;
  return (
    <div className="grid gap-2 rounded-2xl border border-border bg-muted/30 p-4">
      {!membership && !error && <p role="status" className="text-sm text-muted-foreground">Checking membership…</p>}
      {membership && (
        <>
          <p role="status" className="text-sm font-semibold">
            {membership.status === 'owner' ? 'Universe owner' : membership.status === 'member' ? 'Already a member' : membership.status === 'invited' ? 'Invitation pending' : 'Not a member'}
          </p>
          {membership.status === 'member' && <RolePills roles={membership.tags} />}
          <p className="text-xs text-muted-foreground">
            {membership.status === 'invited'
              ? `They become a member of ${membership.world.name} once they accept.`
              : `Membership applies to ${membership.world.name} and all its rooms.`}
          </p>
          {membership.canInvite && (
            <Button className="h-11 justify-self-start rounded-full" onClick={invite} disabled={sending}>
              <UserPlus size={16} aria-hidden="true" />{sending ? 'Sending…' : 'Invite as member'}
            </Button>
          )}
        </>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!membership && error && <Button variant="outline" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</Button>}
    </div>
  );
}
