'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Search, X } from 'lucide-react';
import { DESTINATIONS, getNavItems, getNavSections, isNavItemActive, type NavUser } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';
import { MenuSearchResults } from './menu-search-results';
import type { MenuSearchScope } from '@/lib/menu-search';

const scopes: { key: MenuSearchScope; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'people', label: 'People' },
  { key: 'places', label: 'Places' },
  { key: 'tools', label: 'Sections & tools' },
];

/** The existing menu now searches real directories too; it never adds a persistent search bar. */
export function MenuSheet({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const { section: root, menuOpen, setMenuOpen } = useOrbitFrame();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MenuSearchScope>('all');
  const input = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const items = getNavItems(user);
  const normalized = query.trim().toLocaleLowerCase();
  const showTools = scope === 'all' || scope === 'tools';
  const roots = DESTINATIONS.filter((item) => `${item.label} ${item.label === 'You' ? 'profile' : ''}`.toLocaleLowerCase().includes(normalized));
  const sections = showTools
    ? getNavSections(user)
        .map((section) => ({
          ...section,
          items: section.items.filter(
            (item) =>
              !DESTINATIONS.some((destination) => destination.href === item.href) &&
              `${item.label} ${section.label}`.toLocaleLowerCase().includes(normalized),
          ),
        }))
        .filter((section) => section.items.length > 0)
    : [];

  const close = () => {
    setMenuOpen(false);
    setQuery('');
    setScope('all');
  };
  const choose = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    close();
  };

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname, setMenuOpen]);

  function moveFocus(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const results = Array.from(content.current?.querySelectorAll<HTMLAnchorElement>('[data-menu-result]') ?? []);
    const current = results.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'Enter' && document.activeElement === input.current && results[0]) {
      event.preventDefault();
      results[0].click();
    } else if (event.key === 'ArrowDown' && (current >= 0 || document.activeElement === input.current)) {
      event.preventDefault();
      results[Math.min(current + 1, results.length - 1)]?.focus();
    } else if (event.key === 'ArrowUp' && current >= 0) {
      event.preventDefault();
      if (current === 0) input.current?.focus();
      else results[current - 1].focus();
    }
  }

  return (
    <DialogPrimitive.Root open={menuOpen} onOpenChange={(open) => (open ? setMenuOpen(true) : close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="orbit-menu-overlay" />
        <DialogPrimitive.Content
          id="orbit-menu"
          className="orbit-menu"
          ref={content}
          onKeyDown={moveFocus}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            // Touch users see the menu first, without an unsolicited keyboard covering its destinations.
            if (window.matchMedia?.('(pointer: coarse)').matches) content.current?.focus();
            else input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
          }}
        >
          <div className="orbit-menu-heading">
            <DialogPrimitive.Title asChild>
              <h2>Menu & search</h2>
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="orbit-icon-button" aria-label="Close the menu">
              <X size={20} aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="orbit-menu-description">
            People, places and every section. All in one place.
          </DialogPrimitive.Description>
          <label className="orbit-menu-search">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Find people, places or tools</span>
            <input
              ref={input}
              type="search"
              value={query}
              maxLength={120}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find people, places or tools"
            />
          </label>
          <div className="orbit-menu-scopes" role="group" aria-label="Search scope">
            {scopes.map((item) => (
              <button key={item.key} type="button" aria-pressed={scope === item.key} onClick={() => setScope(item.key)}>
                {item.label}
              </button>
            ))}
          </div>
          {showTools && roots.length > 0 && (
            <nav className="orbit-menu-roots" aria-label="Main destinations">
              {roots.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} onClick={choose} data-menu-result aria-current={item.href === root ? 'page' : undefined}>
                    <Icon size={18} aria-hidden="true" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          )}
          {menuOpen && (normalized || !showTools) && <MenuSearchResults query={query.trim()} scope={scope} choose={choose} />}
          <div className="orbit-menu-sections">
            {showTools && sections.length === 0 && roots.length === 0 && (
              <p className="orbit-no-results" role="status">
                No sections or tools match “{query}”.
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
                        <Link
                          href={item.href}
                          onClick={choose}
                          data-menu-result
                          aria-current={isNavItemActive(item.href, pathname, items) ? 'page' : undefined}
                        >
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
          <p className="orbit-menu-hint">↑ ↓ Browse · Enter Open · Esc Close</p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
