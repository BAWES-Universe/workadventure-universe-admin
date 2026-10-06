'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DoorOpen, Earth, Orbit, Users } from 'lucide-react';
import { searchMenu, type MenuSearchGroup, type MenuSearchScope } from '@/lib/menu-search';

const icons = { people: Users, room: DoorOpen, world: Earth, universe: Orbit };

/** Mounted only while the menu is open. Closing or typing aborts every request from the previous query. */
export function MenuSearchResults({ query, scope, choose }: { query: string; scope: MenuSearchScope; choose: (event: React.MouseEvent) => void }) {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    query: string;
    scope: MenuSearchScope;
    attempt: number;
    groups: MenuSearchGroup[];
  } | null>(null);
  const ready = settled?.query === query && settled.scope === scope && settled.attempt === attempt;
  const enabled = query.length >= 2 && scope !== 'tools';

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchMenu(query, scope, controller.signal)
        .then((groups) => {
          if (!controller.signal.aborted) setSettled({ query, scope, attempt, groups });
        })
        .catch(() => {
          /* Aborted requests belong to an earlier query or a closed menu. */
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, scope, attempt, enabled]);

  if (scope === 'tools') return null;
  if (!enabled) return <p className="orbit-menu-hint">Type at least two characters to find people and places.</p>;
  if (!ready)
    return (
      <p className="orbit-menu-hint" role="status">
        Searching people and places…
      </p>
    );

  return (
    <div className="orbit-menu-results" aria-label="Search results">
      {settled.groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <div className="orbit-menu-result-heading">
            <h3 className="orbit-eyebrow">{group.label}</h3>
            <Link href={group.href} onClick={choose} data-menu-result>
              See all {group.label.toLowerCase()}
            </Link>
          </div>
          {group.failed ? (
            <p className="orbit-menu-hint" role="status">
              Couldn’t search {group.label.toLowerCase()}.{' '}
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                Retry
              </button>
            </p>
          ) : group.items.length === 0 ? (
            <p className="orbit-menu-hint">No matching {group.label.toLowerCase()}.</p>
          ) : (
            <ul>
              {group.items.map((item) => {
                const Icon = icons[item.kind];
                return (
                  <li key={item.id}>
                    <Link href={item.href} onClick={choose} className="orbit-menu-result" data-menu-result>
                      <Icon size={19} className={`orbit-menu-kind-${item.kind}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{item.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{item.context}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
      <p className="orbit-menu-hint">Results open existing profiles and place details. Your game stays in the current room.</p>
    </div>
  );
}
