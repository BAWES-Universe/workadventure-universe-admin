'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Crown, Shield, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { summariseRoles, worldsLabel, type Worlds } from '@/lib/member-roles';
import { Button } from '@/components/ui/button';
import { RolePill } from '@/components/ui/choice';
import { FormSheet } from './form-sheet';
import { WokaAvatar } from './profile-card';
import InviteSheet from './invite-sheet';
import { OwnerCrown, RoleChip, useJson, useUniverseBasics, useUniverseRoles, useWorldNames } from './universe-people';
import styles from './recent-visitors.module.css';

const SHOWN = 8;

interface Face {
  userId: string;
  name: string | null;
  email: string | null;
  isOwner: boolean;
  /** False only for an owner who never joined: everyone in the members list joined. */
  joined?: boolean;
  woka?: string[];
  worlds: Worlds;
  roles: { roleId: string; allWorlds: boolean; worldIds: string[] }[];
}

interface Answer {
  members: Face[];
  total: number;
  owner: { userId: string; name: string | null; email: string | null; woka: string[]; joined: boolean } | null;
}

/**
 * A universe's people as a row of faces, the owner and the highest roles first; each carries its highest role and "+N"
 * for the rest. The whole list, with filters, is its own page.
 */
export default function UniverseMembersRow({ universeId, className }: { universeId: string; className?: string }) {
  const [inviting, setInviting] = useState(false);
  const [listing, setListing] = useState<Face | null>(null);
  const [answer] = useJson<Answer>(`/api/admin/universes/${universeId}/members?order=roles`, (body) => ({
    members: body.members ?? [],
    total: body.total ?? 0,
    owner: body.owner ?? null,
  }));
  const [me] = useJson<{ invite: 'all' | string[] }>(`/api/admin/universes/${universeId}/me`, (body) => ({ invite: body.inviteWorlds ?? [] }));
  const roles = useUniverseRoles(universeId);
  const basics = useUniverseBasics(universeId);
  const worldNames = useWorldNames(basics);

  const faces = useMemo(() => {
    if (answer.status !== 'ready' || roles.status !== 'ready') return [];
    const { members, owner } = answer.value;
    const others = members.filter((member) => !member.isOwner);
    const ownerFace: Face[] = owner
      ? [members.find((member) => member.isOwner) ?? { userId: owner.userId, name: owner.name, email: owner.email, isOwner: true, joined: owner.joined, woka: owner.woka, worlds: { allWorlds: true, worldIds: [] }, roles: [] }]
      : [];
    // The server lists the highest roles first; the owner leads
    return [...ownerFace, ...others].slice(0, SHOWN);
  }, [answer, roles]);

  if (answer.status !== 'ready' || roles.status !== 'ready') return null;
  const { total, owner } = answer.value;
  const people = total + (owner && !owner.joined ? 1 : 0);
  const canInvite = me.status === 'ready' && (me.value.invite === 'all' || me.value.invite.length > 0);
  const all = `/admin/universes/${universeId}/members`;

  return (
    <section className={cn(styles.section, className)} aria-labelledby="universe-members">
      <div className={styles.head}>
        <h2 id="universe-members" className="orbit-display text-lg font-bold">
          Members <span className="ml-1 text-sm font-semibold text-muted-foreground">{people.toLocaleString()}</span>
        </h2>
        <Link href={all} className={cn('orbit-press', styles.seeAllPill)}>
          See all
        </Link>
      </div>
      <div className="flex flex-wrap gap-2">
        {canInvite && (
          <Button variant="outline" className="h-11 px-4" onClick={() => setInviting(true)}>
            <UserPlus aria-hidden="true" />
            Invite member
          </Button>
        )}
        <Button asChild variant="outline" className="h-11 px-4">
          <Link href={`/admin/universes/${universeId}/roles`}>
            <Shield aria-hidden="true" />
            Roles & permissions
          </Link>
        </Button>
      </div>
      <ul className="-mx-1.5 flex gap-1.5 overflow-x-auto px-1.5 pb-1 pt-2 [scrollbar-width:none] md:flex-wrap md:overflow-visible" data-testid="members-faces">
        {faces.map((face) => {
          const name = face.name || face.email || 'Someone';
          const summary = summariseRoles(face, roles.value.byId, worldNames);
          return (
            <li key={face.userId} className="flex w-[128px] flex-none flex-col items-center gap-0.5">
              <Link href={`${all}/${face.userId}`} className={styles.face} aria-label={face.isOwner ? `${name}, owner` : name}>
                <WokaAvatar layers={face.woka ?? []} name={name} size={44} tinted round />
                <strong>
                  {face.isOwner && <OwnerCrown className="mr-1 inline h-3 w-3 -translate-y-px" />}
                  {name}
                </strong>
              </Link>
              <button
                type="button"
                onClick={() => setListing(face)}
                aria-label={`${name}’s roles: ${summary.name}${summary.more ? ` and ${summary.more} more` : ''}`}
                className="-mt-1 inline-flex min-h-11 max-w-full min-w-0 items-center gap-0.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex min-w-0 scale-90 items-center"><RoleChip name={summary.name} color={summary.color} /></span>
                {summary.more > 0 && <span className="-ml-1.5 scale-90"><RolePill name={`+${summary.more}`} className="px-2" /></span>}
              </button>
            </li>
          );
        })}
      </ul>
      {listing && (
        <RolesSheet
          face={listing}
          name={listing.name || listing.email || 'Someone'}
          roles={roles.value.byId}
          worldNames={worldNames}
          universeName={basics.status === 'ready' ? basics.value.name : 'this universe'}
          onClose={() => setListing(null)}
        />
      )}
      <InviteSheet open={inviting} onOpenChange={setInviting} universeId={universeId} />
    </section>
  );
}

