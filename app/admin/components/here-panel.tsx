'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { useWorkAdventure } from '../workadventure-context';
import { authenticatedFetch } from '@/lib/client-auth';
import RoomSignalCard, { OrbitalIllustration } from './room-signal-card';
import type { SignalRoom } from './room-signal-data';
import styles from './room-signal-card.module.css';

/** The shared start map is a launch point, not a personally owned destination. */
export function isStartMap(playUri: string): boolean {
  try {
    const path = new URL(playUri).pathname.split('/').filter(Boolean);
    return path[0] === '@' && path[1] === 'default' && path[2] === 'default' && path[3] === 'default';
  } catch {
    return false;
  }
}

type HereState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'start'; roomId?: string; historyUnavailable?: boolean }
  | { kind: 'room'; room: SignalRoom }
  | { kind: 'unknown'; playUri: string; failed: boolean };
type PreviousState =
  | { currentId: string; kind: 'loading' | 'error' | 'empty' }
  | { currentId: string; kind: 'room'; room: SignalRoom };

/** Current coordinates, followed by the real previous stop returned by the user's visit history. */
export default function HerePanel() {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const [located, setLocated] = useState<HereState>({ kind: 'loading' });
  const [previous, setPrevious] = useState<PreviousState | null>(null);
  const [retry, setRetry] = useState(0);
  const [previousRetry, setPreviousRetry] = useState(0);
  const unavailable = Boolean(error) || (!isReady && !isLoading);
  const state: HereState = unavailable ? { kind: 'unavailable' } : located;
  const currentId = state.kind === 'room' ? state.room.id : state.kind === 'start' ? state.roomId ?? null : null;

  useEffect(() => {
    if (unavailable || !isReady || !wa) return;
    const controller = new AbortController();
    const api = wa;
    setLocated({ kind: 'loading' });

    async function locate() {
      let playUri = '';
      try {
        await api.onInit();
        if (controller.signal.aborted) return;
        playUri = (api.room.id as string | undefined) ?? '';
        if (!playUri) {
          setLocated({ kind: 'unavailable' });
          return;
        }
        if (isStartMap(playUri)) {
          setLocated({ kind: 'start' });
        }
        const response = await authenticatedFetch(`/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent(playUri)}`, { signal: controller.signal });
        if (response.ok) {
          const room = await response.json() as SignalRoom;
          if (!controller.signal.aborted) setLocated(isStartMap(playUri) ? { kind: 'start', roomId: room.id } : { kind: 'room', room });
        } else if (!controller.signal.aborted) {
          setLocated(isStartMap(playUri) ? { kind: 'start', historyUnavailable: true } : { kind: 'unknown', playUri, failed: response.status !== 404 });
        }
      } catch {
        if (!controller.signal.aborted) setLocated(isStartMap(playUri) ? { kind: 'start', historyUnavailable: true } : playUri ? { kind: 'unknown', playUri, failed: true } : { kind: 'unavailable' });
      }
    }
    void locate();
    return () => controller.abort();
  }, [wa, isReady, unavailable, retry]);

  useEffect(() => {
    if (!currentId) return;
    const controller = new AbortController();
    const roomId = currentId;
    setPrevious({ currentId: roomId, kind: 'loading' });
    async function loadPrevious() {
      try {
        const response = await authenticatedFetch(`/api/admin/rooms/previous?currentRoomId=${encodeURIComponent(roomId)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Previous location unavailable');
        const data = await response.json() as { room: SignalRoom | null };
        if (!controller.signal.aborted) setPrevious(data.room
          ? { currentId: roomId, kind: 'room', room: data.room }
          : { currentId: roomId, kind: 'empty' });
      } catch {
        if (!controller.signal.aborted) setPrevious({ currentId: roomId, kind: 'error' });
      }
    }
    void loadPrevious();
    return () => controller.abort();
  }, [currentId, previousRetry]);

  if (state.kind === 'unavailable') return null;
  if (state.kind === 'loading') return <section className={styles.location} aria-label="Current location"><div className={styles.skeleton} role="status"><span className="sr-only">Finding your current room…</span></div></section>;

  const previousForRoom = previous?.currentId === currentId ? previous : null;
  const previousStop = previousForRoom?.kind === 'room'
    ? <div className={styles.previousStop}><RoomSignalCard key={previousForRoom.room.id} room={previousForRoom.room} variant="previous" /></div>
    : null;
  const previousError = previousForRoom?.kind === 'error'
    ? <p className={styles.previousStatus}>Previous location is unavailable. <button type="button" className={styles.retry} onClick={() => setPreviousRetry((value) => value + 1)}>Try again</button></p>
    : null;

  if (state.kind === 'start') return (
    <section className={`observatory-location ${styles.location}`} aria-label="Current location">
      <div className={`${styles.locationGrid} ${previousStop ? styles.hasPrevious : ''}`}>
      <div className={styles.notice}>
        <div className={styles.noticeTop}><span className={styles.eyebrow}>Your next destination awaits</span><OrbitalIllustration small /></div>
        <h2>A whole universe.<br />Where to?</h2>
        <p>You&apos;re on the start map. Explore a universe, or build a world of your own.</p>
        <Link href="/admin/spaces" className={styles.detailsLink}>Explore universes <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </div>
      {previousStop}
      </div>
      {previousError}
      {state.historyUnavailable && <p className={styles.previousStatus}>Previous location is unavailable. <button type="button" className={styles.retry} onClick={() => setRetry((value) => value + 1)}>Try again</button></p>}
    </section>
  );

  if (state.kind === 'unknown') return (
    <section className={`observatory-location ${styles.location}`} aria-label="Current location">
      <div className={styles.notice}>
        <span className={styles.eyebrow}>Current location</span>
        <h2>{state.failed ? 'Your room is out of reach' : 'Somewhere new'}</h2>
        <p>{state.failed ? 'Orbit couldn’t load the room details. Your place in the game is unchanged.' : 'You’re in a room that Orbit doesn’t know yet.'}</p>
        <p className={styles.roomUri}>{state.playUri}</p>
        {state.failed && <button type="button" className={styles.retry} onClick={() => setRetry((value) => value + 1)}>Try again</button>}
      </div>
    </section>
  );

  return (
    <section className={`observatory-location ${styles.location}`} aria-label="Your location trail">
      <div className={`${styles.locationGrid} ${previousForRoom?.kind === 'room' ? styles.hasPrevious : ''}`}>
        <RoomSignalCard key={state.room.id} room={state.room} variant="current" />
        {previousStop}
      </div>
      {previousError}
    </section>
  );
}
