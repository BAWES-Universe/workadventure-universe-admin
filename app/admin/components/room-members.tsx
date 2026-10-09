'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMembersPreview, type MemberPreview } from '../hooks/use-place-data';
import InviteMemberDialog from './invite-member-dialog';
import MembersRow, { topRole } from './members-row';
import { PersonSheet } from './person-sheet';
import { RolePills } from './ds';
import styles from './recent-visitors.module.css';

/** Room access uses world membership; reuse its ranked preview and management page. */
export default function RoomMembers({ world }: { world: { id: string; name: string } }) {
  const preview = useMembersPreview(world.id);
  const [picked, setPicked] = useState<MemberPreview | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  // Your own card and the owner's card say less than a card for anyone else: neither offers membership changes.
  const isYou = !!picked && picked.user.id === preview?.yourId;
  const universe = preview?.universeName ?? 'the universe';
  const description = !picked
    ? ''
    : isYou && picked.isUniverseOwner
      ? `You own ${universe} · Every world and room in it`
      : picked.isUniverseOwner
        ? `Owns ${universe}`
        : `Member of ${world.name} · Access to all its rooms`;
  return (
    <>
      <MembersRow
        worldId={world.id}
        preview={preview}
        onSelect={setPicked}
        onInvite={() => setInviteOpen(true)}
        description={`Members of ${world.name} belong to all its rooms.`}
      />
      <PersonSheet
        person={picked && { userId: picked.user.id, name: picked.user.name || picked.user.email || 'Someone', woka: picked.woka ?? [] }}
        description={description}
        onClose={() => setPicked(null)}
        testId="member-sheet"
        tag={isYou ? <span className={styles.you}>You</span> : undefined}
        fullProfile={!isYou}
        actions={
          isYou ? (
            <Link href="/admin/you" className={styles.full}>Your profile</Link>
          ) : preview?.canManage && picked && !picked.isUniverseOwner ? (
            <Link href={`/admin/worlds/${world.id}/members`} className={styles.full}>Manage membership</Link>
          ) : undefined
        }
      >
        {picked && <RolePills roles={isYou || picked.isUniverseOwner ? [topRole(picked)] : picked.tags} />}
      </PersonSheet>
      {preview?.canManage && <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} worldId={world.id} onInviteSent={() => {}} />}
    </>
  );
}
