import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './quests.module.css';

/** One quest in a list: the stamp where a row's kind chip goes. The whole row is the link when there is one. */
export function QuestRow({
  href,
  leading,
  title,
  context,
  aside,
  testId,
}: {
  href?: string;
  leading: ReactNode;
  title: string;
  context?: ReactNode;
  aside?: ReactNode;
  testId?: string;
}) {
  return (
    <div className={styles.row} data-testid={testId}>
      {leading}
      <div className={styles.rowText}>
        {href ? (
          <Link href={href} className={styles.stretched}>
            <strong>{title}</strong>
          </Link>
        ) : (
          <strong>{title}</strong>
        )}
        {context && <span className={styles.rowContext}>{context}</span>}
      </div>
      {aside && <div className={styles.rowAside}>{aside}</div>}
    </div>
  );
}
