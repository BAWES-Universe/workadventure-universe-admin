'use client';

/*
 * The top card and the room rows of the universe, world and room pages, and the small pieces they share. They take
 * their numbers as props: the pages read them from Live now, the activity summaries and the members list.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useContext } from 'react';
import { ArrowDown, DoorOpen, Earth, LogIn, Plus, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { timeAgo } from '@/lib/time-ago';
import { cn } from '@/lib/utils';
import { WorkAdventureContext } from '../workadventure-context';
import type { Face, Here } from '../hooks/use-place-data';
import { WokaAvatar } from './profile-card';
import { OrbitalIllustration } from './room-card';
import { KIND_ICON } from './ds';
import styles from './place-hero.module.css';

/** A room as a row: who is in it, when you or anyone was last there, and where the game goes. */
export interface RoomRowData {
  id: string;
  name: string;
  favorites: number;
  /** Where the game goes: `/@/universe/world/room`. */
  playPath: string;
  here: Here;
  /** When you were last there. */
  you?: string | null;
  /** When anyone was last there. */
  latest?: string | null;
}

/** A room as a card under "Also in <world>". */
export interface RoomCardData extends RoomRowData {
  description: string | null;
  accesses: number | null;
  peak: string | null;
}

/** The game's address of a room; each slug encoded, as Live now does. */
export function playPathOf(universeSlug: string, worldSlug: string, roomSlug: string): string {
  return `/@/${[universeSlug, worldSlug, roomSlug].map(encodeURIComponent).join('/')}`;
}

/** Goes to a room: straight there inside the game, its page otherwise. */
export function VisitButton({
  playPath,
  roomId,
  name,
  hero,
  label = 'Visit',
}: {
  playPath: string;
  roomId: string;
  name: string;
  hero?: boolean;
  label?: string;
}) {
  const wa = useContext(WorkAdventureContext);
  const ready = Boolean(wa?.isReady);
  const aria = `${label}: ${name}`;
  if (hero) {
    return ready ? (
      <Button
        className="h-12 px-6 text-base"
        aria-label={aria}
        onClick={() => wa?.navigateToRoom(playPath).catch((error) => console.error('[Visit] Could not go to the room:', error))}
      >
        <LogIn aria-hidden="true" />
        {label} {name}
      </Button>
    ) : (
      <Button asChild className="h-12 px-6 text-base">
        <Link href={`/admin/rooms/${roomId}`} aria-label={aria}>
          <LogIn aria-hidden="true" />
          {label} {name}
        </Link>
      </Button>
    );
  }
  return ready ? (
    <button
      type="button"
      className={cn('orbit-press', styles.visit)}
      aria-label={aria}
      onClick={() => wa?.navigateToRoom(playPath).catch((error) => console.error('[Visit] Could not go to the room:', error))}
    >
      <LogIn size={17} aria-hidden="true" />
      {label}
    </button>
  ) : (
    <Link href={`/admin/rooms/${roomId}`} className={cn('orbit-press', styles.visit)} aria-label={aria}>
      <LogIn size={17} aria-hidden="true" />
      {label}
    </Link>
  );
}

/** The hero's main button on a world or universe: scrolls down to the list of rooms or worlds, where each row has its own Visit. */
export function BrowseButton({ label, targetId }: { label: string; targetId: string }) {
  const jump = () => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(targetId)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };
  return (
    <Button className="h-12 px-6 text-base" onClick={jump}>
      <ArrowDown aria-hidden="true" />
      {label}
    </Button>
  );
}

