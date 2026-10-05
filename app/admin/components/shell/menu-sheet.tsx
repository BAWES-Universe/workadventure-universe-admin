'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Search, X } from 'lucide-react';
import { DESTINATIONS, getNavItems, getNavSections, isNavItemActive, type NavUser } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';

/**
 * Everything Orbit has, from the Orbit Menu button at the top-left or Ctrl/Cmd+K: You, Orbit and Space, then every tool, searchable.
 * Nothing else: the account, theme and sign-out live on You. Dismissed by a tap outside, Escape, or going somewhere.
 */
export function MenuSheet({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const { section: root, menuOpen, setMenuOpen } = useOrbitFrame();
  const [query, setQuery] = useState('');
  const items = getNavItems(user);
  const normalized = query.trim().toLocaleLowerCase();
  const sections = getNavSections(user)
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => `${item.label} ${section.label}`.toLocaleLowerCase().includes(normalized)),
    }))
    .filter((section) => section.items.length > 0);

  // Choosing a place closes the menu at once, even the page already open (the address doesn't change then).
  // A click that opens a new tab leaves it open.
  const choose = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    setMenuOpen(false);
    setQuery('');
  };

  // Going somewhere closes the menu.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname, setMenuOpen]);

  return (
    <DialogPrimitive.Root
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (!open) setQuery('');
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="orbit-menu-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content id="orbit-menu" className="orbit-menu">
          <div className="orbit-menu-heading">
            <div>
              <p className="orbit-eyebrow">Orbit Menu</p>
              <DialogPrimitive.Title asChild>
                <h2>Where to?</h2>
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Close className="orbit-icon-button" aria-label="Close the menu">
              <X size={20} aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="orbit-menu-description">Every section and tool.</DialogPrimitive.Description>
          <label className="orbit-menu-search">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Find a section or tool</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a section or tool" />
          </label>
          {!normalized && (
            <nav className="orbit-menu-roots" aria-label="Main destinations">
              {DESTINATIONS.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} onClick={choose} aria-current={item.href === root ? 'page' : undefined}>
                    <Icon size={18} aria-hidden="true" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          )}
          <div className="orbit-menu-sections">
            {sections.length === 0 && (
              <p className="orbit-no-results" role="status">
                Nothing matches “{query}”. Try the name of a section or tool.
              </p>
            )}
            {sections.map((section) => (
              <section key={section.key} aria-label={section.label}>
                <h3 className="orbit-eyebrow">{section.label}</h3>
                <ul>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link href={item.href} onClick={choose} aria-current={isNavItemActive(item.href, pathname, items) ? 'page' : undefined}>
                          <span className="orbit-tool-icon">
                            <Icon size={18} aria-hidden="true" />
                          </span>
                          <span>{item.label}</span>
                          <ArrowUpRight className="orbit-tool-arrow" size={15} aria-hidden="true" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
