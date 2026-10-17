'use client';

import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { Button } from '@/components/ui/button';
import { RolePills } from './ds';
import InviteSheet from './invite-sheet';
import { useUniverseBasics } from './universe-people';

interface Membership {
  world: { id: string; name: string };
  universeId?: string;
  status: 'owner' | 'member' | 'invited' | 'none' | 'guest';
  tags: string[];
  canInvite: boolean;
}

/** Mounted anew for each opened card so membership and invitation state are current. */
export function VisitorMembership({ roomId, userId, name, woka }: { roomId: string; userId: string | null; name?: string; woka?: string[] }) {
  const [membership, setMembership] = useState<Membership | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [inviting, setInviting] = useState(false);
  const universe = useUniverseBasics(membership?.canInvite && membership.universeId ? membership.universeId : null);
  const universeName = universe.status === 'ready' ? universe.value.name : null;
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

  if (!userId || membership?.status === 'guest') return <p className="text-sm text-muted-foreground">Not a member. Guests need an account before they can be invited.</p>;
  return (
    <div className="grid gap-2 rounded-2xl border border-border bg-muted/30 p-4">
      {!membership && !error && <p role="status" className="text-sm text-muted-foreground">Checking membership…</p>}
      {membership && (
        <>
          <p role="status" className="text-sm font-semibold">
            {membership.status === 'owner' ? 'Universe owner' : membership.status === 'member' ? 'Already a member' : membership.status === 'invited' ? 'Invitation pending' : universeName ? `Not in ${universeName}` : 'Not a member'}
          </p>
          {membership.status === 'member' && <RolePills roles={membership.tags} />}
          <p className="text-xs text-muted-foreground">
            {membership.status === 'invited'
              ? `They become a member of ${universeName ?? membership.world.name} once they accept.`
              : membership.canInvite
                ? 'You pick their roles and worlds before the invite goes.'
                : `Membership applies to ${membership.world.name} and all its rooms.`}
          </p>
          {membership.canInvite && membership.universeId && (
            <Button className="h-11 justify-self-start rounded-full" onClick={() => setInviting(true)}>
              <UserPlus size={16} aria-hidden="true" />Invite as member
            </Button>
          )}
          {membership.universeId && userId && (
            <InviteSheet
              open={inviting}
              onOpenChange={setInviting}
              universeId={membership.universeId}
              person={{ userId, name: name || 'This person', woka }}
              worldId={membership.world.id}
              onSent={() => setMembership({ ...membership, status: 'invited', canInvite: false })}
            />
          )}
        </>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!membership && error && <Button variant="outline" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</Button>}
    </div>
  );
}
