'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Shield, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { summariseRoles, type Worlds } from '@/lib/member-roles';
import { Button } from '@/components/ui/button';
import { RolePill } from '@/components/ui/choice';
import { WokaAvatar } from './profile-card';
import InviteSheet from './invite-sheet';
import { RoleChip, useJson, useUniverseBasics, useUniverseRoles, useWorldNames, type UniverseRole } from './universe-people';
import styles from './recent-visitors.module.css';

const SHOWN = 8;

interface Face {
  userId: string;
  name: string | null;
  email: string | null;
  isOwner: boolean;
  woka?: string[];
  worlds: Worlds;
  roles: { roleId: string; allWorlds: boolean; worldIds: string[] }[];
}

interface Answer {
  members: Face[];
  total: number;
  owner: { userId: string; name: string | null; email: string | null; woka: string[]; joined: boolean } | null;
}

/** How high someone ranks: the owner, then the highest role they hold. */
function rankOf(face: Face, roles: ReadonlyMap<string, UniverseRole>): number {
  if (face.isOwner) return Infinity;
  return Math.max(0, ...face.roles.map((given) => roles.get(given.roleId)?.position ?? 0));
}

/**
 * A universe's people as a row of faces, the owner and the highest roles first; each carries its highest role and "+N"
 * for the rest. The whole list, with filters, is its own page.
 */
export default function UniverseMembersRow({ universeId, className }: { universeId: string; className?: string }) {
  const [inviting, setInviting] = useState(false);
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
      ? [members.find((member) => member.isOwner) ?? { userId: owner.userId, name: owner.name, email: owner.email, isOwner: true, woka: owner.woka, worlds: { allWorlds: true, worldIds: [] }, roles: [] }]
      : [];
    const byRole = roles.value.byId;
    return [...ownerFace, ...others.sort((a, b) => rankOf(b, byRole) - rankOf(a, byRole))].slice(0, SHOWN);
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
            <li key={face.userId} className="w-[100px] flex-none">
              <Link href={`${all}/${face.userId}`} className={styles.face} aria-label={`${name}, ${summary.name}${summary.more ? ` and ${summary.more} more` : ''}`}>
                <WokaAvatar layers={face.woka ?? []} name={name} size={44} tinted round />
                <strong>{name}</strong>
                <span className="-mt-0.5 inline-flex items-center gap-1">
                  <span className="scale-90"><RoleChip name={summary.name} color={summary.color} /></span>
                  {summary.more > 0 && <span className="scale-90"><RolePill name={`+${summary.more}`} /></span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <InviteSheet open={inviting} onOpenChange={setInviting} universeId={universeId} />
    </section>
  );
}
