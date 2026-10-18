'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import type { PersonVisit, VisitorPerson } from '@/lib/visitor-people';
import { Button } from '@/components/ui/button';
import { EmptyCard, LoadError, LoadingRows, RolePills, StatLine } from './ds';
import { PersonIcon } from './profile-card';
import styles from './visitor-people.module.css';

type Scope = 'universe' | 'world' | 'room';

const MORE_VISITS = 20;

/**
 * Who came by, one card per person, newest first. Someone who came back many times is still one card: "9 visits" opens
 * every visit (when, signed in or guest, and the IP on a room or the room on a world or universe), so nothing is lost.
 */
export function VisitorPeople({ scope, id }: { scope: Scope; id: string }) {
  const [people, setPeople] = useState<VisitorPerson[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`/api/admin/visitors?scope=${scope}&id=${encodeURIComponent(id)}&page=${page}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`status ${response.status}`);
        const data = (await response.json()) as { people: VisitorPerson[]; total: number; hasMore: boolean };
        if (cancelled) return;
        // A page can repeat someone who came back while you were reading; keep them where they first showed.
        setPeople((current) => {
          if (page === 1 || !current) return data.people;
          const shown = new Set(current.map((person) => person.key));
          return [...current, ...data.people.filter((person) => !shown.has(person.key))];
        });
        setTotal(data.total);
        setHasMore(data.hasMore);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingMore(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, id, page, attempt]);

  const retry = () => {
    setFailed(false);
    setLoadingMore(people !== null);
    setAttempt((current) => current + 1);
  };
  const showMore = () => {
    setLoadingMore(true);
    setPage((current) => current + 1);
  };

  if (failed && people === null) return <LoadError label="visitors" retry={retry} />;
  if (people === null) return <LoadingRows label="visitors" rows={3} />;
  if (people.length === 0) return <EmptyCard kind="people" plainIcon title="No visitors yet." text={`Visits to this ${scope} show up here.`} />;

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addVisits = (key: string, visits: PersonVisit[]) =>
    setPeople(
      (current) =>
        current &&
        current.map((person) => {
          if (person.key !== key) return person;
          // A visit made while the list was open moves the rest down by one; never show the same visit twice.
          const shown = new Set(person.visits.map((visit) => visit.id));
          return { ...person, visits: [...person.visits, ...visits.filter((visit) => !shown.has(visit.id))] };
        }),
    );

  return (
    <div className="space-y-4">
      <ul className={styles.list} data-testid="visitor-people">
        {people.map((person) => (
          <PersonCard key={person.key} person={person} scope={scope} id={id} expanded={open.has(person.key)} onToggle={() => toggle(person.key)} onMore={(visits) => addVisits(person.key, visits)} />
        ))}
      </ul>
      <div className={styles.foot}>
        <span>
          {people.length.toLocaleString()} of {total.toLocaleString()} {total === 1 ? 'person' : 'people'}
        </span>
        {/* After a page fails, Try again asks for that same page; Show more would skip it. */}
        {hasMore && !failed && (
          <Button variant="outline" className="h-11 px-5" disabled={loadingMore} onClick={showMore}>
            {loadingMore ? 'Loading…' : 'Show more'}
          </Button>
        )}
      </div>
      {failed && people.length > 0 && <LoadError label="more visitors" retry={retry} />}
    </div>
  );
}

function PersonCard({
  person,
  scope,
  id,
  expanded,
  onToggle,
  onMore,
}: {
  person: VisitorPerson;
  scope: Scope;
  id: string;
  expanded: boolean;
  onToggle: () => void;
  onMore: (visits: PersonVisit[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = person.visits[0];
  const moreIps = scope === 'room' && person.ipCount ? person.ipCount - 1 : 0;
  const left = person.visitCount - person.visits.length;
  const loadMore = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const response = await authenticatedFetch(
        `/api/admin/visitors?scope=${scope}&id=${encodeURIComponent(id)}&person=${encodeURIComponent(person.key)}&offset=${person.visits.length}&limit=${MORE_VISITS}`,
      );
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = (await response.json()) as { visits: PersonVisit[] };
      onMore(data.visits);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  const head = (
    <>
      <PersonIcon woka={person.woka} name={person.name} face plain />
      <span className={styles.text}>
        <strong className={styles.name}>{person.name}</strong>
        <StatLine items={[person.roles.length > 0 ? null : latest.signedIn ? 'Signed in' : 'Guest', timeAgo(new Date(latest.at))]} />
        {(person.roles.length > 0 || (scope === 'room' && latest.ip)) && (
          <span className={styles.meta}>
            {person.roles.length > 0 && <RolePills roles={person.roles} />}
            {scope === 'room' && latest.ip && <span className={styles.ip}>{latest.ip}</span>}
            {moreIps > 0 && (
              <span className={styles.more}>
                +{moreIps} more {moreIps === 1 ? 'IP' : 'IPs'}
              </span>
            )}
          </span>
        )}
      </span>
    </>
  );
  const visitsId = `visits-${person.key}`;
  return (
    <li className={styles.person} data-testid="visitor-person">
      {person.userId ? (
        <Link href={`/admin/users/${person.userId}`} className={styles.head}>
          {head}
          <ArrowUpRight className={styles.arrow} size={16} aria-hidden="true" />
        </Link>
      ) : (
        <div className={styles.head}>{head}</div>
      )}
      {person.visitCount > 1 && (
        <>
          <button type="button" className={styles.strip} aria-expanded={expanded} aria-controls={visitsId} onClick={onToggle}>
            <span>{person.visitCount.toLocaleString()} visits</span>
            <ChevronDown size={18} aria-hidden="true" className={styles.chev} />
          </button>
          {expanded && (
            <div className={styles.visits} id={visitsId}>
              <ol>
                {person.visits.map((visit) => (
                  <li key={visit.id} className={styles.visit}>
                    <time dateTime={visit.at} title={new Date(visit.at).toLocaleString()}>
                      {timeAgo(new Date(visit.at))}
                    </time>
                    <span className={styles.how}>{visit.signedIn ? 'Signed in' : 'Guest'}</span>
                    {scope === 'room' ? (
                      visit.ip && <span className={styles.ip}>{visit.ip}</span>
                    ) : (
                      <Link href={`/admin/rooms/${visit.room.id}`} className={styles.room}>
                        {visit.room.name}
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
              {left > 0 && (
                <button type="button" className={styles.moreVisits} disabled={loading} onClick={loadMore}>
                  {loading ? 'Loading…' : failed ? 'Couldn’t load. Try again' : `Show ${Math.min(MORE_VISITS, left).toLocaleString()} more visits`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}
