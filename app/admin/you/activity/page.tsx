'use client';

import { PageHeader } from '../../components/ds';
import { ActivitySection } from '../../components/passport';
import styles from '../you.module.css';

/** Your activity in full, newest first, opened from View all on You. */
export default function YourActivityPage() {
  return (
    <div className={styles.page}>
      <PageHeader title="Your activity" />
      <ActivitySection bare />
    </div>
  );
}
