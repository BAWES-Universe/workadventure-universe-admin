'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Search, X, Maximize2, Minimize2 } from 'lucide-react';
import { DESTINATIONS, getNavItems, getNavSections, isNavItemActive, type NavUser } from '../../config/navigation';
import { useOrbitFrame } from '../../orbit-frame-context';
import { AccountPanel } from './account-panel';

/** A navigable atlas of existing destinations; permissions are still sourced from the original navigation registry. */
export function MenuSheet({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const { menuOpen, setMenuOpen, inFrame, canRequestView, view, requestView } = useOrbitFrame();
  const [query, setQuery] = useState('');
  const items = getNavItems(user);
  const normalized = query.trim().toLocaleLowerCase();
  const sections = getNavSections(user).map(section => ({
    ...section,
    items: section.items.filter(item => `${item.label} ${section.label}`.toLocaleLowerCase().includes(normalized)),
  })).filter(section => section.items.length > 0);

  useEffect(() => { setMenuOpen(false); }, [pathname, setMenuOpen]);

  return (
    <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="observatory-menu-overlay" />
        <DialogPrimitive.Content id="orbit-menu" className="observatory-menu" onCloseAutoFocus={(event) => {
          event.preventDefault();
          setQuery('');
          document.querySelector<HTMLElement>('.observatory-menu-trigger')?.focus();
        }}>
          <div className="observatory-menu-heading">
            <div><p className="observatory-eyebrow">YOUR UNIVERSE ATLAS</p><DialogPrimitive.Title>Where to?</DialogPrimitive.Title></div>
            <DialogPrimitive.Close className="observatory-icon-button" aria-label="Close menu"><X size={20} aria-hidden="true" /></DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="observatory-menu-description">Every space. Every tool. One Orbit.</DialogPrimitive.Description>
          <label className="observatory-menu-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Find a destination or tool</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a destination or tool…" /></label>
          {!normalized && <nav className="observatory-menu-roots" aria-label="Main destinations">{DESTINATIONS.map(item => {
            const Icon = item.icon;
            return <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)}><Icon size={18} aria-hidden="true" />{item.label}</Link>;
          })}</nav>}
          <div className="observatory-menu-sections">
            {sections.length === 0 && <p className="observatory-no-results" role="status">No destinations match “{query}”. Try a tool or space name.</p>}
            {sections.map(section => <section key={section.key} aria-label={section.label}>
              <h3 className="observatory-eyebrow">{section.label}</h3>
              <ul>{section.items.map(item => {
                const Icon = item.icon;
                return <li key={item.href}><Link href={item.href} aria-current={isNavItemActive(item.href, pathname, items) ? 'page' : undefined} onClick={() => setMenuOpen(false)}><span className="observatory-tool-icon"><Icon size={18} aria-hidden="true" /></span><span>{item.label}</span><ArrowUpRight className="observatory-tool-arrow" size={15} aria-hidden="true" /></Link></li>;
              })}</ul>
            </section>)}
          </div>
          {inFrame && canRequestView && <button className="observatory-view-action" type="button" data-testid="orbit-view-toggle" aria-label={view === 'full' ? 'Back to the compact view' : 'Open in full screen'} onClick={() => { requestView(view === 'full' ? 'compact' : 'full'); setMenuOpen(false); }}>
            {view === 'full' ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}<span>{view === 'full' ? 'Return to companion view' : 'Give Orbit the whole screen'}</span>
          </button>}
          <div className="observatory-menu-account"><AccountPanel user={user} /></div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
