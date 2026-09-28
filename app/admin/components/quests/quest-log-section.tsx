'use client';

import { useSyncExternalStore } from 'react';
import type { OrbitQuestEntry } from '@/lib/orbit-bridge';
import { isolateName, questCopy, type QuestCopyKey } from '@/lib/quests/copy';
import { QUEST_STAMP_PATH } from '@/lib/quests/model';
import { getQuestLog, getServerQuestLog, subscribeQuestLog } from '@/lib/quests/quest-log';
import { EmptyCard, SectionHeader } from '../ds';
import { QuestRow } from './quest-row';
import { QuestStamp } from './quest-stamp';
import styles from './quests.module.css';

const GROUPS: { status: OrbitQuestEntry['status']; label: QuestCopyKey }[] = [
  { status: 'tracked', label: 'log.tracked' },
  { status: 'accepted', label: 'log.accepted' },
  { status: 'done', label: 'log.done' },
];

const STAMP_NAME: Record<keyof typeof QUEST_STAMP_PATH, QuestCopyKey> = {
  'first-hello': 'stamps.meet',
  explorer: 'stamps.explore',
  builder: 'stamps.build',
};

/**
 * Your quests on You, as the game shows them in its log: what you follow, what you took on, what you've done. The
 * game sends them over the bridge (`orbit-quest-state`); Orbit keeps nothing of its own.
 */
export function QuestLogSection() {
  const entries = useSyncExternalStore(subscribeQuestLog, getQuestLog, getServerQuestLog) ?? [];
  const open = entries.filter((entry) => entry.status !== 'done').length;

  return (
    <section aria-labelledby="quests-heading" data-testid="quest-log">
      <SectionHeader id="quests-heading" title={questCopy('quests')} count={open} />
      {entries.length === 0 ? (
        <EmptyCard
          kind="room"
          title="No quests yet — walk into a room and look around."
          text="Quests you take on in the game show up here."
          testId="quest-log-empty"
        />
      ) : (
        <div className={styles.log}>
          {GROUPS.map(({ status, label }) => {
            const shown = entries.filter((entry) => entry.status === status);
            if (shown.length === 0) return null;
            return (
              <div key={status} className={styles.group}>
                <h3 className={styles.groupTitle}>{questCopy(label)}</h3>
                <div>
                  {shown.map((entry) => (
                    <QuestRow
                      key={entry.id}
                      testId={`quest-${entry.id}`}
                      leading={
                        entry.stamp ? (
                          <QuestStamp path={QUEST_STAMP_PATH[entry.stamp]} size="sm" muted={status !== 'done'} />
                        ) : undefined
                      }
                      title={entry.title}
                      context={
                        entry.giver
                          ? questCopy('log.fromHost', { host: isolateName(entry.giver), room: isolateName(entry.room) })
                          : questCopy('log.here', { room: isolateName(entry.room) })
                      }
                      aside={
                        status === 'done' && entry.stamp
                          ? questCopy('stamps.badge', { stamp: questCopy(STAMP_NAME[entry.stamp]) })
                          : undefined
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
