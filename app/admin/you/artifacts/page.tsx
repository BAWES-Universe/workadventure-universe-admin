'use client';

import { PageHeader } from '../../components/ds';
import { AllArtifacts } from '../../components/your-artifacts';
import styles from '../you.module.css';

/** Every artifact you own, newest first, opened from View all on You (game #1474). */
export default function YourArtifactsPage() {
  return (
    <div className={styles.page}>
      <PageHeader title="Your artifacts" />
      <AllArtifacts />
    </div>
  );
}
