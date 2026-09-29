'use client';

import { Plus } from 'lucide-react';
import { questCopy } from '@/lib/quests/copy';
import type { PublishedQuest } from '@/lib/quests/model';
import { EmptyCard, SectionHeader, StatusPill } from '../ds';
import { QuestRow } from './quest-row';
import { QuestStamp } from './quest-stamp';
import { usePublishedQuest } from './use-published-quest';

/** What a published Welcome chapter offers, in one line: "Meet someone · Explore this place: Courtyard". */
export function questSummary(quest: PublishedQuest): string {
  const parts: string[] = [];
  if (quest.paths.meet) parts.push(questCopy('paths.meet.title'));
  if (quest.paths.explore && quest.area) parts.push(`${questCopy('paths.explore.title')}: ${quest.area.name}`);
  if (quest.paths.build) parts.push(questCopy('paths.build.title'));
  return parts.join(' · ');
}

/** The room's Quests tab, for those who can edit the room: its Welcome chapter, or a way to add one. */
export function RoomQuests({ roomId }: { roomId: string }) {
  const quest = usePublishedQuest(roomId);
  if (quest === undefined) return null;

  return (
    <section aria-labelledby="room-quests" className="space-y-2" data-testid="room-quests">
      <SectionHeader
        id="room-quests"
        title={questCopy('quests')}
        action={quest ? null : { href: `/admin/rooms/${roomId}/quests/new`, label: 'Add a quest', icon: Plus }}
      />
      {quest ? (
        <QuestRow
          href={`/admin/rooms/${roomId}/quests/welcome`}
          leading={<QuestStamp path={quest.paths.explore ? 'explore' : quest.paths.meet ? 'meet' : 'build'} size="sm" />}
          title="Welcome chapter"
          context={questSummary(quest)}
          aside={<StatusPill status={quest.status === 'live' ? 'published' : 'paused'} />}
          testId="room-quest-welcome"
        />
      ) : (
        <EmptyCard kind="room" title="No quests here yet." text="A quest is one short thing to do here." testId="room-quests-empty" />
      )}
    </section>
  );
}
