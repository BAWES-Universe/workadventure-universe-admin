'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DESTINATIONS } from '../../config/navigation';
import { rootOf } from './root-of';
import { useOrbitFrame } from '../../orbit-frame-context';

/**
 * Home, Places, You and Menu, always within a thumb's reach on a narrow frame. The active item's pill slides to
 * where you go. Hidden on the wide layout, where the sidebar takes over.
 */
export function BottomNav() {
  const pathname = usePathname();
  const { menuOpen, setMenuOpen } = useOrbitFrame();
  const root = rootOf(pathname);
  const activeIndex = menuOpen ? DESTINATIONS.length : DESTINATIONS.findIndex((item) => item.href === root);
  const slots = DESTINATIONS.length + 1;

  return (
    <nav
      aria-label="Orbit"
      className="orbit-glass fixed inset-x-0 bottom-0 z-40 border-t border-border/60 lg:hidden"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <div className="relative mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))`, height: 'var(--bottombar-height)' }}>
        {activeIndex >= 0 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-2 left-0 rounded-2xl bg-accent transition-transform"
            style={{
              width: `calc(100% / ${slots})`,
              transform: `translateX(${activeIndex * 100}%)`,
              transitionDuration: 'var(--duration-slow)',
              transitionTimingFunction: 'var(--ease-out)',
            }}
          />
        )}
        {DESTINATIONS.map((item) => {
          const Icon = item.icon;
          const active = !menuOpen && item.href === root;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
              className={cn(
                'orbit-press relative z-10 flex flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-medium transition-colors',
                active ? 'text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className={cn('h-[22px] w-[22px] transition-transform', active && 'scale-110')} strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-expanded={menuOpen}
          aria-controls="orbit-menu"
          className={cn(
            'orbit-press relative z-10 flex flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-medium transition-colors',
            menuOpen ? 'text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Menu className="h-[22px] w-[22px]" strokeWidth={menuOpen ? 2.4 : 2} aria-hidden="true" />
          Menu
        </button>
      </div>
    </nav>
  );
}
