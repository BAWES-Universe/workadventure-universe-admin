'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { useAdminBootstrap } from '../admin-bootstrap-context';
import {
  EmptyCard,
  EntityCard,
  EntityRow,
  LoadError,
  LoadingRows,
  SectionHeader,
  StatLine,
  StatusPill,
  count,
} from '../components/ds';
import { isNamed, isRecord, useCollection, type Collection } from '../hooks/use-collection';
import styles from './space.module.css';

interface Universe {
  id: string;
  name: string;
  description?: string | null;
  featured?: boolean;
  _count?: { worlds?: number; rooms?: number; members?: number };
  owner?: { name?: string | null } | null;
}
interface World {
  id: string;
  name: string;
  description?: string | null;
  universe: { id: string; name: string };
  _count?: { rooms?: number; members?: number };
}
interface Room {
  id: string;
  name: string;
  world: { name: string; universe: { id?: string; name: string } };
  _count?: { favorites?: number };
}
interface Person {
  id: string;
  name: string | null;
  isGuest?: boolean;
  _count?: { ownedUniverses?: number; worldMemberships?: number };
}

const isUniverse = (value: unknown): value is Universe => isNamed(value);
const isWorld = (value: unknown): value is World => isNamed(value) && isNamed(value.universe);
const isRoom = (value: unknown): value is Room =>
  isNamed(value) && isRecord(value.world) && typeof value.world.name === 'string' && isRecord(value.world.universe);
const isPerson = (value: unknown): value is Person => isRecord(value) && typeof value.id === 'string' && !value.isGuest;

const LIMIT = 4;

function useDebounced(value: string, delay = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Space: everything out there. One search across universes, worlds, rooms and people; without one, the most visited
 * of each, and a way to see them all. What's yours is on You.
 */
export default function SpacePage() {
  const { stats } = useAdminBootstrap();
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const q = search ? `&search=${encodeURIComponent(search)}` : '';

  const universes = useCollection(`/api/admin/universes?scope=discover&page=1&limit=${LIMIT}${q}`, 'universes', isUniverse);
  const worlds = useCollection(`/api/admin/worlds?scope=discover&page=1&limit=${LIMIT}${q}`, 'worlds', isWorld);
  const rooms = useCollection(`/api/admin/rooms?scope=discover&page=1&limit=${LIMIT + 1}${q}`, 'rooms', isRoom);
  const people = useCollection(`/api/admin/users?page=1&limit=${LIMIT + 2}${q}`, 'users', isPerson);

  const searching = search.length > 0;
  const nothingFound =
    searching &&
    [universes, worlds, rooms, people].every((list) => list.result.status === 'ready' && list.result.items.length === 0);

  return (
    <div className={styles.page}>
      <h1 className="sr-only">Space</h1>
      <label className={styles.search}>
        <Search size={18} aria-hidden="true" />
        <span className="sr-only">Search Space</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search universes, worlds, rooms and people"
          data-testid="space-search"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear the search">
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </label>

      {nothingFound && (
        <p className={styles.nothing} role="status">
          Nothing matches “{search}”. Try a shorter word, or a person’s name.
        </p>
      )}

      <Section
        id="space-universes"
        title="Universes"
        total={searching ? undefined : stats.universes}
        href="/admin/discover/universes"
        collection={universes}
        hideWhenEmpty={searching}
        empty={<EmptyCard kind="universe" title="No public universes yet." text="Be the first: yours can be public for everyone to visit." href="/admin/universes/new" action="Create a universe" />}
      >
        {(items) => (
          <div className={styles.cards}>
            {items.slice(0, LIMIT).map((universe) => (
              <EntityCard
                key={universe.id}
                href={`/admin/universes/${universe.id}`}
                kind="universe"
                universeId={universe.id}
                title={universe.name}
                pills={universe.featured ? <StatusPill status="featured" /> : undefined}
                description={universe.description}
                meta={
                  <StatLine
                    items={[count(universe._count?.worlds, 'world'), count(universe._count?.rooms, 'room'), universe.owner?.name && `by ${universe.owner.name}`]}
                  />
                }
              />
            ))}
          </div>
        )}
      </Section>

      <Section id="space-worlds" title="Worlds" total={searching ? undefined : stats.worlds} href="/admin/discover/worlds" collection={worlds} hideWhenEmpty={searching}>
        {(items) => (
          <div className={styles.rows}>
            {items.slice(0, LIMIT).map((world) => (
              <EntityRow
                key={world.id}
                href={`/admin/worlds/${world.id}`}
                kind="world"
                title={world.name}
                context={<StatLine items={[world.universe.name, count(world._count?.rooms, 'room'), count(world._count?.members, 'member')]} />}
              />
            ))}
          </div>
        )}
      </Section>

      <Section id="space-rooms" title="Rooms" total={searching ? undefined : stats.rooms} href="/admin/discover/rooms" collection={rooms} hideWhenEmpty={searching}>
        {(items) => (
          <div className={styles.rows}>
            {items.slice(0, LIMIT).map((room) => (
              <EntityRow
                key={room.id}
                href={`/admin/rooms/${room.id}`}
                kind="room"
                title={room.name}
                context={<StatLine items={[`${room.world.universe.name} › ${room.world.name}`]} />}
                aside={typeof room._count?.favorites === 'number' && room._count.favorites > 0 ? `★ ${room._count.favorites}` : undefined}
              />
            ))}
          </div>
        )}
      </Section>

      <Section id="space-people" title="People" total={searching ? undefined : stats.users} href="/admin/users" collection={people} hideWhenEmpty={searching}>
        {(items) => (
          <div className={styles.rows}>
            {items.slice(0, LIMIT).map((person) => (
              <EntityRow
                key={person.id}
                href={`/admin/users/${person.id}`}
                kind="people"
                title={person.name || 'Someone'}
                context={
                  <StatLine
                    items={[
                      person._count?.ownedUniverses ? `Owns ${count(person._count.ownedUniverses, 'universe')}` : null,
                      person._count?.worldMemberships ? `Member of ${count(person._count.worldMemberships, 'world')}` : null,
                    ]}
                  />
                }
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section<T>({
  id,
  title,
  total,
  href,
  collection,
  hideWhenEmpty,
  empty,
  children,
}: {
  id: string;
  title: string;
  total?: number;
  href: string;
  collection: { result: Collection<T>; retry: () => void };
  hideWhenEmpty: boolean;
  empty?: ReactNode;
  children: (items: T[]) => ReactNode;
}) {
  const { result, retry } = collection;
  const isEmpty = result.status === 'ready' && result.items.length === 0;
  if (isEmpty && (hideWhenEmpty || !empty)) return null;
  return (
    <section aria-labelledby={id} data-testid={id}>
      <SectionHeader id={id} title={title} count={total} action={isEmpty ? null : { href, label: 'See all' }} />
      {result.status === 'loading' ? (
        <LoadingRows label={title.toLowerCase()} />
      ) : result.status === 'error' ? (
        <LoadError label={title.toLowerCase()} retry={retry} />
      ) : isEmpty ? (
        empty
      ) : (
        children(result.items)
      )}
    </section>
  );
}
