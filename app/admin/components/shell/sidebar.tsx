'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass, Layers, Star, Wrench } from 'lucide-react';
import { DESTINATIONS, type NavUser } from '../../config/navigation';
import { Avatar } from './account-panel';
import { OrbitMark } from './orbit-mark';
import { rootOf } from './root-of';
import { useOrbitFrame } from '../../orbit-frame-context';

export function Sidebar({ user }: { user: NavUser }) {
  const root = rootOf(usePathname());
  const { setMenuOpen } = useOrbitFrame();
  return (
    <aside className="observatory-rail" aria-label="Orbit sections">
      <Link href="/admin" className="observatory-rail-brand" aria-label="Orbit home"><OrbitMark className="size-9" /><span>ORBIT</span></Link>
      <nav aria-label="Destinations">
        {DESTINATIONS.map(item => {
          const Icon = item.icon;
          return <Link key={item.href} href={item.href} aria-current={root === item.href ? 'page' : undefined}><Icon size={21} aria-hidden="true" /><span>{item.label}</span></Link>;
        })}
      </nav>
      <span className="observatory-rail-divider" />
      <nav aria-label="Shortcuts">
        <Link href="/admin/stars"><Star size={20} aria-hidden="true" /><span>Stars</span></Link>
        <Link href="/admin/discover/rooms"><Compass size={20} aria-hidden="true" /><span>Explore</span></Link>
        <Link href="/admin/templates"><Layers size={20} aria-hidden="true" /><span>Templates</span></Link>
        <button onClick={() => setMenuOpen(true)} type="button" aria-label="Browse all tools"><Wrench size={20} aria-hidden="true" /><span>Tools</span></button>
      </nav>
      <Link href="/admin/you" className="observatory-rail-account" aria-label="Your account"><Avatar user={user} className="size-10" /></Link>
    </aside>
  );
}
