'use client';

import { questCopy } from '@/lib/quests/copy';
import { PageHeader } from '../../components/ds';
import { ChapterProgress, QuestListRow, useChapter } from '../../components/quests/chapter';
import styles from '../../components/quests/quests.module.css';

const GROUPS = [
  {
    key: 'open',
    label: questCopy('log.inProgress'),
    statuses: ['tracked', 'accepted'],
  },
  { key: 'not-started', label: 'Not started', statuses: ['not-started'] },
  { key: 'done', label: questCopy('log.done'), statuses: ['done'] },
] as const;

/**
 * Your quest log in Orbit, as the plan has it ("quests inside Orbit are a log page"): the chapter's quests grouped as
 * in the game, each opening its own page. Taking, following and abandoning a quest happen in the game.
 */
export default function QuestsPage() {
  const { quests, done, total, heardFromGame } = useChapter();
  return (
    <div className={styles.questPage}>
      <PageHeader title={questCopy('quests')} context={<span className={styles.pageContext}>Welcome chapter</span>}>
        <ChapterProgress done={done} total={total} />
      </PageHeader>
      {!heardFromGame && (
        <p className={styles.youCardNote} data-testid="quests-not-heard">
          Open Orbit from the game to see where you are with each quest.
        </p>
      )}
      {GROUPS.map((group) => {
        const shown = quests.filter((quest) => (group.statuses as readonly string[]).includes(quest.status));
        if (shown.length === 0) return null;
        return (
          <section
            key={group.key}
            aria-labelledby={`quests-${group.key}`}
            className={styles.questGroup}
            data-testid={`quests-${group.key}`}
          >
            <h2 id={`quests-${group.key}`}>{group.label}</h2>
            {group.key === 'not-started' && (
              <p className={styles.groupNote}>Take these in the game: open Quests from the pill, or walk up to a host with a “!”.</p>
            )}
            <div className={styles.questList}>
              {shown.map((quest) => (
                <QuestListRow key={quest.id} quest={quest} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
