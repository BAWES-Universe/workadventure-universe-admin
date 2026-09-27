'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Globe, Building2, Star, Plus, Compass, DoorOpen, Users, FolderOpen, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { authenticatedFetch } from '@/lib/client-auth';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import { ListGroup, ListRow, SectionHeading, StatTile } from '../components/shell/list-row';

type Tab = 'mine' | 'explore';

interface MyUniverse {
  id: string;
  name: string;
  slug: string;
  isPublic: boolean;
  _count?: { worlds?: number; rooms?: number };
}
interface MyMembership {
  id: string;
  tags: string[];
  world: { id: string; name: string; slug: string; universe: { id: string; name: string } };
}
interface StarredRoom {
  id: string;
  name: string;
  world: { id: string; name: string; universe: { id: string; name: string } };
}

const SHOWN = 4;

/**
 * Spaces: everything you can visit or manage. Mine is what is yours, Explore is everyone's. Each list shows a few
 * and leads to the full page.
 */
export default function SpacesPage() {
  return (
    <Suspense fallback={null}>
      <Spaces />
    </Suspense>
  );
}

function Spaces() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'explore' ? 'explore' : 'mine';

  function switchTo(next: Tab) {
    router.replace(next === 'mine' ? '/admin/spaces' : '/admin/spaces?tab=explore');
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Spaces</h1>
        <Button asChild size="sm" className="orbit-brand-fill border-0 hover:opacity-90">
          <Link href="/admin/universes/new">
            <Plus className="h-4 w-4" />
            New universe
          </Link>
        </Button>
      </header>

      <div role="tablist" aria-label="Spaces" className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
        {(['mine', 'explore'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => switchTo(value)}
            className={cn(
              'orbit-press h-9 rounded-lg text-sm font-medium transition-colors',
              tab === value ? 'bg-elevated text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {value === 'mine' ? 'Mine' : 'Explore'}
          </button>
        ))}
      </div>

      {tab === 'mine' ? <Mine /> : <Explore />}
    </div>
  );
}

function Mine() {
  const [universes, setUniverses] = useState<MyUniverse[] | null>(null);
  const [memberships, setMemberships] = useState<MyMembership[] | null>(null);
  const [stars, setStars] = useState<StarredRoom[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = async <T,>(url: string, key: string): Promise<T[]> => {
      try {
        const response = await authenticatedFetch(url);
        if (!response.ok) return [];
        const data = (await response.json()) as Record<string, unknown>;
        return Array.isArray(data[key]) ? (data[key] as T[]) : [];
      } catch {
        return [];
      }
    };
    void Promise.all([
      read<MyUniverse>(`/api/admin/universes?scope=my&limit=${SHOWN}`, 'universes'),
      read<MyMembership>('/api/memberships/my', 'memberships'),
      read<StarredRoom>('/api/admin/stars/rooms', 'rooms'),
    ]).then(([mine, member, starred]) => {
      if (cancelled) return;
      setUniverses(mine);
      setMemberships(member);
      setStars(starred);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6" data-testid="spaces-mine">
      <section>
        <SectionHeading
          title="My universes"
          action={
            <Link href="/admin/universes" className="font-medium text-primary hover:underline">
              See all
            </Link>
          }
        />
        {universes === null ? (
          <ListSkeleton />
        ) : universes.length === 0 ? (
          <EmptyLine icon={Globe} text="You don't own a universe yet." action={{ href: '/admin/universes/new', label: 'Create one' }} />
        ) : (
          <ListGroup>
            {universes.slice(0, SHOWN).map((universe) => (
              <ListRow
                key={universe.id}
                href={`/admin/universes/${universe.id}`}
                icon={Globe}
                tone="brand"
                title={universe.name}
                subtitle={`${universe._count?.worlds ?? 0} ${universe._count?.worlds === 1 ? 'world' : 'worlds'} · ${universe._count?.rooms ?? 0} ${universe._count?.rooms === 1 ? 'room' : 'rooms'}`}
                trailing={!universe.isPublic ? <Lock className="h-4 w-4 text-muted-foreground" aria-label="Private" /> : undefined}
              />
            ))}
          </ListGroup>
        )}
      </section>

      <section>
        <SectionHeading
          title="Worlds I'm in"
          action={
            <Link href="/admin/memberships" className="font-medium text-primary hover:underline">
              See all
            </Link>
          }
        />
        {memberships === null ? (
          <ListSkeleton />
        ) : memberships.length === 0 ? (
          <EmptyLine icon={Building2} text="No memberships yet. An invitation from a world's owner gets you in." />
        ) : (
          <ListGroup>
            {memberships.slice(0, SHOWN).map((membership) => (
              <ListRow
                key={membership.id}
                href={`/admin/worlds/${membership.world.id}`}
                icon={Building2}
                title={membership.world.name}
                subtitle={`${membership.world.universe.name}${membership.tags.length ? ` · ${membership.tags.join(', ')}` : ''}`}
              />
            ))}
          </ListGroup>
        )}
      </section>

      <section>
        <SectionHeading
          title="Starred rooms"
          action={
            <Link href="/admin/stars" className="font-medium text-primary hover:underline">
              See all
            </Link>
          }
        />
        {stars === null ? (
          <ListSkeleton />
        ) : stars.length === 0 ? (
          <EmptyLine icon={Star} text="Star a room to keep it here." />
        ) : (
          <ListGroup>
            {stars.slice(0, SHOWN).map((room) => (
              <ListRow
                key={room.id}
                href={`/admin/rooms/${room.id}`}
                icon={Star}
                title={room.name}
                subtitle={`${room.world.name} · ${room.world.universe.name}`}
              />
            ))}
          </ListGroup>
        )}
      </section>
    </div>
  );
}

function Explore() {
  const { stats } = useAdminBootstrap();
  return (
    <div className="space-y-6" data-testid="spaces-explore">
      <section>
        <SectionHeading title="Across the Universe" description="Public universes, worlds and rooms anyone can visit." />
        <div className="grid grid-cols-2 gap-3">
          <StatTile href="/admin/discover/universes" icon={Compass} value={stats.universes} label="Universes" />
          <StatTile href="/admin/discover/worlds" icon={Building2} value={stats.worlds} label="Worlds" accent="muted" />
          <StatTile href="/admin/discover/rooms" icon={DoorOpen} value={stats.rooms} label="Rooms" accent="muted" />
          <StatTile href="/admin/users" icon={Users} value={stats.users} label="Users" accent="gold" />
        </div>
      </section>
      <section>
        <SectionHeading title="Build" />
        <ListGroup>
          <ListRow href="/admin/templates" icon={FolderOpen} title="Room Templates" subtitle="Ready-made maps to start a room from" />
          <ListRow href="/admin/universes/new" icon={Plus} tone="brand" title="New universe" subtitle="Your own universe, for your worlds and rooms" />
        </ListGroup>
      </section>
    </div>
  );
}

function ListSkeleton() {
  return (
    <ListGroup>
      {[0, 1].map((index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </ListGroup>
  );
}

function EmptyLine({
  icon: Icon,
  text,
  action,
}: {
  icon: typeof Globe;
  text: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="orbit-card flex items-center gap-3 border-dashed p-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">{text}</p>
      {action && (
        <Link href={action.href} className="shrink-0 text-sm font-medium text-primary hover:underline">
          {action.label}
        </Link>
      )}
    </div>
  );
}