/** Everything behind a "+N": the owner mark, every role they were given, in full, then Member for everyone who joined. */
function RolesSheet({ face, name, roles, worldNames, universeName, onClose }: {
  face: Face;
  name: string;
  roles: ReadonlyMap<string, { id: string; key: string; name: string; color: string }>;
  worldNames: ReadonlyMap<string, string>;
  universeName: string;
  onClose: () => void;
}) {
  const given = face.roles.filter((role) => roles.has(role.roleId));
  const member = [...roles.values()].find((role) => role.key === 'member');
  const memberWhere = worldsLabel(face.worlds, worldNames);
  return (
    <FormSheet open onOpenChange={(open) => !open && onClose()} title={`${name}’s roles`}>
      <ul className="m-0 grid list-none p-0" data-testid="roles-sheet">
        {face.isOwner && (
          <li className="flex min-h-12 items-center gap-3 border-b border-foreground/10 py-1 text-[15px] font-semibold">
            <Crown aria-hidden="true" className="h-4 w-4 shrink-0 text-[#FACC15]" />
            <span className="min-w-0">
              Owner
              <span className="block text-[13px] font-normal text-muted-foreground">Created {universeName}</span>
            </span>
          </li>
        )}
        {given.map((role) => {
          const info = roles.get(role.roleId)!;
          const where = worldsLabel(role, worldNames);
          return (
            <li key={role.roleId} className="flex min-h-12 items-center gap-3 border-b border-foreground/10 py-1 text-[15px] font-semibold last:border-b-0">
              <i aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: info.color }} />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {info.name}
                {where && <span className="block text-[13px] font-normal text-muted-foreground">{where}</span>}
              </span>
            </li>
          );
        })}
        {face.joined !== false && (
          <li className="flex min-h-12 items-center gap-3 border-b border-foreground/10 py-1 text-[15px] font-semibold last:border-b-0">
            <i aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: member?.color ?? '#A78BFA' }} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {member?.name ?? 'Member'}
              {memberWhere && <span className="block text-[13px] font-normal text-muted-foreground">{memberWhere}</span>}
            </span>
          </li>
        )}
      </ul>
      <Button type="button" variant="outline" className="h-11" onClick={onClose}>
        Close
      </Button>
    </FormSheet>
  );
}
