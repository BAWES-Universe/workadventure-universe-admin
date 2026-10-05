'use client';

import { useSyncExternalStore } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { ORBIT_REFRESH_EVENT } from '../orbit-bridge';

/** Sent when something that waits for your answer was answered or dismissed here, so the count follows at once. */
export const ATTENTION_CHANGED_EVENT = 'orbit:attention-changed';

export function announceAttentionChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
}

/** One count shared by the rail and the bottom bar (both are mounted), fetched once per change. */
let current = 0;
let latest = 0;
const listeners = new Set<() => void>();

function load() {
  const request = ++latest;
  authenticatedFetch('/api/me/attention')
    .then(async (response) => (response.ok ? Number((await response.json()).count) || 0 : 0))
    .catch(() => current)
    .then((next) => {
      if (request !== latest || next === current) return;
      current = next;
      listeners.forEach((listener) => listener());
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener(ORBIT_REFRESH_EVENT, load);
    window.addEventListener(ATTENTION_CHANGED_EVENT, load);
    load();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener(ORBIT_REFRESH_EVENT, load);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, load);
    }
  };
}

/**
 * How many things in Orbit wait for your answer (GET /api/me/attention): invitations for now. Unlike chat's unread
 * count it doesn't clear when you look, only when you answer or dismiss. 0 while loading or signed out.
 */
export function useAttentionCount(): number {
  return useSyncExternalStore(subscribe, () => current, () => 0);
}

/** The count as the game's chat badge draws it: the Universe gradient, top-left of its button, with an ink ring. */
export function AttentionBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`pointer-events-none absolute z-10 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold leading-none tabular-nums text-white ${className ?? ''}`}
      style={{
        backgroundImage: 'var(--brand-gradient)',
        boxShadow: '0 0 0 2px hsl(var(--background)), 0 2px 8px -2px rgba(134, 41, 252, 0.8)',
      }}
      data-testid="attention-badge"
    >
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{count === 1 ? '1 thing waits' : `${count} things wait`} for your answer</span>
    </span>
  );
}
