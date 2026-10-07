'use client';

import Link from 'next/link';
import { ArrowRight, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { WokaAvatar } from './profile-card';
import { RolePill } from './ds';
import type { MembersPreview } from '../hooks/use-place-data';
import styles from './recent-visitors.module.css';

const ORDER = ['owner', 'admin', 'editor', 'member'];
const SHOWN = 8;

/** A world's members as a row of faces, owners and admins first; the full list, with role changes, is its own page. */
export default function MembersRow({ worldId, preview, onInvite }: { worldId: string; preview: MembersPreview | null; onInvite?: () => void }) {
  if (!preview) return null;
  const { members, total, canManage } = preview;
  const all = `/admin/worlds/${worldId}/members`;
  return (
    <section className={styles.section} aria-labelledby="world-members">
      <div className={styles.head}>
        <h2 id="world-members" className="orbit-display text-lg font-bold">
          Members <span className="ml-1 text-sm font-semibold text-muted-foreground">{total}</span>
        </h2>
        <div className="flex items-center gap-2">
          {canManage && onInvite && (
            <Button variant="outline" className="h-11 rounded-full px-4 text-xs" onClick={onInvite}>
              <UserPlus aria-hidden="true" />
              Invite as member
            </Button>
          )}
          <Link href={all} className={cn('orbit-press', styles.seeAllPill)}>
            See all
          </Link>
        </div>
      </div>
      <ul className={styles.visitors}>
        {members.slice(0, SHOWN).map((member) => {
          const name = member.user.name || member.user.email || 'Someone';
          const role = member.isUniverseOwner ? 'owner' : [...member.tags].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] ?? 'member';
          return (
            <li key={member.id}>
              <Link href={`/admin/users/${member.user.id}`} className={styles.face} aria-label={`${name}, ${role}`}>
                <WokaAvatar layers={member.woka ?? []} name={name} size={44} tinted />
                <strong>{name}</strong>
                <span className="-mt-0.5 scale-90"><RolePill role={role} /></span>
              </Link>
            </li>
          );
        })}
        <li>
          <Link href={all} className={styles.face} aria-label="See all members">
            <span className={styles.seeAllCircle} aria-hidden="true">
              <ArrowRight size={20} />
            </span>
            <strong>See all</strong>
            <span>members</span>
          </Link>
        </li>
      </ul>
    </section>
  );
}
