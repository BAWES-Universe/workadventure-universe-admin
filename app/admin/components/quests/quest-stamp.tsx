import { cn } from '@/lib/utils';
import type { QuestPath } from '@/lib/quests/model';
import styles from './quests.module.css';

/**
 * A quest's stamp, as the game draws it: a lavender ring, a gold glyph (butterfly for First Hello, compass for
 * Explorer, cube for Builder), tilted like an ink stamp. Decorative: its name is always written beside it.
 */
export function QuestStamp({ path, size = 'md', muted, className }: { path: QuestPath; size?: 'sm' | 'md' | 'lg'; muted?: boolean; className?: string }) {
  return (
    <svg
      className={cn(styles.stamp, styles[`stamp-${size}`], muted && styles.stampMuted, className)}
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      data-stamp={path}
    >
      <g className={styles.stampRing}>
        <path
          d="M60 5 70 11 82 10 89 20 100 24 102 37 111 46 108 59 114 70 105 80 103 93 90 97 82 108 70 107 59 114 48 108 35 109 28 99 16 95 14 82 5 73 9 60 3 48 12 39 14 26 27 22 35 11 48 12Z"
          fill="currentColor"
          fillOpacity=".1"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <circle cx="59" cy="59" r="42" stroke="currentColor" strokeDasharray="1 4" />
        <circle cx="59" cy="59" r="36" stroke="currentColor" strokeOpacity=".45" />
      </g>
      <g className={styles.stampGlyph}>
        {path === 'meet' && (
          <>
            <path
              d="M59 62C47 37 31 41 37 55c3 7 14 9 22 7ZM59 62c12-25 28-21 22-7-3 7-14 9-22 7ZM59 62C43 61 38 77 49 77c7 0 8-9 10-15ZM59 62c16-1 21 15 10 15-7 0-8-9-10-15Z"
              fill="currentColor"
            />
            <path d="m55 44 4 8 4-8M59 53v25" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </>
        )}
        {path === 'explore' && (
          <>
            <path d="m72 43-6 23-23 9 10-25 19-7Z" stroke="currentColor" strokeWidth="2.5" />
            <path d="m72 43-13 16-16 16 10-25 19-7Z" fill="currentColor" fillOpacity=".7" />
            <circle cx="59" cy="59" r="3" fill="currentColor" />
            <path d="M59 28v5M59 85v5M28 59h5M85 59h5" stroke="currentColor" strokeWidth="2" />
          </>
        )}
        {path === 'build' && (
          <>
            <path d="m59 36 23 13v25L59 87 37 74V49l22-13Z" stroke="currentColor" strokeWidth="2.5" />
            <path d="m37 49 22 13 23-13M59 62v25M48 43l22 13v13" stroke="currentColor" strokeWidth="2.5" />
          </>
        )}
        <path d="m24 16 1.8 4.2L30 22l-4.2 1.8L24 28l-1.8-4.2L18 22l4.2-1.8L24 16Z" fill="currentColor" />
      </g>
    </svg>
  );
}