function hereText(people: Face[], count: number): string {
  const names = people.map((face) => face.name);
  // Guests and bots are counted but not named.
  const unnamed = Math.max(0, count - names.length);
  if (names.length === 0) return `${count} ${count === 1 ? 'person is' : 'people are'} here now`;
  if (unnamed === 0 && names.length === 1) return `${names[0]} is here now`;
  if (unnamed === 0 && names.length === 2) return `${names[0]} and ${names[1]} are here now`;
  if (unnamed === 0 && names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are here now`;
  const shown = names.slice(0, 3);
  const more = count - shown.length;
  return `${shown.join(', ')} and ${more} more ${more === 1 ? 'is' : 'are'} here now`;
}

export function Faces({ here, size = 32, max = 5 }: { here: Face[]; size?: number; max?: number }) {
  return (
    <span className={styles.faces}>
      {here.slice(0, max).map((face, index) => (
        <WokaAvatar key={`${face.name}-${index}`} layers={face.woka} name={face.name} size={size} tinted />
      ))}
    </span>
  );
}

export function PlaceHero({
  kind,
  title,
  context,
  description,
  stats,
  rank,
  here,
  actions,
  manageLine,
  manage,
}: {
  kind: 'universe' | 'world' | 'room';
  title: string;
  context: ReactNode;
  description?: string | null;
  stats: { value: string | number; label: string; live?: boolean; href?: string }[];
  rank?: ReactNode;
  here?: Here;
  actions: ReactNode;
  manageLine?: string;
  manage?: ReactNode;
}) {
  const Icon = KIND_ICON[kind];
  return (
    <header className={styles.hero} data-kind={kind} data-testid="place-hero">
      <span className={styles.planet}><OrbitalIllustration /></span>
      <span className={styles.eyebrow}><Icon size={16} aria-hidden="true" />{kind}</span>
      <h1 className={styles.title}>{title}</h1>
      <div className={styles.context}>{context}</div>
      {description && <p className={styles.description}>{description}</p>}
      <dl className={styles.stats}>
        {stats.map((stat) => (
          <div key={stat.label} className={styles.stat} data-live={stat.live ? 'true' : undefined}>
            {stat.href ? (
              <Link href={stat.href} className={cn('orbit-press', styles.statLink)}>
                <dt>{stat.label} ›</dt>
                <dd>{stat.value}</dd>
              </Link>
            ) : (
              <>
                <dt>{stat.label}</dt>
                <dd>{stat.value}</dd>
              </>
            )}
          </div>
        ))}
      </dl>
      {rank}
      {here && here.count > 0 && (
        <div className={styles.here}>
          {here.people.length > 0 && <Faces here={here.people} />}
          {here.people.length > 5 && <span className={styles.more}>+{here.people.length - 5}</span>}
          <span>{hereText(here.people, here.count)}</span>
        </div>
      )}
      <div className={styles.actions}>{actions}</div>
      {(manageLine || manage) && (
        <div className={styles.manage}>
          {manageLine && <p>{manageLine}</p>}
          {manage && <div className={styles.actions}>{manage}</div>}
        </div>
      )}
    </header>
  );
}

export function Crumb({ kind, label, href }: { kind: 'universe' | 'world'; label: string; href: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={styles.crumb}>
      <Icon size={16} className={kind === 'universe' ? styles.u : styles.w} aria-hidden="true" />
      <Link href={href}>{label}</Link>
    </span>
  );
}

export function By({ name, woka, you, href }: { name: string; woka?: string[]; you: boolean; href: string }) {
  return (
    <span className={styles.by}>
      <WokaAvatar layers={woka ?? []} name={name} size={26} />
      by <Link href={href}><strong>{you ? 'you' : name}</strong></Link>
    </span>
  );
}

export function Rank({ position, of }: { position: number; of: number }) {
  return (
    <span className={styles.rank}>
      <b>#{position}</b> in Space this week · by visits, of {of} public universes
    </span>
  );
}

export function StarButton({
  count,
  starred,
  onClick,
  disabled,
}: {
  count: number;
  starred: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={cn('orbit-press', styles.visit, 'px-5')} aria-pressed={starred} onClick={onClick} disabled={disabled}>
      <Star size={18} aria-hidden="true" className={starred ? 'fill-[var(--kind-star-solid)] text-[var(--kind-star-solid)]' : undefined} />
      {starred ? 'Starred' : 'Star'} · {count}
    </button>
  );
}

export function SectionHead({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return (
    <div className={styles.head}>
      <h2>
        {title}
        {count !== undefined && <span>{count}</span>}
      </h2>
      {action}
    </div>
  );
}

export function AddButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={cn('orbit-press', styles.addRoom)}>
      <Plus size={16} aria-hidden="true" />
      {children}
    </Link>
  );
}

/** "You were here 3 days ago", "Last visit 2 hours ago", or nothing yet. */
function lastLine(you?: string | null, latest?: string | null): string {
  if (you) return `You were here ${timeAgo(new Date(you))}`;
  if (latest) return `Last visit ${timeAgo(new Date(latest))}`;
  return 'No visits yet';
}

function RoomRow({ room }: { room: RoomRowData }) {
  return (
    <div className={styles.row} style={{ position: 'relative' }}>
      <DoorOpen size={22} className={styles.rowIcon} aria-hidden="true" />
      <div className={styles.rowMain}>
        <Link href={`/admin/rooms/${room.id}`} className={styles.rowName}>{room.name}</Link>
        <span className={styles.rowSub}>
          {room.here.count > 0 ? (
            <>
              <span className={styles.live}><i className={styles.dot} />{room.here.count} here</span>
              {room.here.people.length > 0 && <Faces here={room.here.people} size={22} max={3} />}
            </>
          ) : (
            lastLine(room.you, room.latest)
          )}
        </span>
      </div>
      <div className={styles.rowEnd}>
        {room.favorites > 0 && (
          <span className={styles.stars}><Star size={15} aria-hidden="true" />{room.favorites}</span>
        )}
        {room.here.youAreHere ? (
          <span className={styles.youHere}>You’re here</span>
        ) : (
          <VisitButton playPath={room.playPath} roomId={room.id} name={room.name} />
        )}
      </div>
    </div>
  );
}

export function RoomRows({ rooms }: { rooms: RoomRowData[] }) {
  return (
    <div className={styles.rows}>
      {rooms.map((room) => (
        <RoomRow key={room.id} room={room} />
      ))}
    </div>
  );
}

export interface WorldGroupData {
  id: string;
  name: string;
  rooms: number;
  members: number;
  /** Stars on the world itself. */
  favorites: number;
  /** Null while a world's rooms are on their way, or when the universe has too many worlds to ask for each. */
  roomList: RoomRowData[] | null;
}

export function WorldGroups({ worlds, canEdit }: { worlds: WorldGroupData[]; canEdit: boolean }) {
  return (
    <div className={styles.groups}>
      {worlds.map((world) => (
        <section key={world.id} className={styles.group} aria-label={world.name}>
          <div className={styles.groupHead}>
            <Earth size={22} className={styles.w} aria-hidden="true" />
            <Link href={`/admin/worlds/${world.id}`}>
              <strong>{world.name}</strong>
              <span>{world.rooms} {world.rooms === 1 ? 'room' : 'rooms'} · {world.members} {world.members === 1 ? 'member' : 'members'}</span>
            </Link>
            {world.favorites > 0 && <span className={styles.stars}><Star size={15} aria-hidden="true" />{world.favorites}</span>}
          </div>
          {world.roomList && <RoomRows rooms={world.roomList} />}
          {canEdit && <AddButton href={`/admin/rooms/new?worldId=${world.id}`}>Create room in {world.name}</AddButton>}
        </section>
      ))}
    </div>
  );
}

export function AlsoIn({ rooms }: { rooms: RoomCardData[] }) {
  return (
    <div className={styles.siblings}>
      {rooms.map((room) => (
        <article key={room.id} className={styles.sib}>
          <div className={styles.sibTop}>
            <span className={styles.stars}><Star size={15} aria-hidden="true" />{room.favorites}</span>
          </div>
          <Link href={`/admin/rooms/${room.id}`} className={styles.sibName}><DoorOpen size={20} aria-hidden="true" />{room.name}</Link>
          <p className={styles.sibDesc}>{room.description}</p>
          <div className={styles.sibFoot}>
            <p>
              {lastLine(room.you, room.latest)}
              {room.accesses !== null && (
                <>
                  <br />
                  {room.accesses} {room.accesses === 1 ? 'access' : 'accesses'}{room.peak ? ` · peak ${room.peak}` : ''}
                </>
              )}
            </p>
            {room.here.youAreHere ? (
              <span className={styles.youHere}>You’re here</span>
            ) : (
              <VisitButton playPath={room.playPath} roomId={room.id} name={room.name} />
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
