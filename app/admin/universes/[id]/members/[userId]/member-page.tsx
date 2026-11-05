'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Crown, Lock, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { authenticatedFetch } from '@/lib/client-auth';
import { timeAgo } from '@/lib/time-ago';
import { cn } from '@/lib/utils';
import { whatMoves, ownerSinceLine } from '@/lib/ownership-text';
import { dayWord, isAdministrator, pickableWorlds, rolePickableWorlds, worldsLabel, type AllowedWorlds, type Worlds } from '@/lib/member-roles';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { PickChip, Segmented } from '@/components/ui/choice';
import { useToast } from '@/components/ui/toast';
import { InContext, LoadError, LoadingRows } from '../../../../components/ds';
import { WokaAvatar } from '../../../../components/profile-card';
import { FormSheet } from '../../../../components/form-sheet';
import { useUniverseBasics, useUniverseRoles, useWorldNames, type UniverseRole } from '../../../../components/universe-people';

interface MemberAnswer {
  member: {
    userId: string;
    name: string | null;
    email: string | null;
    joinedAt: string;
    /** Left out when you may not see who visited. */
    lastVisitedAt?: string | null;
    isOwner: boolean;
    woka?: string[];
    worlds: Worlds;
    roles: { roleId: string; allWorlds: boolean; worldIds: string[] }[];
  };
  can: { giveRoleIds: string[]; giveWorlds: AllowedWorlds; widen: boolean; remove: boolean };
  /** Passing the universe on (#820). */
  ownership?: {
    /** You may offer the universe to this person now. */
    canOffer: boolean;
    /** Set only when a super admin acts for the owner: the owner's name. */
    onBehalfOf: string | null;
    /** The offer that is waiting (shown to the owner and super admins only), and whether it is for this person. */
    waiting: { toUserId: string; toName: string | null; createdAt: string; toThem: boolean } | null;
    /** For the owner: when they got the universe and from whom (null for the person who created it). */
    since: string | null;
    from: string | null;
  };
}

/** What an answer without the ownership part (an older server) means: nothing to offer, nothing waiting. */
const NO_OWNERSHIP: NonNullable<MemberAnswer['ownership']> = { canOffer: false, onBehalfOf: null, waiting: null, since: null, from: null };

const PICKED = 'border-[rgba(167,139,250,.7)] bg-[rgba(134,41,252,.14)] shadow-[0_0_0_1px_rgba(167,139,250,.35),0_0_24px_-8px_rgba(134,41,252,.6)]';

function lastVisit(value: string | null): string {
  if (!value) return 'Hasn’t visited yet';
  const date = new Date(value);
  const day = dayWord(date);
  return `Last visit ${day === 'today' || day === 'yesterday' ? day : timeAgo(date)}`;
}

