'use client';

import type { LiveView } from '@/lib/live-presence';
import { Place } from './ds';
import { VisitButton } from './place-hero';
import styles from './now-in.module.css';

/**
 * Where someone is right now, on their profile, with Visit (or "You're in this room"). It reads the live view, which
 * already leaves out anyone who doesn't share their room with the viewer and any room the viewer can't enter, so it
 * shows nothing for them, as it does for someone offline.
 */
export function NowIn({ live, uuid }: { live: LiveView | null | undefined; uuid: string }) {
  const place = live?.people.find((person) => person.uuid === uuid && !person.you)?.place;
  if (!place) return null;
  const here = Boolean(live?.places.some((room) => room.here && room.roomId === place.roomId));
  return (
    <div className={styles.nowIn} data-testid="now-in">
      <span className={styles.label}>Now in</span>
      <strong className={styles.room}>
        <Place kind="room" label={place.name} />
      </strong>
      <span className={styles.where}>
        <Place kind="world" label={place.world.name} />
        <Place kind="universe" label={place.universe.name} />
      </span>
      {here ? (
        <span className={styles.here}>You’re in this room</span>
      ) : (
        <div className={styles.go}>
          <VisitButton playPath={place.playPath} roomId={place.roomId} name={place.name} />
        </div>
      )}
    </div>
  );
}
