'use client';

import { PageHeader } from '../../components/ds';
import { PassportSection } from '../../components/passport';
import styles from '../you.module.css';

/** Your passport in full: every stamp, private worlds too, opened from View all on You. */
export default function YourPassportPage() {
  return (
    <div className={styles.page}>
      <PageHeader title="Your passport" />
      <PassportSection bare />
    </div>
  );
}
