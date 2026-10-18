'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import { dayWord, isAdministrator, pickableWorlds, type AllowedWorlds } from '@/lib/member-roles';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { PickChip, Segmented } from '@/components/ui/choice';
import { useToast } from '@/components/ui/toast';
import { FormSheet } from './form-sheet';
import { WokaAvatar } from './profile-card';
import { useUniverseBasics, useUniverseRoles, useJson } from './universe-people';

/** Someone the invite is for: picked from the lists, or handed in by the page that opened the sheet. */
export interface InvitePerson {
  userId: string;
  name: string;
  woka?: string[];
  /** A line under their name, such as "Your friend · in HQ Lobby yesterday". */
  note?: string | null;
  /** The line for each universe, when it differs by universe (a visit is in one universe). */
  notes?: Record<string, string | null>;
}

interface Candidate extends InvitePerson {
  friend?: boolean;
  at?: string | null;
  room?: { id: string; name: string } | null;
  world?: { id: string; name: string } | null;
  lastVisitedAt?: string | null;
}

function visitorNote(visit: Candidate): string {
  const where = [visit.world?.name, visit.room?.name].filter(Boolean).join(' ');
  const when = visit.at ? dayWord(new Date(visit.at)) : '';
  const place = where ? `in ${where}` : '';
  const spoken = when === 'today' || when === 'yesterday' ? when : when ? `on ${when}` : '';
  const line = [visit.friend ? 'Your friend' : null, [place, spoken].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Visited this week';
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The line under someone's name from what is known: your friend, and their last visit. Nothing when there is nothing to say. */
export function personNote(known: { friend?: boolean; visit?: { at: string; room?: { name: string } | null; world?: { name: string } | null } | null }): string | null {
  if (!known.friend && !known.visit) return null;
  return visitorNote({ userId: '', name: '', friend: known.friend, at: known.visit?.at, room: known.visit?.room as Candidate['room'], world: known.visit?.world as Candidate['world'] });
}

function PersonRow({ person, note, onPick }: { person: Candidate; note: string; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-1 py-1.5 text-left transition-colors hover:bg-foreground/[.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <WokaAvatar layers={person.woka ?? []} name={person.name} size={40} tinted round />
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-[15px] font-bold">{person.name}</strong>
          <span className="block truncate text-[13px] text-muted-foreground">{note}</span>
        </span>
        <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-1" aria-label={title}>
      <h3 className="text-[13px] font-bold text-muted-foreground">{title}</h3>
      <ul className="grid gap-0.5">{children}</ul>
    </section>
  );
}

/**
 * Inviting someone to a universe, in two steps: pick the person (people who visited this week, your friends, or a name
 * search), then the roles on top of Member and where they work. A page that already knows the person opens it on step
 * two. There is no Member tick: everyone who joins is a Member.
 */
export default function InviteSheet({ open, onOpenChange, universeId, universes, person: given, worldId, onSent, giving }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
  /** More than one universe the person could be invited to: step two offers them. */
  universes?: { id: string; name: string; status?: 'member' | 'invited' }[];
  /** Skips step one. */
  person?: InvitePerson | null;
  /** A world to start with in "Some worlds" (a visitor's room's world). */
  worldId?: string | null;
  onSent?: () => void;
  /** Opened from their profile's Give membership: the title says the same. */
  giving?: boolean;
}) {
  const { addToast } = useToast();
  const [chosenUniverse, setChosenUniverse] = useState(universeId);
  const [picked, setPicked] = useState<InvitePerson | null>(null);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [all, setAll] = useState<boolean | null>(null);
  const [worldIds, setWorldIds] = useState<string[]>(worldId ? [worldId] : []);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each open starts clean: a cancelled invite doesn't come back.
  useEffect(() => {
    if (!open) return;
    setChosenUniverse(universeId);
    setPicked(given ?? null);
    setQuery('');
    setSearched('');
    setRoleIds([]);
    setAll(worldId ? false : null);
    setWorldIds(worldId ? [worldId] : []);
    setMessage('');
    setError(null);
    setSending(false);
    // Only an opening starts over; the same page re-rendering must not wipe what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The name search waits for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const base = `/api/admin/universes/${encodeURIComponent(chosenUniverse)}`;
  const basics = useUniverseBasics(open ? chosenUniverse : null);
  const roles = useUniverseRoles(open ? chosenUniverse : null);
  const [me] = useJson<{ highest: number | null; full: boolean; give: AllowedWorlds; invite: AllowedWorlds }>(
    open ? `${base}/me` : null,
    (body) => ({ highest: body.highestPosition ?? null, full: !!body.full, give: body.giveWorlds ?? [], invite: body.inviteWorlds ?? [] }),
  );
  const [people, retryPeople] = useJson<{ visitors: Candidate[]; friends: Candidate[]; results: Candidate[] }>(
    open && !picked ? `${base}/invite-candidates?q=${encodeURIComponent(searched)}` : null,
    (body) => ({ visitors: body.visitors ?? [], friends: body.friends ?? [], results: body.results ?? [] }),
  );

  const universeName = basics.status === 'ready' ? basics.value.name : 'this universe';
  const universeWorlds = useMemo(() => (basics.status === 'ready' ? basics.value.worlds : []), [basics]);

  const givable = useMemo(() => {
    if (roles.status !== 'ready' || me.status !== 'ready') return { builtIn: [], custom: [] };
    const canGive = me.value.give === 'all' || me.value.give.length > 0;
    const list = roles.value.list.filter(
      (role) => canGive && role.key !== 'member' && role.key !== 'everyone' && (me.value.full || (me.value.highest !== null && role.position < me.value.highest)),
    );
    return { builtIn: list.filter((role) => role.builtIn), custom: list.filter((role) => !role.builtIn) };
  }, [roles, me]);

  const allowed = useMemo(() => {
    if (me.status !== 'ready') return { all: false, ids: [] as string[] };
    const limits: AllowedWorlds[] = [me.value.invite, ...(roleIds.length > 0 ? [me.value.give] : [])];
    return pickableWorlds(universeWorlds.map((world) => world.id), ...limits);
  }, [me, roleIds, universeWorlds]);

  // Administrator works in every world and can't be limited: picking it picks "All worlds", and it can't be picked
  // by someone who may not invite and give roles in every world.
  const adminIds = useMemo(() => (roles.status === 'ready' ? roles.value.list.filter((role) => isAdministrator(role.permissions)).map((role) => role.id) : []), [roles]);
  const adminPicked = roleIds.some((id) => adminIds.includes(id));
  const adminReach = me.status === 'ready' && pickableWorlds(universeWorlds.map((world) => world.id), me.value.invite, me.value.give).all;

  // What is picked, kept inside what is allowed: with nothing chosen yet, every world when that is allowed.
  const everyWorld = adminPicked || (all ?? allowed.all);
  const shownAll = everyWorld && allowed.all;
  const chosenWorlds = worldIds.filter((id) => allowed.ids.includes(id));
  const note = picked ? (picked.notes ? (picked.notes[chosenUniverse] ?? null) : (picked.note ?? null)) : null;
  const ready = !!picked && !sending && me.status === 'ready' && (shownAll || chosenWorlds.length > 0);

  function pick(candidate: Candidate, note: string) {
    setPicked({ userId: candidate.userId, name: candidate.name, woka: candidate.woka, note });
    setError(null);
  }

  async function send() {
    if (!picked || !ready) return;
    setSending(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`${base}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: picked.userId,
          roleIds,
          worlds: shownAll ? { allWorlds: true, worldIds: [] } : { allWorlds: false, worldIds: chosenWorlds },
          message: message.trim() || undefined,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Couldn’t send the invite. Try again.');
      }
      addToast({ description: `Invitation sent to ${picked.name}.`, variant: 'success' });
      onOpenChange(false);
      onSent?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t send the invite. Try again.');
      setSending(false);
    }
  }

  const first = picked?.name.trim().split(/\s+/)[0] ?? '';
  const title = picked ? (giving ? `Give ${first} membership` : `Invite ${first} to ${universeName}`) : `Invite to ${universeName}`;
  const toggleRole = (id: string) => {
    setRoleIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
    if (adminIds.includes(id)) setAll(null);
  };
  const everyWorldOnly = (id: string) => adminIds.includes(id) && !adminReach && !roleIds.includes(id);
  const toggleWorld = (id: string) => setWorldIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  const hasRoles = givable.builtIn.length + givable.custom.length > 0;

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={title}>
      {!picked ? (
        <>
          <label className="flex min-h-14 items-center gap-3 rounded-2xl border border-foreground/15 bg-background px-4 text-muted-foreground focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
            <Search aria-hidden="true" className="h-5 w-5 shrink-0" />
            <span className="sr-only">Search by name</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name"
              className="h-12 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
          {people.status === 'loading' && <div role="status" aria-label="Loading people" className="orbit-skeleton h-24 rounded-2xl" />}
          {people.status === 'error' && (
            <p role="alert" className="text-sm text-muted-foreground">
              We couldn’t load people. <button type="button" className="font-semibold underline" onClick={retryPeople}>Try again</button>
            </p>
          )}
          {people.status === 'ready' && (
            <div className="grid max-h-[46dvh] gap-4 overflow-y-auto">
              {searched.length >= 2 ? (
                <Group title={`People named “${searched}”`}>
                  {people.value.results.map((result) => (
                    <PersonRow
                      key={result.userId}
                      person={result}
                      note={[result.friend ? 'Your friend' : null, result.lastVisitedAt ? `Visited ${universeName} ${timeAgo(new Date(result.lastVisitedAt))}` : `Hasn’t visited ${universeName} yet`].filter(Boolean).join(' · ')}
                      onPick={() => pick(result, result.friend ? 'Your friend' : '')}
                    />
                  ))}
                  {people.value.results.length === 0 && <li className="py-2 text-sm text-muted-foreground" role="status">Nobody to invite is named that.</li>}
                </Group>
              ) : (
                <>
                  {people.value.visitors.length > 0 && (
                    <Group title={`Visited ${universeName} this week`}>
                      {people.value.visitors.map((visitor) => (
                        <PersonRow key={visitor.userId} person={visitor} note={visitorNote(visitor)} onPick={() => pick(visitor, visitorNote(visitor))} />
                      ))}
                    </Group>
                  )}
                  {people.value.friends.length > 0 && (
                    <Group title="Your friends">
                      {people.value.friends.map((friend) => {
                        const note = friend.lastVisitedAt ? `Visited ${universeName} ${timeAgo(new Date(friend.lastVisitedAt))}` : `Hasn’t visited ${universeName} yet`;
                        return <PersonRow key={friend.userId} person={friend} note={note} onPick={() => pick(friend, note)} />;
                      })}
                    </Group>
                  )}
                  {people.value.visitors.length === 0 && people.value.friends.length === 0 && (
                    <p className="text-sm text-muted-foreground" role="status">
                      Nobody visited this week, and none of your friends are left to invite. Search by name to find someone.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Anyone with an account can be invited, no email needed. Guests appear once they sign up. Members already in {universeName} aren’t listed.
          </p>
          <div className="flex justify-end">
            <Button variant="outline" className="h-11 px-5" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-2xl border border-foreground/[.12] p-3">
            <WokaAvatar layers={picked.woka ?? []} name={picked.name} size={40} tinted round />
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-[15px] font-bold">{picked.name}</strong>
              {note && <span className="block text-[13px] text-muted-foreground">{note}</span>}
            </span>
            {!given && (
              <Button variant="outline" className="h-11 px-4" onClick={() => setPicked(null)}>
                Change
              </Button>
            )}
          </div>

          {universes && universes.length > 1 && (
            <div role="group" aria-label="Invite to" className="flex flex-wrap gap-2">
              {universes.map((universe) => (
                <PickChip key={universe.id} picked={chosenUniverse === universe.id} disabled={!!universe.status} onClick={() => { setChosenUniverse(universe.id); setRoleIds([]); setAll(null); setWorldIds([]); }}>
                  {universe.name}
                  {universe.status && <span className="font-normal text-muted-foreground">{universe.status === 'member' ? 'Member' : 'Invited'}</span>}
                </PickChip>
              ))}
            </div>
          )}

          <section className="grid gap-2" aria-labelledby="invite-roles">
            <h3 id="invite-roles" className="text-[15px] font-bold">Roles</h3>
            <p className="text-sm text-muted-foreground">
              {hasRoles ? 'Everyone who joins is a Member. Pick more roles if you want; they add up.' : 'Everyone who joins is a Member.'}
            </p>
            {givable.builtIn.length > 0 && (
              <div className="grid gap-2" role="group" aria-label="Built in">
                <span className="text-[13px] font-semibold text-muted-foreground">Built in</span>
                <div className="flex flex-wrap gap-2">
                  {givable.builtIn.map((role) => (
                    <PickChip key={role.id} picked={roleIds.includes(role.id)} color={role.color} disabled={everyWorldOnly(role.id)} onClick={() => toggleRole(role.id)}>
                      {role.name}
                    </PickChip>
                  ))}
                </div>
              </div>
            )}
            {givable.custom.length > 0 && (
              <div className="grid gap-2" role="group" aria-label="Your roles">
                <span className="text-[13px] font-semibold text-muted-foreground">Your roles</span>
                <div className="flex flex-wrap gap-2">
                  {givable.custom.map((role) => (
                    <PickChip key={role.id} picked={roleIds.includes(role.id)} color={role.color} disabled={everyWorldOnly(role.id)} onClick={() => toggleRole(role.id)}>
                      {role.name}
                    </PickChip>
                  ))}
                </div>
              </div>
            )}
            {(adminPicked || [...givable.builtIn, ...givable.custom].some((role) => everyWorldOnly(role.id))) && (
              <p className="text-[13px] text-muted-foreground">Administrator works in every world</p>
            )}
          </section>

          <section className="grid gap-2" aria-labelledby="invite-where">
            <h3 id="invite-where" className="text-[15px] font-bold">Works in</h3>
            <Segmented
              aria-labelledby="invite-where"
              value={shownAll ? 'all' : 'some'}
              onChange={(value) => setAll(value === 'all')}
              options={[
                { value: 'all', label: 'All worlds', disabled: !allowed.all },
                { value: 'some', label: 'Some worlds', disabled: adminPicked },
              ]}
              className="justify-self-start"
            />
            {!shownAll && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Worlds">
                {universeWorlds.filter((world) => allowed.ids.includes(world.id)).map((world) => (
                  <PickChip key={world.id} picked={chosenWorlds.includes(world.id)} onClick={() => toggleWorld(world.id)}>
                    {world.name}
                  </PickChip>
                ))}
                {allowed.ids.length === 0 && me.status === 'ready' && <p className="text-sm text-muted-foreground">Needs Invite and remove people in a world.</p>}
              </div>
            )}
          </section>

          <label className="grid gap-1.5">
            <span className="text-[15px] font-bold">Message <span className="font-normal text-muted-foreground">· optional</span></span>
            <Textarea
              rows={1}
              value={message}
              maxLength={500}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Say why you’re inviting them"
              className="rounded-2xl"
            />
          </label>
          <p className="text-sm text-muted-foreground">They get it in Orbit and in the game, and join {universeName} once they accept.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" className="h-11 px-5" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="h-11 px-5" disabled={!ready} onClick={send}>
              {sending ? 'Sending…' : 'Send invite'}
            </Button>
          </div>
        </>
      )}
    </FormSheet>
  );
}
