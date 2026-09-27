'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowUpRight,
  Building2,
  Compass,
  DoorOpen,
  Globe2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Shapes,
  Sparkles,
  Star,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import styles from './space.module.css';

interface MyUniverse {
  id: string;
  name: string;
  description?: string | null;
  isPublic: boolean;
  _count?: { worlds?: number; rooms?: number };
}
interface MyMembership {
  id: string;
  tags: string[];
  world: { id: string; name: string; universe: { name: string } };
}
interface StarredRoom {
  id: string;
  name: string;
  world: { name: string; universe: { name: string } };
}

type Collection<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: T[] };
const SHOWN = 4;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function named(value: unknown): value is Record<string, unknown> & { name: string } {
  return record(value) && typeof value.name === 'string';
}
const isUniverse = (value: unknown): value is MyUniverse =>
  named(value) && typeof value.id === 'string' && typeof value.isPublic === 'boolean' && (value.description == null || typeof value.description === 'string');
const isMembership = (value: unknown): value is MyMembership =>
  record(value) &&
  typeof value.id === 'string' &&
  Array.isArray(value.tags) &&
  value.tags.every((tag) => typeof tag === 'string') &&
  named(value.world) &&
  typeof value.world.id === 'string' &&
  named(value.world.universe);
const isStar = (value: unknown): value is StarredRoom =>
  named(value) && typeof value.id === 'string' && named(value.world) && named(value.world.universe);

/** A failed or malformed response never becomes an empty account. Each collection retries on its own. */
function useCollection<T>(url: string, key: string, isItem: (value: unknown) => value is T) {
  const [result, setResult] = useState<Collection<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ status: 'loading' });
    void (async () => {
      try {
        const response = await authenticatedFetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Collection unavailable');
        const data: unknown = await response.json();
        if (!record(data) || !Array.isArray(data[key])) throw new Error('Invalid collection');
        const items = data[key] as unknown[];
        if (!items.every(isItem)) throw new Error('Invalid collection item');
        if (!controller.signal.aborted) setResult({ status: 'ready', items });
      } catch {
        if (!controller.signal.aborted) setResult({ status: 'error' });
      }
    })();
    return () => controller.abort();
  }, [url, key, isItem, attempt]);
  return { result, retry: () => setAttempt((value) => value + 1) };
}

/**
 * Space: everything you can visit or manage. Mine is what is yours, Explore is everyone's. Each list shows a few
 * and leads to the full page.
 */
export default function SpacePage() {
  return (
    <Suspense fallback={<LoadingCollection label="your space" />}>
      <Space />
    </Suspense>
  );
}

function Space() {
  const searchParams = useSearchParams();
  const explore = searchParams.get('tab') === 'explore';
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>
            <Compass size={13} aria-hidden="true" /> Universes, worlds and rooms
          </p>
          <h1 className="orbit-display">
            Space<span>.</span>
          </h1>
          <p className={styles.intro}>Everything you own, belong to, or could still discover.</p>
        </div>
        <Link href="/admin/universes/new" className={styles.create}>
          <Plus size={17} aria-hidden="true" />
          <span>Create a universe</span>
        </Link>
      </header>
      <nav className={styles.switcher} aria-label="Space">
        <Link href="/admin/space" aria-current={!explore ? 'page' : undefined}>
          <span>Mine</span>
        </Link>
        <Link href="/admin/space?tab=explore" aria-current={explore ? 'page' : undefined}>
          <span>Explore</span>
        </Link>
      </nav>
      {explore ? <Explore /> : <Mine />}
    </div>
  );
}

