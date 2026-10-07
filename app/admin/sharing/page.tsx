'use client';

import { Users } from 'lucide-react';
import { SharingSettings } from '../components/live/sharing-settings';
import styles from './sharing.module.css';

/** Sharing: what people outside your room can see about you. In a room you are never hidden. */
export default function SharingPage() {
  return (
    <div className={styles.page}>
      <header>
        <h1 className={styles.title}>Sharing</h1>
        <p className={styles.lede}>What people outside your room can see about you.</p>
      </header>
      <section className={styles.roomNote}>
        <Users size={20} aria-hidden="true" />
        <p>
          <b>In a room, you’re never hidden.</b> Everyone in the same room sees your Woka and can talk to you, whatever
          you pick here.
        </p>
      </section>
      <SharingSettings />
    </div>
  );
}
