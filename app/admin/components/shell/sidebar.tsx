'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DESTINATIONS, getNavItems, getNavSections, isNavItemActive, type NavUser } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';
import { OrbitWordmark } from './orbit-mark';
import { ShortcutHint } from './shortcut-hint';
import { rootOf } from './root-of';

/**
 * The wide layout's left column: everything the menu holds, always visible. Shown from the `lg` breakpoint, which
 * inside the game's frame means the full-screen view on a desktop.
 */
export function Sidebar({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const root = rootOf(pathname);
  const items = getNavItems(user);
  const sections = getNavSections(user);
  // A page with its own entry (Bots, AI Usage…) lights that entry, not the destination it sits under.
  const sectionActive = sections.some((section) => section.items.some((item) => isNavItemActive(item.href, pathname, items)));
  const navRef = useRef<HTMLElement>(null);
  const { setMenuOpen } = useOrbitFrame();

  // The lit entry is always in sight, even far down the list (the Admin tools).
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [pathname]);

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border/60 bg-sunken/70 lg:flex"
      style={{ width: 'var(--sidebar-width)' }}
      aria-label="Orbit sections"
    >
      <div className="flex h-14 items-center px-5">
        <Link href="/admin" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <OrbitWordmark />
        </Link>
      </div>
      <div className="px-3 pb-3">
        {/* The Orbit Menu's search, and where its shortcut is learnt on the wide layout. */}
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-keyshortcuts="Control+K Meta+K"
          className="orbit-press flex h-10 w-full items-center gap-2 rounded-full border border-foreground/15 pl-3 pr-2 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          data-testid="sidebar-find"
        >
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">Find anything</span>
          <ShortcutHint />
        </button>
      </div>
      <nav ref={navRef} className="orbit-scroll-fade min-h-0 flex-1 space-y-6 overflow-y-auto px-3 pb-8 pt-1">
        <ul className="space-y-0.5">
          {DESTINATIONS.map((item) => {
            const Icon = item.icon;
            const active = item.href === root && !sectionActive;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'orbit-press flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors',
                    active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        {sections.map((section) => (
          <div key={section.key}>
            <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = isNavItemActive(item.href, pathname, items);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'orbit-press flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] transition-colors',
                        active ? 'bg-accent/70 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
