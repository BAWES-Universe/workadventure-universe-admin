'use client';

import Link from 'next/link';
import { ArrowUpRight, Compass, Globe2, DoorOpen, Users } from 'lucide-react';
import HerePanel from './components/here-panel';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import RecentlyVisited from './components/recently-visited';
import YourPlaces from './components/your-places';

const EXPLORE = [
  { href: '/admin/discover/universes', label: 'Universes', detail: 'Find your constellation', icon: Compass },
  { href: '/admin/discover/worlds', label: 'Worlds', detail: 'Follow your curiosity', icon: Globe2 },
  { href: '/admin/discover/rooms', label: 'Rooms', detail: 'Somewhere to belong', icon: DoorOpen },
  { href: '/admin/users', label: 'People', detail: 'Meet your fellow travellers', icon: Users },
];

/** Home follows a journey: here, before, yours, then beyond. */
export default function AdminDashboard() {
  return (
    <div className="observatory-home">
      <header className="observatory-home-heading">
        <div><p className="observatory-eyebrow">A LITTLE CLOSER TO EVERYTHING</p><h1>Your orbit<span aria-hidden="true">.</span></h1></div>
        <span className="observatory-coordinate" aria-hidden="true">↗<span>HERE / NOW</span></span>
      </header>
      <div className="observatory-home-columns">
        <div className="observatory-home-primary"><HerePanel /><PendingInvitationsAlert /><RecentlyVisited /></div>
        <div className="observatory-home-secondary">
          <YourPlaces />
          <section className="observatory-explore" data-testid="explore">
            <div className="observatory-section-heading"><span className="observatory-eyebrow">BEYOND YOUR ORBIT</span><span aria-hidden="true">✦</span></div>
            <h2>There’s more out there.</h2>
            <p>A room, a world, a whole new Universe.</p>
            <nav aria-label="Explore the Universe">{EXPLORE.map(entry => {
              const Icon = entry.icon;
              return <Link key={entry.href} href={entry.href}><Icon size={19} aria-hidden="true" /><span><strong>{entry.label}</strong><small>{entry.detail}</small></span><ArrowUpRight size={17} aria-hidden="true" /></Link>;
            })}</nav>
          </section>
          <p className="observatory-footer-note"><span aria-hidden="true">✳</span> A universe is better with you in it.</p>
        </div>
      </div>
    </div>
  );
}
