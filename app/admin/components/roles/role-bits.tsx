'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A role's colour as a round dot with a quiet ring, the way the Roles list and the role page name a role. */
export function RoleDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-grid h-7 w-7 shrink-0 place-items-center rounded-full border border-foreground/20 bg-background/60', className)}
    >
      <i className="h-3.5 w-3.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

/** A group of rows with a title above it, the way the role pages lay out their lists and forms. */
export function Group({ title, count, children, className }: { title: string; count?: number; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-3', className)} aria-label={title}>
      <h2 className="orbit-display flex items-baseline gap-2 text-lg font-bold">
        {title}
        {typeof count === 'number' && <span className="text-sm font-medium text-muted-foreground">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

/** A card of the role pages: quiet fill, 16px corners. */
export function Panel({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'danger' }) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-4',
        tone === 'danger' ? 'border-[rgba(248,113,113,.35)] bg-[rgba(248,113,113,.06)]' : 'border-foreground/[.08] bg-foreground/[.04]',
        className,
      )}
    >
      {children}
    </div>
  );
}