function Mine() {
  const universes = useCollection(`/api/admin/universes?scope=my&limit=${SHOWN}`, 'universes', isUniverse);
  const memberships = useCollection('/api/memberships/my', 'memberships', isMembership);
  const stars = useCollection('/api/admin/stars/rooms', 'rooms', isStar);
  const { mine } = useAdminBootstrap();
  return (
    <div className={styles.mine} data-testid="space-mine">
      <section aria-labelledby="owned-heading">
        <SectionHeader id="owned-heading" marker="01" title="Your universes" href="/admin/universes" action="View all" />
        <CollectionView
          {...universes}
          label="your universes"
          empty={
            <Empty
              icon={Globe2}
              text="Every universe starts with an idea."
              detail="Make yours. Add worlds, open rooms, bring people together."
              href="/admin/universes/new"
              action="Create your first universe"
            />
          }
        >
          {(items) => (
            <div className={styles.universes}>
              {items.slice(0, SHOWN).map((universe, index) => (
                <UniverseCard key={universe.id} universe={universe} index={index} />
              ))}
            </div>
          )}
        </CollectionView>
      </section>
      <div className={styles.collections}>
        <section aria-labelledby="memberships-heading">
          <SectionHeader id="memberships-heading" marker="02" title="Worlds you belong to" href="/admin/memberships" action="View all" />
          {Boolean(mine?.invitations) && (
            <Link className={styles.invitation} href="/admin/memberships">
              <Sparkles size={16} aria-hidden="true" />
              {mine!.invitations} {mine!.invitations === 1 ? 'invitation is' : 'invitations are'} waiting
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          )}
          <CollectionView
            {...memberships}
            label="your memberships"
            empty={<Empty icon={Building2} text="Find your people." detail="Worlds you join will appear here. Start by exploring." href="/admin/space?tab=explore" action="Explore space" />}
          >
            {(items) => (
              <div className={styles.rows}>
                {items.slice(0, SHOWN).map((membership) => (
                  <Destination
                    key={membership.id}
                    href={`/admin/worlds/${membership.world.id}`}
                    icon={Building2}
                    kind="world"
                    title={membership.world.name}
                    subtitle={`${membership.world.universe.name}${membership.tags.length ? ` · ${membership.tags.join(', ')}` : ''}`}
                  />
                ))}
              </div>
            )}
          </CollectionView>
        </section>
        <section aria-labelledby="stars-heading">
          <SectionHeader id="stars-heading" marker="03" title="Your stars" href="/admin/stars" action="View all" />
          <CollectionView {...stars} label="your starred rooms" empty={<Empty icon={Star} text="Some rooms feel like home." detail="Star a room and keep a way back to it here." />}>
            {(items) => (
              <div className={styles.rows}>
                {items.slice(0, SHOWN).map((room) => (
                  <Destination key={room.id} href={`/admin/rooms/${room.id}`} icon={Star} kind="star" title={room.name} subtitle={`${room.world.name} · ${room.world.universe.name}`} />
                ))}
              </div>
            )}
          </CollectionView>
        </section>
      </div>
      <Link href="/admin/templates" className={styles.templateLink}>
        <Shapes size={20} aria-hidden="true" />
        <span>
          <strong>A head start for your next room.</strong>
          <span>Find a map in Room Templates.</span>
        </span>
        <ArrowUpRight size={20} aria-hidden="true" />
      </Link>
    </div>
  );
}

