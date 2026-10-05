'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RolePill } from '../components/ds';
import { ProfileLinks, WokaAvatar } from '../components/profile-card';

export interface InvitationMember {
  id: string;
  name: string | null;
  tags?: string[];
  woka?: string[];
  bio?: string | null;
  links?: Array<{ label: string; url: string }>;
}

const RANK = ['owner', 'admin', 'editor', 'member'];

/** A member's highest role (owner over admin over editor over member), or none. */
export function topRole(tags: string[] | undefined): string | null {
  return RANK.find((role) => tags?.some((tag) => tag.toLowerCase() === role)) ?? null;
}

const roleName = (role: string | null) => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member');

/** One face: the Woka with its role badge on the bottom edge, and the name on up to two lines. */
function Face({ member, selected }: { member: InvitationMember; selected: boolean }) {
  const role = topRole(member.tags);
  const name = member.name || 'A member';
  return (
    <span className="grid w-[68px] content-start justify-items-center gap-1.5 text-center">
      <span className={cn('relative rounded-full ring-2 transition-shadow', selected ? 'ring-[#8629fc]' : 'ring-transparent')}>
        <WokaAvatar layers={member.woka ?? []} name={name} size={48} />
        {role && (
          <span
            className="absolute -bottom-2 left-1/2 inline-flex h-[18px] -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-foreground/15 bg-card px-1.5 text-[10px] font-semibold text-foreground/90"
            data-role={role}
          >
            {role === 'owner' && <i className="h-1.5 w-1.5 rounded-full bg-[var(--brand-gold)]" aria-hidden="true" />}
            {roleName(role)}
          </span>
        )}
      </span>
      <span className="mt-1.5 line-clamp-2 w-full text-[12px] leading-tight text-foreground/90 [overflow-wrap:anywhere]">{name}</span>
    </span>
  );
}

/**
 * The world's members as a row of faces, highest role first, scrolling sideways when there are more. Tapping a face
 * opens their visit card floating over the page under the row, pointing at them: name and role, their words and
 * links, and their profile. Nothing on the page moves. Swipe the card (or use the arrows or the arrow keys) to meet
 * the next member; ✕, a tap outside, Escape or the same face again closes it.
 */
