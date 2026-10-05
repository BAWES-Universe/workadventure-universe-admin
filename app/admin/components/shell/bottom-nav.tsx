'use client';

import type { CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { DESTINATIONS } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';
import { rootOf } from './root-of';
import { AttentionBadge, useAttentionCount } from './attention-badge';

/**
 * You, Orbit and Space on the three root pages, within a thumb's reach on a phone and as a strip under the bar on
 * a desktop panel. Inner pages hide it: Back in the bar is the one way out, so it is clear where you are. The Menu
 * is at the top-left, beside the game's own buttons. Hidden on the wide layout, where the sidebar takes over.
 */
export function BottomNav() {
  const pathname = usePathname();
  const { route } = useOrbitFrame();
  const root = rootOf(pathname);
  const attention = useAttentionCount();
  if (route.parent !== null) return null;
  const activeIndex = DESTINATIONS.findIndex((item) => item.href === root);
  const slots = DESTINATIONS.length;

  return (
    <nav aria-label="Orbit" className="orbit-dock fixed z-40 lg:hidden">
      <div
        className="orbit-dock-track relative mx-auto grid max-w-lg rounded-full p-2"
        style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))`, '--dock-slots': slots } as CSSProperties}
      >
        {activeIndex >= 0 && (
          <span
            aria-hidden="true"
            className="orbit-dock-pill pointer-events-none absolute left-2 rounded-full transition-transform"
            style={{
              transform: `translateX(${activeIndex * 100}%)`,
              transitionDuration: 'var(--duration-slow)',
              transitionTimingFunction: 'var(--ease-out)',
            }}
          />
        )}
        {DESTINATIONS.map((item) => {
          const Icon = item.icon;
          const active = item.href === root;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'orbit-press relative z-10 flex h-12 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold transition-colors',
                active ? 'text-white' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.href === '/admin/you' && <AttentionBadge count={attention} className="left-[calc(50%-2.4rem)] top-1" />}
              <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
