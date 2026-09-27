'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DESTINATIONS } from '../../config/navigation';
import { rootOf } from './root-of';
import { useOrbitFrame } from '../../orbit-frame-context';

/** The same three destinations: thumb dock on touch, top strip in a compact desktop frame. */
export function BottomNav() {
  const pathname = usePathname();
  const { setMenuOpen } = useOrbitFrame();
  const root = rootOf(pathname);
  return (
    <nav aria-label="Orbit" className="observatory-dock">
      {DESTINATIONS.map((item) => {
        const Icon = item.icon;
        const active = item.href === root;
        return (
          <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} onClick={() => setMenuOpen(false)} className="observatory-destination">
            <span className="observatory-nav-orbit"><Icon size={19} strokeWidth={active ? 2 : 1.6} aria-hidden="true" /></span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
