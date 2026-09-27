'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { DESTINATIONS } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';
import { rootOf } from './root-of';

/**
 * You, Orbit and Space on the three root pages, within a thumb's reach on a phone and as a strip under the bar on
 * a desktop panel. Inner pages hide it: Back in the bar is the one way out, so it is clear where you are. The Menu
 * is at the top-left, beside the game's own buttons. Hidden on the wide layout, where the sidebar takes over.
 */
export function BottomNav() {
  const pathname = usePathname();
  const { route } = useOrbitFrame();
  const root = rootOf(pathname);
  if (route.parent !== null) return null;
  const activeIndex = DESTINATIONS.findIndex((item) => item.href === root);
  const slots = DESTINATIONS.length;

  return (
    <nav
      aria-label="Orbit"
      className="orbit-glass orbit-dock fixed inset-x-0 bottom-0 z-40 border-t border-border/60 lg:hidden"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <div className="relative mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))`, height: 'var(--bottombar-height)' }}>
        {activeIndex >= 0 && (
          <span
            aria-hidden="true"
            className="orbit-dock-pill pointer-events-none absolute inset-y-2 left-0 rounded-2xl transition-transform"
            style={{
              backgroundImage: 'var(--brand-gradient)',
              width: `calc(100% / ${slots})`,
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
                'orbit-press relative z-10 flex flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-medium transition-colors',
                active ? 'text-white' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className={cn('h-[22px] w-[22px] transition-transform', active && 'scale-110')} strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