export function MembersCards({
  members,
  total,
  worldHref,
}: {
  members: InvitationMember[];
  total: number;
  /** The world's page, where everyone is listed; null when the invitee can't open it yet. */
  worldHref: string | null;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [caret, setCaret] = useState<number | null>(null);
  const [shift, setShift] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const faces = useRef<HTMLUListElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const swipeStart = useRef<number | null>(null);

  // It closes with a tap anywhere outside the faces and the card, or Escape.
  useEffect(() => {
    if (picked === null) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPicked(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPicked(null);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [picked]);

  // The picked face stays in view as the card moves on, and the card's pointer follows it. On a wide page the card
  // is card-sized and sits under the picked face; on a phone it spans the row.
  useEffect(() => {
    const row = faces.current;
    if (picked === null || !row) return;
    const face = row.children[picked] as HTMLElement | undefined;
    if (!face) return;
    const place = () => {
      const center = face.offsetLeft - row.scrollLeft + face.offsetWidth / 2;
      const box = card.current;
      const room = box?.parentElement?.clientWidth ?? 0;
      setCaret(center);
      setShift(box && room >= 560 ? Math.max(0, Math.min(center - 56, room - box.offsetWidth)) : 0);
    };
    if (face.offsetLeft < row.scrollLeft || face.offsetLeft + face.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: face.offsetLeft - 8, behavior: 'smooth' });
    }
    place();
    row.addEventListener('scroll', place, { passive: true });
    return () => row.removeEventListener('scroll', place);
  }, [picked]);

  function go(next: number) {
    if (next < 0 || next >= members.length) return;
    setDirection(picked === null || next > picked ? 1 : -1);
    setPicked(next);
  }

  const more = total - members.length;
  const member = picked === null ? null : members[picked];
  const role = member ? topRole(member.tags) : null;
  const name = member?.name || 'A member';

  return (
    <div ref={root} className="relative" data-testid="invitation-members">
      <ul
        ref={faces}
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pt-1 [scrollbar-width:none]"
        onKeyDown={(event) => {
          if (picked === null) return;
          if (event.key === 'ArrowRight') go(picked + 1);
          if (event.key === 'ArrowLeft') go(picked - 1);
        }}
      >
        {members.map((person, index) => (
          <li key={person.id} className="flex-none">
            <button
              type="button"
              aria-pressed={picked === index}
              aria-label={`${person.name || 'A member'}, ${roleName(topRole(person.tags))}`}
              onClick={() => (picked === index ? setPicked(null) : go(index))}
              className="rounded-2xl pb-2 pt-2 transition-[background-color,transform] hover:-translate-y-0.5 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Face member={person} selected={picked === index} />
            </button>
          </li>
        ))}
        {more > 0 && (
          <li className="flex-none pt-2">
            {worldHref ? (
              <Link
                href={worldHref}
                className="grid w-[68px] justify-items-center gap-1.5 text-center text-[12px] text-muted-foreground hover:text-foreground"
              >
                <span className="grid h-12 w-12 place-items-center rounded-full border border-border text-xs font-semibold">+{more}</span>
                <span className="mt-1.5">See all</span>
              </Link>
            ) : (
              <span className="grid w-[68px] justify-items-center">
                <span className="grid h-12 w-12 place-items-center rounded-full border border-border text-xs font-semibold text-muted-foreground">
                  +{more}
                  <span className="sr-only"> more members</span>
                </span>
              </span>
            )}
          </li>
        )}
      </ul>
      {member && (
        <div className="absolute inset-x-0 top-full z-30 pt-2">
          {caret !== null && (
            <span
              aria-hidden="true"
              className="absolute top-[3px] h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] border-l border-t border-border bg-[hsl(var(--card))] transition-[left] duration-200"
              style={{ left: caret }}
            />
          )}
          <div
            key={member.id}
            ref={card}
            style={{ marginLeft: shift }}
            role="group"
            aria-label={`${name}’s card`}
            onPointerDown={(event) => {
              swipeStart.current = event.clientX;
            }}
            onPointerUp={(event) => {
              if (swipeStart.current === null || picked === null) return;
              const moved = event.clientX - swipeStart.current;
              swipeStart.current = null;
              if (Math.abs(moved) > 40) go(picked + (moved < 0 ? 1 : -1));
            }}
            className={cn(
              'w-full max-w-md touch-pan-y space-y-3 rounded-[18px] border border-border bg-card p-4 shadow-[0_18px_48px_-12px_rgb(0_0_0/0.85)]',
              'animate-in fade-in transition-[margin] duration-200',
              direction === 1 ? 'slide-in-from-right-3' : 'slide-in-from-left-3',
            )}
            data-testid="member-card"
          >
            <div className="flex items-start gap-3">
              <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-[16px] font-semibold">{name}</span>
                {role && <RolePill role={role} />}
              </p>
              <button
                type="button"
                aria-label="Close card"
                onClick={() => setPicked(null)}
                className="-mr-2 -mt-2 grid h-9 w-9 flex-none place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {member.bio?.trim() ? (
              <p className="line-clamp-3 whitespace-pre-line text-sm leading-relaxed text-foreground/85 [overflow-wrap:anywhere]">{member.bio}</p>
            ) : (
              <p className="text-sm text-muted-foreground">{name} hasn’t written anything about themselves yet.</p>
            )}
            {(member.links?.length ?? 0) > 0 && <ProfileLinks links={member.links ?? []} />}
            <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-3">
              <Link
                href={`/admin/users/${member.id}`}
                className="inline-flex min-h-9 items-center gap-1.5 text-sm font-semibold text-foreground/90 hover:text-foreground"
              >
                Open profile
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <span className="flex items-center gap-1.5">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {(picked ?? 0) + 1} of {members.length}
                </span>
                <button
                  type="button"
                  aria-label="Previous member"
                  disabled={picked === 0}
                  onClick={() => go((picked ?? 0) - 1)}
                  className="grid h-9 w-9 place-items-center rounded-full border border-foreground/15 hover:bg-foreground/5 disabled:opacity-35"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Next member"
                  disabled={picked === members.length - 1}
                  onClick={() => go((picked ?? 0) + 1)}
                  className="grid h-9 w-9 place-items-center rounded-full border border-foreground/15 hover:bg-foreground/5 disabled:opacity-35"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