function UniverseCard({ universe, index }: { universe: MyUniverse; index: number }) {
  const worlds = universe._count?.worlds;
  const rooms = universe._count?.rooms;
  const counts = [
    typeof worlds === 'number' ? `${worlds} ${worlds === 1 ? 'world' : 'worlds'}` : null,
    typeof rooms === 'number' ? `${rooms} ${rooms === 1 ? 'room' : 'rooms'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Link href={`/admin/universes/${universe.id}`} className={`${styles.universe} orbit-kind-wash`} data-kind="universe" data-variant={index % 3}>
      <div className={styles.celestial} aria-hidden="true">
        <span className={styles.orbitRing} />
        <span className={styles.planet} />
        <span className={styles.moon} />
      </div>
      <div className={styles.universeTop}>
        <span className="orbit-kind" data-kind="universe" aria-hidden="true">
          <Globe2 size={18} />
        </span>
        <span>
          {!universe.isPublic && <LockKeyhole size={12} aria-hidden="true" />}
          {universe.isPublic ? 'Public' : 'Private'}
        </span>
      </div>
      <div className={styles.universeBottom}>
        <div>
          <h3 className="orbit-display">{universe.name}</h3>
          {universe.description && <p>{universe.description}</p>}
          {counts && <span className={styles.cardCount}>{counts}</span>}
        </div>
        <ArrowUpRight className={styles.cardArrow} size={22} aria-hidden="true" />
      </div>
    </Link>
  );
}

function Explore() {
  const { stats } = useAdminBootstrap();
  return (
    <div className={styles.explore} data-testid="space-explore">
      <section className={styles.discovery} aria-labelledby="discovery-heading">
        <div className={styles.discoveryIntro}>
          <span className={styles.eyebrow}>Beyond your orbit</span>
          <h2 id="discovery-heading" className="orbit-display">
            Across the Universe
          </h2>
          <p>Public universes, worlds and rooms anyone can visit, and the people in them.</p>
          <div className={styles.discoveryOrbit} aria-hidden="true">
            <i />
            <i />
            <i />
            <span />
          </div>
        </div>
        <div className={styles.discoveryLinks}>
          <ExploreLink href="/admin/discover/universes" number="01" icon={Globe2} kind="universe" title="Universes" count={stats.universes} description="Public universes you can explore" />
          <ExploreLink href="/admin/discover/worlds" number="02" icon={Building2} kind="world" title="Worlds" count={stats.worlds} description="Worlds across universes" />
          <ExploreLink href="/admin/discover/rooms" number="03" icon={DoorOpen} kind="room" title="Rooms" count={stats.rooms} description="Individual spaces & maps" />
          <ExploreLink href="/admin/users" number="04" icon={Users} kind="star" title="Users" count={stats.users} description="People exploring the Universe" />
        </div>
      </section>
      <section className={styles.build} aria-labelledby="build-heading">
        <div>
          <p className={styles.eyebrow}>Leave your mark</p>
          <h2 id="build-heading" className="orbit-display">
            Build something of your own
          </h2>
          <p>A universe holds your worlds and rooms. It takes a minute, and you can shape it later.</p>
        </div>
        <div className={styles.buildActions}>
          <Link className={styles.create} href="/admin/universes/new">
            <Plus size={17} aria-hidden="true" />
            Create a universe
          </Link>
          <Link className={styles.textAction} href="/admin/templates">
            Browse room templates
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </section>
    </div>
  );
}

function ExploreLink({ href, icon: Icon, kind, title, count, description }: { href: string; number?: string; icon: LucideIcon; kind: 'universe' | 'world' | 'room' | 'star'; title: string; count: number; description: string }) {
  return (
    <Link className={`${styles.exploreLink} orbit-kind-wash`} data-kind={kind === 'star' ? 'universe' : kind} href={href}>
      <span className="orbit-kind" data-kind={kind} aria-hidden="true">
        <Icon size={18} />
      </span>
      <span>
        <strong>
          {title} <span className={styles.count}>{count.toLocaleString()}</span>
        </strong>
        <span>{description}</span>
      </span>
      <ArrowUpRight size={20} aria-hidden="true" />
    </Link>
  );
}

function SectionHeader({ id, title, href, action }: { id: string; marker?: string; title: string; href: string; action: string }) {
  return (
    <div className={styles.sectionHeader}>
      <h2 id={id}>{title}</h2>
      <Link href={href}>
        {action}
        <ArrowUpRight size={14} aria-hidden="true" />
      </Link>
    </div>
  );
}

function Destination({ href, icon: Icon, kind, title, subtitle }: { href: string; icon: LucideIcon; kind: 'universe' | 'world' | 'room' | 'star'; title: string; subtitle: string }) {
  return (
    <Link className={`${styles.destination} orbit-kind-wash`} data-kind={kind === 'star' ? 'room' : kind} href={href}>
      <span className="orbit-kind" data-kind={kind} aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className={styles.destinationText}>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </span>
      <ArrowUpRight size={16} aria-hidden="true" />
    </Link>
  );
}

function Empty({ icon: Icon, text, detail, href, action }: { icon: LucideIcon; text: string; detail: string; href?: string; action?: string }) {
  return (
    <div className={styles.empty}>
      <Icon size={22} aria-hidden="true" />
      <div>
        <h3>{text}</h3>
        <p>{detail}</p>
        {href && (
          <Link href={href}>
            {action}
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
    </div>
  );
}

function LoadingCollection({ label }: { label: string }) {
  return (
    <div className={styles.loading} role="status">
      <span />
      Loading {label}…
    </div>
  );
}

function CollectionView<T>({ result, retry, label, empty, children }: { result: Collection<T>; retry: () => void; label: string; empty: ReactNode; children: (items: T[]) => ReactNode }) {
  if (result.status === 'loading') return <LoadingCollection label={label} />;
  if (result.status === 'error')
    return (
      <div className={styles.error} role="alert">
        <p>We couldn’t load {label}.</p>
        <button type="button" onClick={retry}>
          <RefreshCw size={14} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  return result.items.length ? children(result.items) : empty;
}
