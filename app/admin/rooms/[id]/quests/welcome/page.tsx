'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, Navigation, Pause, Pencil, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkAdventure } from '@/app/admin/workadventure-context';
import { QUEST_PATH_COPY, questCopy } from '@/lib/quests/copy';
import { questsProofEnabled } from '@/lib/quests/flag';
import { QUEST_PATHS, questVisitUrl, type PublishedQuest } from '@/lib/quests/model';
import { waRoomPath } from '@/lib/wa-room-path';
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

/**
 * Whether the game is in this room: true, false, or null while it is still asking. Visiting the room you are in only
 * moves you back to its start (out of any conversation) and brings no new arrival, so the page doesn't offer it.
 */
function useInRoom(roomPath: string): boolean | null {
  const { wa, isReady } = useWorkAdventure();
  const [here, setHere] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isReady || !wa) return;
    let cancelled = false;
    wa.onInit()
      .then(() => waRoomPath(wa.room.id) === roomPath)
      .catch(() => false)
      .then((inRoom) => {
        if (!cancelled) setHere(inRoom);
      });
    return () => {
      cancelled = true;
    };
  }, [wa, isReady, roomPath]);
  return isReady && wa ? here : false;
}

function PublishedWelcome({ room, quest }: { room: QuestRoom; quest: PublishedQuest }) {
  const { isReady: waReady, navigateToRoom } = useWorkAdventure();
  const [visiting, setVisiting] = useState(false);
  const [visitError, setVisitError] = useState<string | null>(null);
  const live = quest.status === 'live';
  const roomHref = `/admin/rooms/${room.id}`;
  const roomPath = `/@/${room.world.universe.slug}/${room.world.slug}/${room.slug}`;
  const here = useInRoom(roomPath);
  const offered = QUEST_PATHS.filter((path) => quest.paths[path]);

  function togglePause() {
    savePublishedQuest(room.id, { ...quest, status: live ? 'paused' : 'live' });
  }

  async function visit() {
    if (here !== false) return;
    setVisiting(true);
    setVisitError(null);
    try {
      await navigateToRoom(questVisitUrl(roomPath, quest));
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
            {here !== true && (
              <Button
                className="h-11"
                onClick={visit}
                disabled={visiting || !waReady || here === null}
                title={!waReady ? 'Works when Orbit is open inside the game' : undefined}
              >
                {visiting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Navigation aria-hidden="true" />}
                Visit the room
              </Button>
            )}
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
        {here === true && (
          <p className={styles.pauseNote} data-testid="quest-here">
            You’re in this room. The Welcome chapter’s choices apply the next time you arrive here.
          </p>
        )}
        <p id="quest-pause-note" className={styles.pauseNote} role="status">
          {live
            ? 'Pause keeps your choices out of Visit the room. The game doesn’t read this browser’s record yet, so visitors are still invited.'
            : 'Paused in this browser: Visit the room opens it without your choices.'}
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