/** "Admin in HQ, Moderator and Accountant": what someone would lose, in a line. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A person in a universe: their roles, ticked as you tap, and, alone at the end, taking them out. */
export function MemberPage() {
  const { id, userId } = useParams<{ id: string; userId: string }>();
  const router = useRouter();
  const { addToast } = useToast();
  const basics = useUniverseBasics(id);
  const roles = useUniverseRoles(id);
  const worldNames = useWorldNames(basics);

  const [answer, setAnswer] = useState<MemberAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [held, setHeld] = useState<Map<string, Worlds>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  // Roles with a save on its way: shown as pending
  const [pending, setPending] = useState<Set<string>>(new Set());
  // What the server last accepted for each role, which a failed save goes back to
  const confirmed = useRef<Map<string, Worlds>>(new Map());
  // The newest change made to each role, and the save running for it; one request per role at a time, in order
  const revisions = useRef<Map<string, number>>(new Map());
  const queues = useRef<Map<string, Promise<void>>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  // Passing the universe on: the sheet, the name typed to confirm, and a request on its way
  const [offering, setOffering] = useState(false);
  const [typed, setTyped] = useState('');
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const response = await authenticatedFetch(`/api/admin/universes/${id}/members/${userId}`);
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as MemberAnswer;
      setAnswer(body);
      const given = new Map<string, Worlds>(body.member.roles.map((role) => [role.roleId, { allWorlds: role.allWorlds, worldIds: role.worldIds }]));
      confirmed.current = given;
      setHeld(new Map(given));
    } catch {
      setFailed(true);
    }
  }, [id, userId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    authenticatedFetch('/api/auth/me')
      .then(async (response) => (response.ok ? setViewerId((await response.json()).user?.id ?? null) : undefined))
      .catch(() => {});
  }, []);

  const universe = basics.status === 'ready' ? basics.value : null;
  const universeWorldIds = useMemo(() => universe?.worlds.map((world) => world.id) ?? [], [universe]);

  // Where this person is a member: only there can a role work, and only where you may give roles may you change it.
  const memberWorlds: AllowedWorlds = answer ? (answer.member.worlds.allWorlds ? 'all' : answer.member.worlds.worldIds) : [];
  const allowed = useMemo(
    () => rolePickableWorlds(universeWorldIds, memberWorlds, answer?.can.giveWorlds ?? [], answer?.can.widen ?? false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [universeWorldIds, answer],
  );
  // A role you tick starts in every world only where they already are in every world; widening someone is a tap on "All worlds"
  const startsAll = useMemo(
    () => pickableWorlds(universeWorldIds, memberWorlds, answer?.can.giveWorlds ?? []).all,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [universeWorldIds, answer],
  );
  const reach = memberWorlds === 'all' ? universeWorldIds : universeWorldIds.filter((worldId) => memberWorlds.includes(worldId));

  /**
   * Save one role as it is now (null takes it away). The page shows the change at once. Saves of the same role go one
   * at a time, in order, and each change gets a revision: an answer or a rollback only applies if no newer change was
   * made to that role since, so a late failure never undoes what was tapped after it.
   */
  function save(role: UniverseRole, next: Worlds | null) {
    const revision = (revisions.current.get(role.id) ?? 0) + 1;
    revisions.current.set(role.id, revision);
    const latest = () => revisions.current.get(role.id) === revision;
    setError(null);
    setHeld((current) => {
      const copy = new Map(current);
      if (next) copy.set(role.id, next);
      else copy.delete(role.id);
      return copy;
    });
    setPending((current) => new Set(current).add(role.id));
    setBusy((count) => count + 1);

    const run = async () => {
      try {
        const url = `/api/admin/universes/${id}/members/${userId}/roles/${role.id}`;
        const response = next
          ? await authenticatedFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
          : await authenticatedFetch(url, { method: 'DELETE' });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(typeof body.error === 'string' ? body.error : 'Couldn’t save that. Try again.');
        }
        if (next) confirmed.current.set(role.id, next);
        else confirmed.current.delete(role.id);
        // Saved in every world for someone limited to some: the server made them a member of every world, and the Member line follows
        if (next?.allWorlds) {
          setAnswer((current) => (current && !current.member.worlds.allWorlds ? { ...current, member: { ...current.member, worlds: { allWorlds: true, worldIds: [] } } } : current));
        }
      } catch (cause) {
        // Only the newest change goes back (to what the server last accepted); an older one is overtaken by it
        if (latest()) {
          const before = confirmed.current.get(role.id);
          setHeld((current) => {
            const copy = new Map(current);
            if (before) copy.set(role.id, before);
            else copy.delete(role.id);
            return copy;
          });
          setError(cause instanceof Error ? cause.message : 'Couldn’t save that. Try again.');
        }
      } finally {
        setBusy((count) => count - 1);
        if (latest()) {
          setPending((current) => {
            const copy = new Set(current);
            copy.delete(role.id);
            return copy;
          });
        }
      }
    };
    const after = queues.current.get(role.id) ?? Promise.resolve();
    queues.current.set(role.id, after.then(run));
  }

  function toggle(role: UniverseRole, on: boolean) {
    if (!on) return void save(role, null);
    // Administrator always works in every world, so it is only sent that way (the row is off when you can't give it there).
    // Any other role starts in every world when they are in every world, else in the worlds they are in that you may give it in.
    void save(role, isAdministrator(role.permissions) || startsAll ? { allWorlds: true, worldIds: [] } : { allWorlds: false, worldIds: allowed.ids });
  }

  function setWhere(role: UniverseRole, where: 'all' | 'some') {
    // Already there: nothing to save, and the worlds picked so far stay
    const current = held.get(role.id);
    if (current && current.allWorlds === (where === 'all')) return;
    if (where === 'all') return void save(role, { allWorlds: true, worldIds: [] });
    void save(role, { allWorlds: false, worldIds: allowed.ids.slice(0, 1) });
  }

  function toggleWorld(role: UniverseRole, worldId: string) {
    const current = held.get(role.id);
    if (!current || current.allWorlds) return;
    const has = current.worldIds.includes(worldId);
    if (has && current.worldIds.length === 1) {
      setError('Pick at least one world, or untick the role.');
      return;
    }
    void save(role, { allWorlds: false, worldIds: has ? current.worldIds.filter((value) => value !== worldId) : [...current.worldIds, worldId] });
  }

  async function remove() {
    if (removing) return;
    setRemoving(true);
    try {
      const response = await authenticatedFetch(`/api/admin/universes/${id}/members/${userId}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Couldn’t remove them. Try again.');
      }
      addToast({ description: `${answer?.member.name || 'They'} left ${universe?.name ?? 'the universe'}.`, variant: 'success' });
      // Someone who left no longer sees a private universe, so their way on is their own universes, not its Members page
      router.replace(viewerId !== null && viewerId === answer?.member.userId ? '/admin/universes' : `/admin/universes/${id}/members`);
    } catch (cause) {
      setConfirming(false);
      setError(cause instanceof Error ? cause.message : 'Couldn’t remove them. Try again.');
      setRemoving(false);
    }
  }

  async function offerOwnership() {
    if (offerBusy || !answer || !universe) return;
    setOfferBusy(true);
    setOfferError(null);
    try {
      const response = await authenticatedFetch(`/api/admin/universes/${id}/ownership-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: answer.member.userId, universeName: typed }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Couldn’t send the offer. Try again.');
      }
      setOffering(false);
      setTyped('');
      await load();
    } catch (cause) {
      setOfferError(cause instanceof Error ? cause.message : 'Couldn’t send the offer. Try again.');
    } finally {
      setOfferBusy(false);
    }
  }

  async function takeBackOffer() {
    if (offerBusy) return;
    setOfferBusy(true);
    setOfferError(null);
    try {
      const response = await authenticatedFetch(`/api/admin/universes/${id}/ownership-offer`, { method: 'DELETE' });
      // Already gone (they answered meanwhile): the page reloads to say how it stands
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Couldn’t take the offer back. Try again.');
      }
      await load();
    } catch (cause) {
      setOfferError(cause instanceof Error ? cause.message : 'Couldn’t take the offer back. Try again.');
    } finally {
      setOfferBusy(false);
    }
  }

  if (failed) return <LoadError label="this person" retry={() => void load()} />;
  if (basics.status === 'error' || roles.status === 'error') {
    return (
      <LoadError
        label={basics.status === 'error' ? 'this universe' : 'roles'}
        retry={() => {
          if (basics.status === 'error') basics.retry();
          if (roles.status === 'error') roles.retry();
        }}
      />
    );
  }
  if (!answer || !universe || roles.status !== 'ready') return <LoadingRows label="this person" rows={4} />;
  const { member, can } = answer;
  const ownership: NonNullable<MemberAnswer['ownership']> = answer.ownership ?? NO_OWNERSHIP;
  const name = member.name || member.email || 'Someone';
  const first = name.trim().split(/\s+/)[0];
  const isYou = viewerId === member.userId;
  const list = roles.value.list.filter((role) => role.key !== 'member' && role.key !== 'everyone');
  const builtIn = list.filter((role) => role.builtIn);
  const custom = list.filter((role) => !role.builtIn);
  const memberLine = `Everyone who joined · ${worldsLabel(member.worlds, worldNames) ?? 'All worlds'}`;

  const losing = [...held.entries()]
    .map(([roleId, scope]) => ({ role: roles.value.byId.get(roleId), scope }))
    .filter((entry): entry is { role: UniverseRole; scope: Worlds } => !!entry.role)
    .sort((a, b) => b.role.position - a.role.position)
    .map(({ role, scope }) => {
      const where = worldsLabel(scope, worldNames);
      return where ? `${role.name} in ${where.replace(/ only$/, '')}` : role.name;
    });

  // A function that draws, not a component: a component made inside would start over at every tap.
  function renderRole(role: UniverseRole) {
    const scope = held.get(role.id);
    const on = !!scope;
    const adminRole = isAdministrator(role.permissions);
    // Administrator can only be given in every world, so without that reach the row can't be turned on
    const everyWorldOnly = adminRole && !on && !allowed.all;
    // Where you may give roles is only worlds they aren't in: nothing to start the role in (widening is a tap on "All worlds", never a tick;
    // Administrator is the exception, it is every world by definition and is judged by everyWorldOnly)
    const nowhere = !on && !adminRole && !startsAll && allowed.ids.length === 0;
    const allowedRole = can.giveRoleIds.includes(role.id);
    const rowOff = !allowedRole || everyWorldOnly || nowhere;
    const inputId = `role-${role.id}`;
    return (
      <div key={role.id} aria-busy={pending.has(role.id)} className={cn('rounded-2xl border px-3.5 py-1 transition-[background-color,border-color,box-shadow]', on ? PICKED : 'border-foreground/[.08] bg-foreground/[.04]', rowOff && 'opacity-60', pending.has(role.id) && 'opacity-70')}>
        <div className="flex min-h-11 items-center gap-3">
          <Checkbox id={inputId} checked={on} disabled={rowOff} onCheckedChange={(value) => toggle(role, value === true)} />
          <label htmlFor={inputId} className={cn('flex min-h-11 flex-1 items-center gap-2 text-[15px]', on ? 'font-bold' : 'font-medium', !rowOff ? 'cursor-pointer' : 'cursor-not-allowed')}>
            <i aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: role.color }} />
            {role.name}
          </label>
        </div>
        {allowedRole && (everyWorldOnly || nowhere) && (
          <p className="pb-2.5 pl-8 text-[13px] text-muted-foreground">{everyWorldOnly ? 'Administrator works in every world' : 'You can give roles only in worlds they’re not in'}</p>
        )}
        {on && scope && (
          <div className="grid gap-2.5 pb-3 pl-8">
            <span id={`${inputId}-works`} className="text-[13px] font-semibold text-muted-foreground">Works in</span>
            <Segmented
              aria-labelledby={`${inputId}-works`}
              value={scope.allWorlds ? 'all' : 'some'}
              onChange={(value) => setWhere(role, value)}
              options={[
                // Yours to give but not in every world: locked, and a tap says why (a role that isn't yours to give is off as a whole row)
                {
                  value: 'all',
                  label: allowedRole && !allowed.all ? <><Lock aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />All worlds</> : 'All worlds',
                  disabled: !allowedRole || !allowed.all,
                  onBlocked: allowedRole ? () => addToast({ description: can.giveWorlds === 'all' ? 'You can add people to some worlds only' : 'You can give roles in some worlds only' }) : undefined,
                },
                { value: 'some', label: 'Some worlds', disabled: !allowedRole || adminRole },
              ]}
              className="justify-self-start"
            />
            {!scope.allWorlds && (
              <div role="group" aria-label={`Worlds ${role.name} works in`} className="flex flex-wrap gap-2">
                {reach.map((worldId) => (
                  <PickChip
                    key={worldId}
                    picked={scope.worldIds.includes(worldId)}
                    disabled={!allowedRole || !allowed.ids.includes(worldId)}
                    onClick={() => toggleWorld(role, worldId)}
                  >
                    {worldNames.get(worldId) ?? 'A world'}
                  </PickChip>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-6">
      <header className="grid gap-3">
        <div className="flex items-center gap-4">
          <WokaAvatar layers={member.woka ?? []} name={name} size={64} tinted round />
          <div className="min-w-0">
            <h1 className="orbit-display text-[32px] font-bold leading-tight [overflow-wrap:anywhere]">{name}</h1>
            <InContext
              parts={[
                { label: universe.name, href: `/admin/universes/${id}` },
                { label: 'Members', href: `/admin/universes/${id}/members` },
              ]}
            />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {[member.email, `Joined ${new Date(member.joinedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`, member.lastVisitedAt === undefined ? null : lastVisit(member.lastVisitedAt)].filter(Boolean).join(' · ')}
        </p>
      </header>

      {member.isOwner ? (
        <section className="grid gap-3" aria-labelledby="member-roles" data-testid="owner-roles">
          <h2 id="member-roles" className="orbit-display text-lg font-bold">Roles</h2>
          <div className="grid gap-2">
            <div className="flex min-h-12 items-center gap-3 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 py-2">
              <Crown aria-hidden="true" className="h-4 w-4 shrink-0 text-[#FACC15]" />
              <span className="text-[15px] font-semibold">Owner</span>
              <span className="ml-auto text-right text-[13px] text-muted-foreground">
                {ownerSinceLine({ universeName: universe.name, isYou, since: ownership.since, from: ownership.from, day: dayWord })}
              </span>
            </div>
            {member.roles.filter((given) => roles.value.byId.has(given.roleId)).map((given) => {
              const info = roles.value.byId.get(given.roleId)!;
              return (
                <div key={given.roleId} className="flex min-h-12 items-center gap-3 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 py-2">
                  <i aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: info.color }} />
                  <span className="text-[15px] font-medium">{info.name}</span>
                  <span className="ml-auto text-right text-[13px] text-muted-foreground">{worldsLabel(given, worldNames) ?? 'All worlds'}</span>
                </div>
              );
            })}
            <div className="flex min-h-12 items-center gap-3 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 py-2 text-muted-foreground">
              <Lock aria-hidden="true" className="h-4 w-4 shrink-0" />
              <i aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: roles.value.list.find((role) => role.key === 'member')?.color ?? '#A78BFA' }} />
              <span className="text-[15px] font-medium">Member</span>
              <span className="ml-auto text-right text-[13px]">Everyone who joined</span>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {ownership.since
              ? `Owning ${universe.name} gives every permission in Orbit. Admin in every world came with it, so the game gives the same.`
              : 'The owner has every permission in every world, so roles add nothing here.'}
          </p>
        </section>
      ) : (
        <section className="grid gap-3" aria-labelledby="member-roles">
          <h2 id="member-roles" className="orbit-display text-lg font-bold">Roles</h2>
          <div className="grid gap-2" role="group" aria-label="Built in">
            <span className="text-[13px] font-semibold text-muted-foreground">Built in</span>
            <div className="flex min-h-12 items-center gap-3 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 py-2 text-muted-foreground" data-testid="member-base">
              <Lock aria-hidden="true" className="h-4 w-4 shrink-0" />
              <i aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: roles.value.list.find((role) => role.key === 'member')?.color ?? '#A78BFA' }} />
              <span className="text-[15px] font-medium">Member</span>
              <span className="ml-auto text-right text-[13px]">{memberLine}</span>
            </div>
            {builtIn.map(renderRole)}
          </div>
          {custom.length > 0 && (
            <div className="grid gap-2" role="group" aria-label="Your roles">
              <span className="text-[13px] font-semibold text-muted-foreground">Your roles</span>
              {custom.map(renderRole)}
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Everyone who joins is a Member. Roles add up on top. Changes save as you tap, and you can give only the roles below your own.
            {busy > 0 && ' Saving…'}
          </p>
        </section>
      )}

      {(can.remove || ownership.canOffer || ownership.waiting) && (
        <section className="grid gap-3 border-t border-foreground/10 pt-6" aria-labelledby="member-danger">
          <h2 id="member-danger" className="orbit-display text-lg font-bold text-[#fca5a5]">Danger zone</h2>
          {ownership.canOffer && (
            <div data-testid="make-owner" className="flex flex-col items-start gap-3 rounded-2xl border border-[rgba(248,113,113,.4)] bg-foreground/[.03] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <strong className="block text-[17px]">Make {name} the owner</strong>
                <p className="mt-1 text-sm text-muted-foreground">
                  {name} gets the whole universe, every world and room in it, once they accept. {ownership.onBehalfOf ? `${ownership.onBehalfOf} stays` : 'You stay'} as Admin.
                </p>
              </div>
              <Button
                variant="outline"
                className="h-11 border-[rgba(248,113,113,.4)] px-5 text-[#fca5a5] hover:text-[#fca5a5]"
                onClick={() => {
                  setOfferError(null);
                  setTyped('');
                  setOffering(true);
                }}
              >
                <Crown aria-hidden="true" />
                Make owner
              </Button>
            </div>
          )}
          {ownership.waiting?.toThem && (
            <div data-testid="offer-waiting" className={cn('flex flex-col items-start gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between', PICKED)}>
              <div className="min-w-0 flex-1">
                <strong className="block text-[17px]">Waiting for {name} to accept</strong>
                <p className="mt-1 text-sm text-muted-foreground">
                  {ownership.onBehalfOf ? `${universe.name} was offered to ${name}` : `You offered ${name} ${universe.name}`} {dayWord(new Date(ownership.waiting.createdAt))}. Nothing changes until they accept. It waits until they answer or you take it back.
                </p>
              </div>
              <Button variant="outline" className="h-11 px-5" disabled={offerBusy} onClick={() => void takeBackOffer()}>
                Take back the offer
              </Button>
            </div>
          )}
          {ownership.waiting && !ownership.waiting.toThem && (
            <div data-testid="offer-elsewhere" className="flex flex-col items-start gap-3 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <strong className="block text-[17px]">An offer is waiting for {ownership.waiting.toName || 'someone else'}</strong>
                <p className="mt-1 text-sm text-muted-foreground">Only one offer waits at a time. Take it back first to offer {universe.name} to {name}.</p>
              </div>
              <Button variant="outline" className="h-11 px-5" onClick={() => router.push(`/admin/universes/${id}/members/${ownership.waiting!.toUserId}`)}>
                See the offer
              </Button>
            </div>
          )}
          {offerError && !offering && <p role="alert" className="text-sm text-destructive">{offerError}</p>}
          {can.remove && (
            <div className="flex flex-col items-start gap-3 rounded-2xl border border-[rgba(248,113,113,.4)] sm:flex-row sm:items-center sm:justify-between bg-foreground/[.03] p-4">
              <div className="min-w-0 flex-1">
                <strong className="block text-[17px]">{isYou ? `Leave ${universe.name}` : `Remove from ${universe.name}`}</strong>
                <p className="mt-1 text-sm text-muted-foreground">
                  {isYou ? 'You lose every role and can’t come back in until someone invites you again.' : `${first} loses every role and can’t come back in until someone invites them again.`}
                </p>
              </div>
              <Button variant="outline" className="h-11 border-[rgba(248,113,113,.4)] px-5 text-[#fca5a5] hover:text-[#fca5a5]" onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden="true" />
                {isYou ? 'Leave' : 'Remove'}
              </Button>
            </div>
          )}
        </section>
      )}

      <FormSheet open={offering} onOpenChange={setOffering} title={`Make ${name} the owner of ${universe.name}?`}>
        <ul className="grid gap-2.5 text-sm text-muted-foreground" data-testid="offer-sheet">
          <li><strong className="text-foreground">The whole universe moves:</strong> all of {universe.name}, with {whatMoves(universe.worlds.map((world) => world.name))}. A world or room can’t be passed on its own.</li>
          <li><strong className="text-foreground">{name}</strong> gets every permission in {universe.name}, and Admin in every world so the game gives the same.</li>
          <li><strong className="text-foreground">{ownership.onBehalfOf ? `${ownership.onBehalfOf} stays` : 'You stay'} as Admin</strong> in every world. {name} will rank above {ownership.onBehalfOf ? 'them' : 'you'} and can change that.</li>
          <li><strong className="text-foreground">Bots and AI keys stay with their people</strong> and keep running while {ownership.onBehalfOf ? 'the old owner is' : 'you’re'} Admin. Artifacts stay with the people who asked for them.</li>
          <li><strong className="text-foreground">{name} has to accept.</strong> Until then nothing changes, and the offer can be taken back.</li>
        </ul>
        <label className="grid gap-2 text-sm">
          <span>Type <strong className="text-foreground">{universe.name}</strong> to confirm</span>
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} className="h-11" autoComplete="off" />
        </label>
        {offerError && <p role="alert" className="text-sm text-destructive">{offerError}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-11 px-5" onClick={() => setOffering(false)}>
            Cancel
          </Button>
          <Button variant="destructive" className="h-11 px-5" disabled={typed !== universe.name || offerBusy} onClick={() => void offerOwnership()}>
            {offerBusy ? 'Sending…' : 'Offer ownership'}
          </Button>
        </div>
      </FormSheet>

      <FormSheet open={confirming} onOpenChange={setConfirming} title={isYou ? `Leave ${universe.name}?` : `Remove ${name} from ${universe.name}?`}>
        <p className="text-sm text-muted-foreground">
          {losing.length > 0
            ? `${isYou ? 'You lose' : 'They lose'} ${listOf(losing)} and every room ${losing.length > 1 ? 'they open' : 'it opens'}.`
            : `${isYou ? 'You lose' : 'They lose'} the member-only rooms of ${universe.name}.`}{' '}
          {isYou ? 'Someone has to invite you again to come back.' : 'You can invite them again later.'}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-11 px-5" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="destructive" className="h-11 px-5" disabled={removing} onClick={() => void remove()}>
            {removing ? 'Removing…' : isYou ? 'Leave' : 'Remove'}
          </Button>
        </div>
      </FormSheet>
    </div>
  );
}
