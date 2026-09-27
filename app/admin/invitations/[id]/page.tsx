'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import {
  EmptyCard,
  EntityRow,
  LoadError,
  LoadingRows,
  PageHeader,
  RolePill,
  SectionHeader,
  StatLine,
  StatusPill,
  count,
} from '../../components/ds';
import { PersonIcon, WokaAvatar } from '../../components/profile-card';
import { ORBIT_REFRESH_EVENT } from '../../components/orbit-bridge';
import { useWorkAdventure } from '../../workadventure-context';
import { DeclineWithConfirm, declineInvitation, describeRole } from '../invitation-role';

interface Person {
  id: string;
  name: string | null;
  woka?: string[];
}

interface InvitationDetail {
  id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | string;
  tags: string[];
  message: string | null;
  invitedAt: string;
  respondedAt: string | null;
  invitedBy: Person;
  world: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isPublic: boolean;
    thumbnailUrl: string | null;
    universe: { id: string; name: string; slug: string };
    counts: { rooms: number; members: number };
    firstRoom: { slug: string } | null;
    members: Person[];
  };
}

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'missing' }
  | { state: 'ready'; invitation: InvitationDetail };

/**
 * One invitation to a world, for the person invited: who asked, what the world is, what the role lets you do, and
 * Accept or Decline. Answered, it says what happened and where to go next.
 */
