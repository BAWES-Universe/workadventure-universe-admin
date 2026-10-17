'use client';

import Link from 'next/link';
import { UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { WokaAvatar } from './profile-card';
import { RolePill } from './ds';
import { RoleChip, useUniverseRoles, type UniverseRole } from './universe-people';
import type { MemberPreview, MembersPreview } from '../hooks/use-place-data';
import styles from './recent-visitors.module.css';

const ORDER = ['owner', 'admin', 'editor', 'member'];
const SHOWN = 8;

/** The one role a face carries: the universe's owner first, else the highest of their tags. */
export function topRole(member: Pick<MemberPreview, 'isUniverseOwner' | 'tags'>): string {
  return member.isUniverseOwner ? 'owner' : [...member.tags].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] ?? 'member';
}

/** A world's members as a row of faces, owners and admins first; the full list, with role changes, is its own page. */
/**
 * The role a face carries when the universe's roles are known: its highest, wherever the universe ranks it, so a custom
 * role such as Accountant shows as itself. Null when none of their tags is a role the universe has.
 */
export function topUniverseRole(member: Pick<MemberPreview, 'tags'>, byKey: ReadonlyMap<string, UniverseRole>): UniverseRole | null {
  const held = member.tags.map((tag) => byKey.get(tag.toLowerCase())).filter((role): role is UniverseRole => !!role);
  return held.sort((a, b) => b.position - a.position)[0] ?? null;
}

export default function MembersRow({ worldId, preview, onInvite, canInvite, onSelect, description }: {
  worldId: string;
  preview: MembersPreview | null;
  onInvite?: () => void;
  /** Whether Invite member shows; when left out, whoever manages the world. */
  canInvite?: boolean;
  onSelect?: (member: MemberPreview) => void;
  description?: string;
}) {
  const roles = useUniverseRoles(preview?.universeId ?? null);
  if (!preview) return null;
  const { members, total, canManage, universeId } = preview;
  // The approved screens replace the world's own list: See all goes to the universe's Members page, on this world
  const all = universeId ? `/admin/universes/${universeId}/members?world=${worldId}` : `/admin/worlds/${worldId}/members`;
  const byKey = roles.status === 'ready' ? new Map(roles.value.list.map((role) => [role.key, role])) : null;
  return (
    <section className={styles.section} aria-labelledby="world-members">
      <div className={styles.head}>
        <h2 id="world-members" className="orbit-display text-lg font-bold">
          Members <span className="ml-1 text-sm font-semibold text-muted-foreground">{total}</span>
        </h2>
        <div className="flex items-center gap-2">
          {(canInvite ?? canManage) && onInvite && (
            <Button variant="outline" className="h-11 rounded-full px-4 text-xs" onClick={onInvite}>
              <UserPlus aria-hidden="true" />
              Invite member
            </Button>
          )}
          <Link href={all} className={cn('orbit-press', styles.seeAllPill)}>
            See all
          </Link>
        </div>
      </div>
      {description && <p className={styles.note}>{description}</p>}
      {total === 0 && <p className={styles.note}>No members yet.</p>}
      <ul className={styles.visitors}>
        {members.slice(0, SHOWN).map((member) => {
          const name = member.user.name || member.user.email || 'Someone';
          const owner = member.isUniverseOwner;
          const custom = !owner && byKey ? topUniverseRole(member, byKey) : null;
          const role = owner ? 'owner' : custom ? custom.name : topRole(member);
          const face = <>
            <WokaAvatar layers={member.woka ?? []} name={name} size={44} tinted />
            <strong>{name}</strong>
            <span className="-mt-0.5 scale-90">{custom ? <RoleChip name={custom.name} color={custom.color} /> : <RolePill role={owner ? 'owner' : topRole(member)} />}</span>
          </>;
          return (
            <li key={member.id}>
              {onSelect ? (
                <button type="button" className={styles.face} aria-label={`${name}, ${role}`} onClick={() => onSelect(member)}>{face}</button>
              ) : (
                <Link href={`/admin/users/${member.user.id}`} className={styles.face} aria-label={`${name}, ${role}`}>{face}</Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
