'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { DESTINATIONS, getNavItems, getNavSections, isNavItemActive, type NavUser } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';
import { AccountPanel } from './account-panel';
import { rootOf } from './root-of';

/**
 * Everything Orbit has, one tap from the bottom bar: the three destinations, then Personalize, Discover, Tools and
 * (for super admins) Admin, and the account at the end. A sheet that rises from the bottom, dismissed by a tap
 * outside, Escape, or Back.
 */
export function MenuSheet({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const { menuOpen, setMenuOpen } = useOrbitFrame();
  const root = rootOf(pathname);
  const items = getNavItems(user);
  const sections = getNavSections(user);

  // Going somewhere closes the menu.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname, setMenuOpen]);

  return (
    <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          id="orbit-menu"
          aria-describedby={undefined}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border-t border-border/60 bg-popover shadow-2xl outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
          )}
          style={{ paddingBottom: 'calc(1rem + var(--safe-bottom))' }}
        >
          <div className="sticky top-0 z-10 flex justify-center bg-popover pb-2 pt-3">
            <span aria-hidden="true" className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
          </div>
          <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>

          <div className="space-y-6 px-4 pt-1">
            <div className="grid grid-cols-3 gap-2">
              {DESTINATIONS.map((item) => {
                const Icon = item.icon;
                const active = item.href === root;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'orbit-press flex flex-col items-center justify-center gap-1.5 rounded-2xl py-4 text-sm font-medium transition-colors',
                      active ? 'bg-accent text-accent-foreground' : 'bg-muted/60 text-foreground hover:bg-muted',
                    )}
                  >
                    <Icon className="h-6 w-6" strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
                    {item.label}
                  </Link>
                );
              })}
            </div>

            {sections.map((section) => (
              <section key={section.key} aria-label={section.label}>
                <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                  {section.label}
                </p>
                <ul className="overflow-hidden rounded-2xl border border-border/60 bg-card">
                  {section.items.map((item, index) => {
                    const Icon = item.icon;
                    const active = isNavItemActive(item.href, pathname, items);
                    return (
                      <li key={item.href} className={cn(index > 0 && 'border-t border-border/50')}>
                        <Link
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'flex h-12 items-center gap-3 px-4 text-[15px] transition-colors active:bg-muted',
                            active ? 'font-medium text-primary' : 'text-foreground',
                          )}
                        >
                          <Icon className={cn('h-5 w-5', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            <div className="rounded-2xl border border-border/60 bg-card p-4">
              <AccountPanel user={user} />
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
