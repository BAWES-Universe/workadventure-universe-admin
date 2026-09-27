'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowUpRight, DoorOpen, Earth, Sparkles, Users } from 'lucide-react';
import { useAdminBootstrap } from './admin-bootstrap-context';
import HerePanel from './components/here-panel';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import RecentlyVisited from './components/recently-visited';

/** Orbit follows a journey: here, before, your trail, then everything beyond it. What's yours is on You. */
export default function AdminDashboard() {
  const { stats } = useAdminBootstrap();
  const explore = [
    { href: '/admin/discover/universes', label: 'Universes', description: 'Public universes you can explore', count: stats.universes, icon: Sparkles, kind: 'universe' },
    { href: '/admin/discover/worlds', label: 'Worlds', description: 'Worlds across universes', count: stats.worlds, icon: Earth, kind: 'world' },
    { href: '/admin/discover/rooms', label: 'Rooms', description: 'Individual spaces & maps', count: stats.rooms, icon: DoorOpen, kind: 'room' },
    { href: '/admin/users', label: 'Users', description: 'People exploring the Universe', count: stats.users, icon: Users, kind: 'star' },
  ];
  // The rooms under Where you are (here, and just before), so Recently visited doesn't repeat them.
  const [shownRoomIds, setShownRoomIds] = useState<string[]>([]);

  return (
    <div className="space-y-7">
      <h1 className="sr-only">Orbit</h1>

      <div className="orbit-home-columns">
        <div className="orbit-home-primary">
          <PendingInvitationsAlert />
          <HerePanel onShown={setShownRoomIds} />
          <RecentlyVisited excludeRoomIds={shownRoomIds} />
        </div>
        <div className="orbit-home-secondary">
          <section className="orbit-explore" data-testid="explore">
            <p className="orbit-eyebrow">Beyond your orbit</p>
            <h2>Discover</h2>
            <p>Explore universes, worlds, rooms, and users across the Universe.</p>
            <nav aria-label="Discover">
              {explore.map((entry) => {
                const Icon = entry.icon;
                return (
                  <Link key={entry.href} href={entry.href} className="orbit-kind-wash rounded-xl" data-kind={entry.kind === 'star' ? 'universe' : entry.kind}>
                    <span className="orbit-kind" data-kind={entry.kind} aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <span>
                      <strong>
                        {entry.label}
                        <span>{entry.count.toLocaleString()}</span>
                      </strong>
                      <small>{entry.description}</small>
                    </span>
                    <ArrowUpRight size={17} aria-hidden="true" />
                  </Link>
                );
              })}
            </nav>
          </section>
        </div>
      </div>
    </div>
  );
}
