'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { PickCard, PickChip, RolePill, Segmented } from '@/components/ui/choice';
import { useToast } from '@/components/ui/toast';
import { flag } from '@/lib/permissions';
import { LoadError, LoadingRows } from '../ds';
import { PersonIcon } from '../profile-card';
import { Panel } from './role-bits';
import { SHEET_CLASS } from './create-role-sheet';
import { canGiveRole, permissionsOf, scopeLabel, seesHiddenRoles, type MeResponse, type RoleRow, type WorldRef } from '@/lib/role-ui';

interface MemberRow {
  userId: string;
  name: string | null;
  woka?: string[];
  worlds: { allWorlds: boolean; worldIds: string[] };
  roles: { roleId: string; allWorlds: boolean; worldIds: string[] }[];
}

interface MembersPage {
  members: MemberRow[];
  total: number;
  nextCursor: string | null;
}

async function loadMembers(universeId: string, query: URLSearchParams): Promise<MembersPage> {
  const { authenticatedFetch } = await import('@/lib/client-auth');
  const response = await authenticatedFetch(`/api/admin/universes/${universeId}/members?${query.toString()}`);
  if (!response.ok) throw new Error('Could not load people');
  return response.json();
}

/** Who has the role and where. People are opened on the Members pages; "Give to someone" adds one here. */
export function MembersTab({
  role,
  universeId,
  worlds,
  me,
  onChanged,
}: {
  role: RoleRow;
  universeId: string;
  worlds: WorldRef[];
  me: MeResponse;
  /** The people count changed, so the role's numbers are stale. */
  onChanged: () => void;
}) {
  const [page, setPage] = useState<MembersPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [giving, setGiving] = useState(false);
  const isMember = role.builtIn && role.key === 'member';
  const mayGive = canGiveRole(role, me);
  // A role with its badge off doesn't say who has it to people who neither give nor manage roles
  const hiddenFromYou = !isMember && !role.showBadge && !seesHiddenRoles(me);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setPage(await loadMembers(universeId, new URLSearchParams({ roleId: role.id })));
    } catch {
      setFailed(true);
    }
  }, [universeId, role.id]);

  useEffect(() => {
    if (!isMember && !hiddenFromYou) void load();
  }, [isMember, hiddenFromYou, load]);

  const peopleHref = `/admin/universes/${universeId}/members`;

  if (hiddenFromYou) {
    return (
      <Panel className="grid gap-3 p-5">
        <h2 className="orbit-display text-lg font-bold">Who has it</h2>
        <p className="text-sm text-muted-foreground">Only people who give or manage roles see who has this role.</p>
      </Panel>
    );
  }

  if (isMember) {
    return (
      <Panel className="grid gap-3 p-5">
        <h2 className="orbit-display text-lg font-bold">Who has it</h2>
        <p className="text-sm text-muted-foreground">
          Everyone who joined has Member, in the worlds they joined. Nobody gives it and nobody takes it away.
        </p>
        <p className="text-sm font-semibold">{role.people?.toLocaleString() ?? 0} {role.people === 1 ? 'person' : 'people'}</p>
        <div>
          <Button asChild variant="outline" className="h-11 px-5">
            <Link href={peopleHref}>See everyone</Link>
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel className="grid gap-4 p-5">
      <div className="grid gap-1.5">
        <h2 className="orbit-display text-lg font-bold">Who has it</h2>
        <p className="text-sm text-muted-foreground">Each person can have it everywhere or only in some worlds.</p>
      </div>

      {failed ? (
        <LoadError label="the people" retry={() => void load()} />
      ) : !page ? (
        <LoadingRows label="people" rows={2} />
      ) : page.members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one has it yet.</p>
      ) : (
        <ul className="grid gap-1" aria-label={`People with ${role.name}`}>
          {page.members.map((member) => {
            const given = member.roles.find((item) => item.roleId === role.id);
            return (
              <li key={member.userId}>
                <Link
                  href={`/admin/universes/${universeId}/members/${member.userId}`}
                  className="flex min-h-14 items-center gap-3 rounded-2xl px-1 py-1.5 hover:bg-foreground/5"
                >
                  <PersonIcon woka={member.woka} name={member.name} face />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{member.name ?? 'Someone'}</span>
                  {given && <RolePill name={scopeLabel(given, worlds)} />}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {page?.nextCursor && (
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={more}
          onClick={async () => {
            setMore(true);
            try {
              const next = await loadMembers(universeId, new URLSearchParams({ roleId: role.id, cursor: page.nextCursor as string }));
              setPage({ ...next, members: [...page.members, ...next.members] });
            } catch {
              setFailed(true);
            } finally {
              setMore(false);
            }
          }}
        >
          {more && <Loader2 className="animate-spin" aria-hidden="true" />}
          Show more
        </Button>
      )}

      {mayGive ? (
        <Button type="button" variant="outline" className="h-12 text-[15px]" onClick={() => setGiving(true)}>
          <Plus aria-hidden="true" />
          Give to someone
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {me.giveWorlds !== 'all' && me.giveWorlds.length === 0 ? 'Needs Give roles to give this role.' : `Needs a role above ${role.name} to give it.`}
        </p>
      )}

      <GiveSheet
        open={giving}
        onOpenChange={setGiving}
        role={role}
        universeId={universeId}
        worlds={worlds}
        giveWorlds={me.giveWorlds}
        onGiven={() => {
          setGiving(false);
          void load();
          onChanged();
        }}
      />
    </Panel>
  );
}

/** Pick someone who joined, and where the role works for them. Cancel is the one way out. */
function GiveSheet({
  open,
  onOpenChange,
  role,
  universeId,
  worlds,
  giveWorlds,
  onGiven,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: RoleRow;
  universeId: string;
  worlds: WorldRef[];
  giveWorlds: 'all' | string[];
  onGiven: () => void;
}) {
  const { addToast } = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberRow[] | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const administrator = (permissionsOf(role) & flag('ADMINISTRATOR')) !== BigInt(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults(null);
      setPersonId(null);
      setScope('all');
      setPicked([]);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const page = await loadMembers(universeId, new URLSearchParams(query.trim() ? { q: query.trim() } : {}));
        if (current) setResults(page.members.filter((member) => !member.roles.some((given) => given.roleId === role.id)));
      } catch {
        if (current) setResults([]);
      }
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query, universeId, role.id]);

  const person = results?.find((member) => member.userId === personId) ?? null;
  // A role works only where the person is a member, and only where you may give roles
  const theirWorlds = person ? (person.worlds.allWorlds ? worlds.map((world) => world.id) : person.worlds.worldIds) : [];
  const available = worlds.filter((world) => theirWorlds.includes(world.id) && (giveWorlds === 'all' || giveWorlds.includes(world.id)));
  const allowAll = !!person && person.worlds.allWorlds && giveWorlds === 'all';
  const allowSome = !administrator && available.length > 0;
  const ready = !!person && (scope === 'all' ? allowAll : allowSome && picked.length > 0);

  function choose(member: MemberRow) {
    setPersonId(member.userId);
    const everywhere = member.worlds.allWorlds && giveWorlds === 'all';
    setScope(everywhere || administrator ? 'all' : 'some');
    setPicked([]);
  }

  async function give() {
    if (!person || !ready || busy) return;
    setBusy(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${universeId}/members/${person.userId}/roles/${role.id}`, {
        method: 'PUT',
        body: JSON.stringify(scope === 'all' ? { allWorlds: true, worldIds: [] } : { allWorlds: false, worldIds: picked }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'That didn’t work. Try again.');
      addToast({ description: `${person.name ?? 'They'} now ${person.name ? 'has' : 'have'} ${role.name}`, variant: 'success' });
      onGiven();
    } catch (failure) {
      addToast({ description: failure instanceof Error ? failure.message : 'That didn’t work. Try again.', variant: 'error' });
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className={SHEET_CLASS} data-testid="give-role-sheet">
        <DialogTitle className="orbit-display text-2xl font-bold">Give {role.name}</DialogTitle>
        <DialogDescription className="sr-only">Pick someone who joined, then where the role works for them.</DialogDescription>
        <div className="grid gap-5">
          <div className="grid gap-2">
            <label htmlFor="give-search" className="text-sm font-semibold">
              Who
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="give-search"
                type="search"
                value={query}
                autoComplete="off"
                placeholder="Search people who joined"
                className="h-12 rounded-2xl pl-11 text-base"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {results === null ? (
              <LoadingRows label="people" rows={2} />
            ) : results.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one else to give it to.</p>
            ) : (
              <div role="radiogroup" aria-label="Person" className="grid max-h-60 gap-2 overflow-y-auto">
                {results.map((member) => (
                  <PickCard
                    key={member.userId}
                    role="radio"
                    picked={personId === member.userId}
                    onClick={() => choose(member)}
                    title={member.name ?? 'Someone'}
                    indicator={<PersonIcon woka={member.woka} name={member.name} size={32} face />}
                  />
                ))}
              </div>
            )}
          </div>

          {person && (
            <div className="grid gap-3">
              <span id="give-works-in" className="text-sm font-semibold">
                Works in
              </span>
              <Segmented
                aria-labelledby="give-works-in"
                value={scope}
                onChange={(next) => {
                  setScope(next);
                  setPicked([]);
                }}
                options={[
                  { value: 'all', label: 'All worlds', disabled: !allowAll },
                  { value: 'some', label: 'Some worlds', disabled: !allowSome },
                ]}
              />
              {scope === 'some' && (
                <div role="group" aria-label="Worlds" className="flex flex-wrap gap-2">
                  {available.map((world) => (
                    <PickChip
                      key={world.id}
                      picked={picked.includes(world.id)}
                      onClick={() => setPicked((current) => (current.includes(world.id) ? current.filter((id) => id !== world.id) : [...current, world.id]))}
                    >
                      {world.name}
                    </PickChip>
                  ))}
                </div>
              )}
              {!allowAll && (
                <p className="text-xs text-muted-foreground">
                  {administrator
                    ? 'Administrator works in every world, and they have not joined every world.'
                    : giveWorlds !== 'all'
                      ? 'Needs Give roles in every world to give it everywhere.'
                      : 'They have not joined every world, so it can work only in the ones they have.'}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" className="h-11 px-6" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" className="h-11 px-6" disabled={!ready || busy} onClick={() => void give()}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Give role
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
