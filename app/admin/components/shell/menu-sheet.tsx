'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import Link from 'next/link';
import { X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { getNavItems, getNavSections, isNavItemActive, type NavUser } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';
import { AccountPanel } from './account-panel';

/**
 * Everything Orbit has, from the Menu button at the top-left: Tools, Personalize, Discover and (for super admins)
 * Admin, and the account at the end. A drawer that slides in from the left, under the button that opened it;
 * dismissed by a tap outside, Escape, or going somewhere. Home, Spaces and You stay on the bottom bar.
 */
export function MenuSheet({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const { menuOpen, setMenuOpen } = useOrbitFrame();
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
            'fixed inset-y-0 left-0 z-50 w-[min(85%,20rem)] overflow-y-auto border-r border-border/60 bg-popover shadow-2xl outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
          )}
          style={{ paddingBottom: 'calc(1rem + var(--safe-bottom))' }}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between bg-popover px-4 pb-2 pt-3">
            <DialogPrimitive.Title className="text-[15px] font-semibold">Menu</DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="orbit-press inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close the menu"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          <div className="space-y-6 px-4 pt-1">
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
