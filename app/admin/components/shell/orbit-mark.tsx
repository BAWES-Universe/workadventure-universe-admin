'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * Orbit's mark: a planet with a ring, drawn in the brand gradient. `animated` sets the ring's moon in motion for
 * loading moments; the still version is the wordmark's companion in the shell.
 */
export function OrbitMark({ className, animated = false }: { className?: string; animated?: boolean }) {
  // Each mark its own gradients: one inside a hidden sidebar would otherwise leave the visible ones unpainted.
  const id = useId();
  const fill = `orbit-mark-fill-${id}`;
  const ring = `orbit-mark-ring-${id}`;
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      className={cn('shrink-0', className)}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand-purple)" />
          <stop offset="100%" stopColor="var(--brand-blue)" />
        </linearGradient>
        <linearGradient id={ring} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--brand-violet)" />
          <stop offset="100%" stopColor="var(--brand-gold)" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="11" fill={`url(#${fill})`} />
      <ellipse
        cx="24"
        cy="24"
        rx="20"
        ry="7.5"
        fill="none"
        stroke={`url(#${ring})`}
        strokeWidth="2.25"
        transform="rotate(-18 24 24)"
        opacity="0.95"
      />
      <g
        style={
          animated
            ? { transformOrigin: '24px 24px', animation: 'orbit-spin 2.4s linear infinite' }
            : { transformOrigin: '24px 24px' }
        }
      >
        <circle cx="41" cy="18.5" r="3" fill="var(--brand-gold)" />
      </g>
    </svg>
  );
}

/** The mark and the name together. */
export function OrbitWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <OrbitMark className="h-6 w-6" />
      <span className="text-[17px] font-semibold tracking-tight">Orbit</span>
    </span>
  );
}
