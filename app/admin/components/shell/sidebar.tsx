'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DESTINATIONS } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';
import { OrbitMark } from './orbit-mark';
import { ShortcutHint } from './shortcut-hint';
import { rootOf } from './root-of';
import { AttentionBadge, useAttentionCount } from './attention-badge';

/**
 * The wide layout's rail: You, Orbit and Space, and the Orbit Menu at the foot for every other page and tool. Shown
 * from the `lg` breakpoint, which inside the game's frame means the full-screen view on a desktop; the page keeps the
 * rest of the width.
 */
export function Sidebar() {
  const pathname = usePathname();
  const root = rootOf(pathname);
  const { menuOpen, setMenuOpen } = useOrbitFrame();
  const attention = useAttentionCount();

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 hidden flex-col items-center gap-2 border-r border-border/60 bg-sunken/70 py-3 lg:flex"
      style={{ width: 'var(--sidebar-width)' }}
      aria-label="Orbit"
    >
      <Link
        href="/admin"
        aria-label="Orbit home"
        className="mb-3 grid h-12 w-12 place-items-center rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <OrbitMark className="h-8 w-8" />
      </Link>
      <nav aria-label="Orbit sections">
        <ul className="flex flex-col items-center gap-1.5">
          {DESTINATIONS.map((item) => {
            const Icon = item.icon;
            const active = item.href === root;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'orbit-press relative flex h-[62px] w-[66px] flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-semibold transition-colors',
                    active
                      ? 'text-white shadow-[0_6px_18px_-6px_rgb(134_41_252_/_.9)]'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                  style={active ? { backgroundImage: 'var(--brand-gradient)' } : undefined}
                >
                  {item.href === '/admin/you' && <AttentionBadge count={attention} className="left-1.5 top-1" />}
                  <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex-1" />
      {/* Every other page and tool, admin ones too, is one step away in the menu; its shortcut sits under it. */}
      <button
        type="button"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-expanded={menuOpen}
        aria-controls="orbit-menu"
        aria-keyshortcuts="Control+K Meta+K"
        className="orbit-press flex h-[62px] w-[66px] flex-col items-center justify-center gap-1 rounded-2xl border border-foreground/15 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        data-testid="sidebar-find"
      >
        <Search className="h-5 w-5" aria-hidden="true" />
        Menu
      </button>
      <ShortcutHint className="orbit-keys-always" />
    </aside>
  );
}
