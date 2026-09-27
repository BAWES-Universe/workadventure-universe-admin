'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Compass, Building2, DoorOpen, Users, ChevronRight } from 'lucide-react';
import { useAdminBootstrap } from './admin-bootstrap-context';
import HerePanel from './components/here-panel';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import RecentlyVisited from './components/recently-visited';
import YourSpaces from './components/your-spaces';

function greetingFor(hour: number): string {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function firstName(name: string | null, email: string | null): string | null {
  const source = name?.trim() || email?.split('@')[0] || '';
  return source ? source.split(/\s+/)[0] : null;
}

/**
 * Home: here and now. Who you are and where you are, anything waiting for you, your own spaces, and where you were
 * last. Exploring the whole Universe is one tap away, under Spaces.
 */
export default function AdminDashboard() {
  const { user, stats } = useAdminBootstrap();
  const name = firstName(user.name, user.email);
  const explore = [
    { href: '/admin/discover/universes', label: 'Universes', description: 'Public universes you can explore', count: stats.universes, icon: Compass },
    { href: '/admin/discover/worlds', label: 'Worlds', description: 'Worlds across universes', count: stats.worlds, icon: Building2 },
    { href: '/admin/discover/rooms', label: 'Rooms', description: 'Individual spaces & maps', count: stats.rooms, icon: DoorOpen },
    { href: '/admin/users', label: 'Users', description: 'People exploring the Universe', count: stats.users, icon: Users },
  ];
  // The rooms under Where you are (here, and just before), so Recently visited doesn't repeat them.
  const [shownRoomIds, setShownRoomIds] = useState<string[]>([]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">{greetingFor(new Date().getHours())}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{name ?? 'Welcome'}</h1>
      </header>

      <PendingInvitationsAlert />
      <HerePanel onShown={setShownRoomIds} />
      <RecentlyVisited excludeRoomIds={shownRoomIds} />
      <YourSpaces />

      <section data-testid="explore">
        <div className="mb-3">
          <h2 className="text-lg font-semibold tracking-tight">Discover</h2>
          <p className="text-sm text-muted-foreground">Explore universes, worlds, rooms, and users across the Universe.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {explore.map((entry) => {
            const Icon = entry.icon;
            return (
              <Link
                key={entry.href}
                href={entry.href}
                className="orbit-card orbit-card-interactive flex items-center gap-3 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[15px] font-medium">{entry.label}</span>
                    <span className="text-lg font-semibold tabular-nums">{entry.count.toLocaleString()}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{entry.description}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