export default function InvitationPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<'accepted' | 'declined' | null>(null);
  const [pending, setPending] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accepting = useRef(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoad({ state: 'loading' });
    authenticatedFetch(`/api/memberships/invitations/${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (response.status === 404) return { state: 'missing' } as const;
        if (!response.ok) throw new Error('Invitation unavailable');
        const data = await response.json();
        if (!data?.invitation?.world) throw new Error('Invitation unavailable');
        return { state: 'ready', invitation: data.invitation as InvitationDetail } as const;
      })
      .then((next) => {
        if (!cancelled) setLoad(next);
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (load.state === 'loading') {
    return (
      <div className="space-y-4">
        <LoadingRows label="the invitation" rows={3} />
      </div>
    );
  }
  if (load.state === 'error') return <LoadError label="this invitation" retry={retry} />;
  if (load.state === 'missing') {
    return (
      <EmptyCard
        kind="world"
        title="We couldn’t find this invitation"
        text="It may have been removed, or it was sent to someone else."
        href="/admin/you"
        action="Go to You"
        testId="invitation-missing"
      />
    );
  }

  const invitation = load.invitation;
  const { world, invitedBy } = invitation;
  const inviterName = invitedBy.name || 'Someone';
  const waiting = invitation.status === 'pending' && outcome === null;

  async function accept() {
    if (accepting.current || pending) return;
    accepting.current = true;
    setPending('accept');
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/memberships/invitations/${invitation.id}/accept`, { method: 'POST' });
      if (!response.ok) throw new Error('accept failed');
      setOutcome('accepted');
      window.dispatchEvent(new CustomEvent(ORBIT_REFRESH_EVENT, { detail: { topic: 'memberships' } }));
    } catch {
      setError(`Couldn’t accept the invitation to ${world.name}. Try again.`);
    } finally {
      accepting.current = false;
      setPending(null);
    }
  }

  async function decline() {
    setError(null);
    try {
      await declineInvitation(invitation.id, world.name);
      setOutcome('declined');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Couldn’t decline the invitation to ${world.name}. Try again.`);
    }
  }

  return (
    <div className="space-y-6" data-testid="invitation-page">
      <PageHeader
        kind="world"
        title={world.name}
        context={<span className="text-sm text-muted-foreground">In {world.universe.name}</span>}
        status={waiting ? <StatusPill status="waiting" /> : undefined}
      />

      {outcome === 'accepted' ? (
        <Accepted invitation={invitation} />
      ) : outcome === 'declined' ? (
        <section className="space-y-3 rounded-[18px] border bg-card p-5" data-testid="invitation-declined">
          <p className="text-[15px] font-semibold" role="status">
            Invitation declined.
          </p>
          <Link href="/admin" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
            Back to Orbit
          </Link>
        </section>
      ) : (
        invitation.status !== 'pending' && <Answered invitation={invitation} />
      )}

      <section aria-labelledby="invitation-from" className="space-y-3">
        <SectionHeader id="invitation-from" title="Who invited you" />
        <EntityRow
          href={`/admin/users/${invitedBy.id}`}
          kind="people"
          title={inviterName}
          leading={<PersonIcon woka={invitedBy.woka} name={inviterName} />}
          meta={
            <span className="text-sm text-muted-foreground">invited you {timeAgo(new Date(invitation.invitedAt))}</span>
          }
          testId="invitation-inviter"
        />
        {invitation.message && (
          <blockquote className="border-l-2 border-foreground/20 pl-4 text-[15px] italic text-foreground/85" data-testid="invitation-message">
            “{invitation.message}”
          </blockquote>
        )}
      </section>

      <section aria-labelledby="invitation-world" className="space-y-3">
        <SectionHeader id="invitation-world" title="The world" />
        <div className="space-y-3 rounded-[18px] border bg-card p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={world.isPublic ? 'public' : 'private'} />
            <StatLine items={[count(world.counts.rooms, 'room'), count(world.counts.members, 'member')]} />
          </div>
          {world.description && <p className="text-[15px] text-foreground/85">{world.description}</p>}
          {world.members.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-xs font-semibold text-muted-foreground">Members</p>
              <ul className="flex flex-wrap gap-3" data-testid="invitation-members">
                {world.members.map((member) => (
                  <li key={member.id} className="grid w-16 justify-items-center gap-1 text-center">
                    <WokaAvatar layers={member.woka ?? []} name={member.name ?? ''} size={44} />
                    <span className="w-full truncate text-[11px] text-foreground/85">{member.name || 'A member'}</span>
                  </li>
                ))}
                {world.counts.members > world.members.length && (
                  <li className="grid w-16 content-center justify-items-center text-[11px] font-semibold text-muted-foreground">
                    +{world.counts.members - world.members.length} more
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      </section>

      {waiting && <RoleSection tags={invitation.tags} />}

      {waiting && (
        <section aria-label="Your answer" className="space-y-3" data-testid="invitation-actions">
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-start gap-2">
            {pending !== 'decline' && (
              <Button type="button" className="h-11 px-6" disabled={pending !== null} onClick={() => void accept()}>
                {pending === 'accept' ? 'Accepting…' : 'Accept'}
              </Button>
            )}
            <DeclineWithConfirm
              inviterName={inviterName}
              worldName={world.name}
              disabled={pending !== null}
              onBusyChange={(busy) => setPending(busy ? 'decline' : null)}
              onConfirm={decline}
            />
          </div>
        </section>
      )}
    </div>
  );
}

/** What the role lets you do, in plain words; a custom role by name. */
function RoleSection({ tags }: { tags: string[] }) {
  const { role, custom } = describeRole(tags);
  const onlyCustom = custom.length > 0 && !tags.some((tag) => tag.trim().toLowerCase() === role.tag);
  return (
    <section aria-labelledby="invitation-role" className="space-y-3" data-testid="invitation-role">
      <SectionHeader id="invitation-role" title="Your role" />
      <div className="space-y-2 rounded-[18px] border bg-card p-5 text-[15px]">
        {!onlyCustom && (
          <p className="flex flex-wrap items-center gap-2">
            <RolePill role={role.tag} />
            <span>As {role.label}, you can {role.can}.</span>
          </p>
        )}
        {custom.map((tag) => (
          <p key={tag} className="flex flex-wrap items-center gap-2">
            <RolePill role={tag} />
            <span className="text-muted-foreground">A custom role set by the world’s admins.</span>
          </p>
        ))}
      </div>
    </section>
  );
}

/** Just accepted: you're in, and where to go. Visit only inside the game, where there's a room to go to. */
function Accepted({ invitation }: { invitation: InvitationDetail }) {
  const { world } = invitation;
  const { isReady, navigateToRoom } = useWorkAdventure();
  const [going, setGoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roomUrl = world.firstRoom ? `/@/${world.universe.slug}/${world.slug}/${world.firstRoom.slug}` : null;

  async function visit() {
    if (!roomUrl || going) return;
    setGoing(true);
    setError(null);
    try {
      await navigateToRoom(roomUrl);
    } catch {
      setError(`Couldn’t take you to ${world.name}. Try again.`);
    } finally {
      setGoing(false);
    }
  }

  return (
    <section className="space-y-3 rounded-[18px] border bg-card p-5" data-testid="invitation-accepted">
      <p className="text-[15px] font-semibold" role="status">
        You’re a member of {world.name}
      </p>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {isReady && roomUrl && (
          <Button type="button" className="h-11 px-6" disabled={going} onClick={() => void visit()} data-testid="invitation-visit">
            {going ? 'Going…' : `Visit ${world.name}`}
          </Button>
        )}
        <Button asChild variant="outline" className="h-11 px-5">
          <Link href={`/admin/worlds/${world.id}`}>Open {world.name}’s page</Link>
        </Button>
      </div>
    </section>
  );
}

/** Answered before (or withdrawn): says so plainly; never Accept or Decline. */
function Answered({ invitation }: { invitation: InvitationDetail }) {
  const { world } = invitation;
  const text =
    invitation.status === 'accepted'
      ? 'You already accepted this invitation.'
      : invitation.status === 'rejected'
        ? 'You already declined this invitation.'
        : 'This invitation was withdrawn.';
  return (
    <section className="space-y-3 rounded-[18px] border bg-card p-5" data-testid="invitation-answered">
      <p className="text-[15px] font-semibold">{text}</p>
      {invitation.status === 'accepted' ? (
        <Button asChild variant="outline" className="h-11 px-5">
          <Link href={`/admin/worlds/${world.id}`}>Open {world.name}’s page</Link>
        </Button>
      ) : (
        <Link href="/admin" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
          Back to Orbit
        </Link>
      )}
    </section>
  );
}
