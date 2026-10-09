'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMembersPreview, type MemberPreview } from '../hooks/use-place-data';
import MembersRow from './members-row';
import { PersonSheet } from './person-sheet';
import { RolePills } from './ds';
import styles from './recent-visitors.module.css';

/** Room access uses world membership; reuse its ranked preview and management page. */
export default function RoomMembers({ world }: { world: { id: string; name: string } }) {
  const preview = useMembersPreview(world.id);
  const [picked, setPicked] = useState<MemberPreview | null>(null);
  return (
    <>
      <MembersRow worldId={world.id} preview={preview} onSelect={setPicked} description={`Members of ${world.name} belong to all its rooms.`} />
      <PersonSheet
        person={picked && { userId: picked.user.id, name: picked.user.name || picked.user.email || 'Someone', woka: picked.woka ?? [] }}
        description={`Member of ${world.name} · Access to all its rooms`}
        onClose={() => setPicked(null)}
        testId="member-sheet"
      >
        {picked && <RolePills roles={picked.isUniverseOwner ? ['owner', ...picked.tags] : picked.tags} />}
        {preview?.canManage && <Link href={`/admin/worlds/${world.id}/members`} className={styles.full}>Manage membership</Link>}
      </PersonSheet>
    </>
  );
}
