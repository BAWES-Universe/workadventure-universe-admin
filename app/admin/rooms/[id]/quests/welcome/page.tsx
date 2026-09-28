'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, Navigation, Pause, Pencil, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkAdventure } from '@/app/admin/workadventure-context';
import { QUEST_PATH_COPY, questCopy } from '@/lib/quests/copy';
import { questsProofEnabled } from '@/lib/quests/flag';
import { QUEST_PATHS, questVisitUrl, type PublishedQuest } from '@/lib/quests/model';
import { EmptyCard, InContext, LoadError, LoadingRows, PageHeader, SectionHeader, StatusPill } from '../../../../components/ds';
import { QuestRow } from '../../../../components/quests/quest-row';
import { QuestStamp } from '../../../../components/quests/quest-stamp';
import { QuestsOff } from '../../../../components/quests/quests-off';
import { savePublishedQuest, usePublishedQuest } from '../../../../components/quests/use-published-quest';
import { useQuestRoom, type QuestRoom } from '../../../../components/quests/use-quest-room';
import styles from '../../../../components/quests/quests.module.css';

/** A room's published Welcome chapter: whether it is live, a way to see it in the game, Edit, and Pause. */
export default function WelcomeQuestPage() {
  const roomId = useParams().id as string;
  if (!questsProofEnabled()) return <QuestsOff />;
  return <WelcomeQuest roomId={roomId} />;
}

function WelcomeQuest({ roomId }: { roomId: string }) {
  const { state, retry } = useQuestRoom(roomId, false);
  const quest = usePublishedQuest(roomId);

  if (state.status === 'ready' && state.room.canEdit && quest) {
    return <PublishedWelcome room={state.room} quest={quest} />;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Welcome chapter" />
      {(state.status === 'loading' || quest === undefined) && <LoadingRows label="this quest" rows={2} />}
      {state.status === 'error' && <LoadError label="this room" retry={retry} />}
      {state.status === 'missing' && (
        <EmptyCard kind="room" title="Room not found." text="It may have been deleted, or you may not have access to it." />
      )}
      {state.status === 'ready' && !state.room.canEdit && (
        <EmptyCard kind="room" title="Only people who can edit this room manage its quests." text="Ask its owner, or an admin or editor of its world." />
      )}
      {state.status === 'ready' && state.room.canEdit && quest === null && (
        <EmptyCard
          kind="room"
          title="No welcome chapter here yet."
          text="Nothing is published for this room in this browser."
          href={`/admin/rooms/${roomId}/quests/new`}
          action="Add a quest"
          testId="quest-none"
        />
      )}
    </div>
  );
}

function PublishedWelcome({ room, quest }: { room: QuestRoom; quest: PublishedQuest }) {
  const { isReady: waReady, navigateToRoom } = useWorkAdventure();
  const [visiting, setVisiting] = useState(false);
  const [visitError, setVisitError] = useState<string | null>(null);
  const live = quest.status === 'live';
  const roomHref = `/admin/rooms/${room.id}`;
  const offered = QUEST_PATHS.filter((path) => quest.paths[path]);

  function togglePause() {
    savePublishedQuest(room.id, { ...quest, status: live ? 'paused' : 'live' });
  }

  async function visit() {
    setVisiting(true);
    setVisitError(null);
    try {
      await navigateToRoom(questVisitUrl(`/@/${room.world.universe.slug}/${room.world.slug}/${room.slug}`, quest));
    } catch {
      setVisitError('The game didn’t open the room. Try again from inside the game.');
    } finally {
      setVisiting(false);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Welcome chapter"
        context={<InContext parts={[{ label: room.name, href: `${roomHref}?tab=quests` }]} />}
        status={<StatusPill status={live ? 'published' : 'paused'} />}
        actions={
          <>
            <Button
              className="h-11"
              onClick={visit}
              disabled={visiting || !waReady}
              title={!waReady ? 'Works when Orbit is open inside the game' : undefined}
            >
              {visiting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Navigation aria-hidden="true" />}
              Visit the room
            </Button>
            <Button variant="outline" className="h-11" asChild>
              <Link href={`${roomHref}/quests/new`}>
                <Pencil aria-hidden="true" />
                Edit
              </Link>
            </Button>
            <Button variant="outline" className="h-11" onClick={togglePause} aria-describedby="quest-pause-note">
              {live ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {live ? 'Pause' : 'Resume'}
            </Button>
          </>
        }
      >
        <p className={styles.pauseNote} data-testid="quest-where">
          {live ? 'Live in this browser (prototype).' : 'Paused in this browser (prototype).'} Where it appears: {room.name}.
        </p>
        <p id="quest-pause-note" className={styles.pauseNote} role="status">
          {live
            ? 'Pause: new visitors won’t be invited. People who accepted keep their progress.'
            : 'Paused: new visitors aren’t invited. People who accepted keep their progress.'}
        </p>
        {visitError && (
          <p className={styles.problem} role="alert">
            {visitError}
          </p>
        )}
      </PageHeader>

      <section aria-labelledby="quest-offers" className="space-y-2">
        <SectionHeader id="quest-offers" title="What newcomers can do" />
        <div>
          {offered.map((path) => (
            <QuestRow
              key={path}
              leading={<QuestStamp path={path} size="sm" />}
              title={questCopy(QUEST_PATH_COPY[path].title)}
              context={questCopy(QUEST_PATH_COPY[path].description, { area: quest.area?.name ?? '' })}
              aside={questCopy('stamps.badge', { stamp: questCopy(QUEST_PATH_COPY[path].stamp) })}
              testId={`quest-offer-${path}`}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="quest-host" className="space-y-2">
        <SectionHeader id="quest-host" title="Who greets them" />
        <p className="text-sm text-foreground/85">
          {quest.host.kind === 'none' ? `No host: the invitation comes from ${room.name}.` : quest.host.name}
        </p>
      </section>
    </div>
  );
}
