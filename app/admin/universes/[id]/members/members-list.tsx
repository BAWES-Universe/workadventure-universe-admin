'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Shield, UserPlus } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { dayWord, summariseRoles, type MemberRoles, type Worlds } from '@/lib/member-roles';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { EmptyCard, EntityRow, InContext, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine } from '../../../components/ds';
import { WokaAvatar } from '../../../components/profile-card';
import InviteSheet from '../../../components/invite-sheet';
import { RoleSummaryPills, useJson, useUniverseBasics, useUniverseRoles, useWorldNames, type UniverseRole } from '../../../components/universe-people';
import { SearchBox } from '../../../discover/discover-ui';

interface Member {
  userId: string;
  name: string | null;
  email: string | null;
  joinedAt: string;
  isOwner: boolean;
  woka?: string[];
  worlds: Worlds;
  roles: { roleId: string; allWorlds: boolean; worldIds: string[] }[];
}

interface Owner {
  userId: string;
  name: string | null;
  email: string | null;
  woka: string[];
  joinedAt: string | null;
  joined: boolean;
}

interface Invitation {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  woka?: string[];
  invitedBy: { userId: string; name: string | null };
  invitedAt: string;
  roleIds: string[];
  worlds: Worlds;
}

interface Page {
  members: Member[];
  total: number;
  owner: Owner | null;
  nextCursor: string | null;
}

const ANY = 'any';
/** The list starts with this many rows; the rest is one tap away. */
const FIRST = 8;
const joinedIn = (value: string | null) => (value ? `Joined ${new Date(value).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : null);

/** The pill-shaped drop-down of the filter row: 44px, like every control. */
function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-11 w-auto min-w-0 gap-2 rounded-full border-foreground/15 bg-transparent px-4 text-sm font-semibold">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

/** Everyone in a universe on one page: search, a world filter and a role filter. Tap a row to open the person. */
export function UniverseMembersPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const { addToast } = useToast();
  const basics = useUniverseBasics(id);
  const roles = useUniverseRoles(id);
  const worldNames = useWorldNames(basics);
  const [me] = useJson<{ invite: 'all' | string[] }>(`/api/admin/universes/${id}/me`, (body) => ({ invite: body.inviteWorlds ?? [] }));

  const [input, setInput] = useState(params?.get('q') ?? '');
  const [query, setQuery] = useState(input.trim());
  const [worldId, setWorldId] = useState(params?.get('world') ?? ANY);
  const [roleId, setRoleId] = useState(params?.get('role') ?? ANY);
  const [page, setPage] = useState<Page | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState<'idle' | 'busy'>('idle');
  const [visible, setVisible] = useState(FIRST);
  const [attempt, setAttempt] = useState(0);
  const [inviting, setInviting] = useState(false);
  const [invitations, setInvitations] = useState<{ list: Invitation[]; canCancel: boolean } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const listPath = useCallback(
    (cursor?: string | null) => {
      // People with roles come first, then the newest
      const search = new URLSearchParams({ order: 'roles' });
      if (query) search.set('q', query);
      if (worldId !== ANY) search.set('worldId', worldId);
      if (roleId !== ANY) search.set('roleId', roleId);
      if (cursor) search.set('cursor', cursor);
      return `/api/admin/universes/${id}/members?${search.toString()}`;
    },
    [id, query, worldId, roleId],
  );

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setVisible(FIRST);
    authenticatedFetch(listPath())
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as Page;
        if (!cancelled) setPage(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [listPath, attempt]);

  const loadInvitations = useCallback(() => {
    authenticatedFetch(`/api/admin/universes/${id}/invitations`)
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json();
        setInvitations({ list: body.invitations ?? [], canCancel: !!body.canCancel });
      })
      .catch(() => {});
  }, [id]);
  useEffect(loadInvitations, [loadInvitations, attempt]);

  async function showMore() {
    if (!page || more === 'busy') return;
    setVisible(Number.MAX_SAFE_INTEGER);
    if (!page.nextCursor) return;
    setMore('busy');
    try {
      const response = await authenticatedFetch(listPath(page.nextCursor));
      if (!response.ok) throw new Error('more');
      const next = (await response.json()) as Page;
      setPage({ ...next, members: [...page.members, ...next.members] });
    } catch {
      addToast({ description: 'Couldn’t load more people. Try again.', variant: 'error' });
    } finally {
      setMore('idle');
    }
  }

  async function cancelInvite(invitation: Invitation) {
    if (cancelling) return;
    setCancelling(invitation.id);
    try {
      const response = await authenticatedFetch(`/api/admin/universes/${id}/invitations/${invitation.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Couldn’t cancel the invite.');
      }
      loadInvitations();
    } catch (cause) {
      addToast({ description: cause instanceof Error ? cause.message : 'Couldn’t cancel the invite.', variant: 'error' });
    } finally {
      setCancelling(null);
    }
  }

  const rolesById = useMemo(() => (roles.status === 'ready' ? roles.value.byId : new Map<string, UniverseRole>()), [roles]);
  const universeName = basics.status === 'ready' ? basics.value.name : '';
  const filtered = query !== '' || worldId !== ANY || roleId !== ANY;
  const canInvite = me.status === 'ready' && (me.value.invite === 'all' || me.value.invite.length > 0);

  // The owner has everything whether or not they joined, so they come first (not under a role filter, or a search that misses them).
  const owner = page?.owner ?? null;
  const ownerShown =
    !!owner && roleId === ANY && (!query || [owner.name, owner.email].some((text) => text?.toLowerCase().includes(query.toLowerCase())));
  const rows: Member[] = useMemo(() => {
    if (!page) return [];
    // The highest roles first; people with the same rank stay as the list gave them (newest first)
    const rank = (member: Member) => Math.max(0, ...member.roles.map((given) => rolesById.get(given.roleId)?.position ?? 0));
    const others = page.members.filter((member) => !member.isOwner).sort((a, b) => rank(b) - rank(a));
    if (!ownerShown || !owner) return others;
    const joinedRow = page.members.find((member) => member.isOwner);
    const row: Member = joinedRow ?? { userId: owner.userId, name: owner.name, email: owner.email, joinedAt: owner.joinedAt ?? '', isOwner: true, woka: owner.woka, worlds: { allWorlds: true, worldIds: [] }, roles: [] };
    return [{ ...row, woka: row.woka ?? owner.woka }, ...others];
  }, [page, owner, ownerShown, rolesById]);
  const total = page ? page.total + (owner && !owner.joined && ownerShown ? 1 : 0) : null;
  const remaining = page ? Math.max(0, (total ?? 0) - Math.min(rows.length, visible)) : 0;

  const ready = basics.status === 'ready' && roles.status === 'ready';

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        kind="people"
        title="Members"
        context={
          <>
            {universeName && <InContext parts={[{ label: universeName, href: `/admin/universes/${id}`, kind: 'universe' }]} />}
            {total !== null && <span> · {total.toLocaleString()} {total === 1 ? 'person' : 'people'}</span>}
          </>
        }
        actions={
          <>
            {canInvite && (
              <Button className="h-11 px-5" onClick={() => setInviting(true)}>
                <UserPlus aria-hidden="true" />
                Invite member
              </Button>
            )}
            <Button asChild variant="outline" className="h-11 px-5">
              <Link href={`/admin/universes/${id}/roles`}>
                <Shield aria-hidden="true" />
                Roles & permissions
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid min-w-0 gap-3">
        <SearchBox
          value={input}
          onChange={setInput}
          onSubmit={() => setQuery(input.trim())}
          onClear={() => {
            setInput('');
            setQuery('');
          }}
          showClear={query !== ''}
          label="Search members"
          placeholder="Search members"
        />
        <div className="flex flex-wrap gap-2">
          <FilterSelect label="World" value={worldId} onChange={setWorldId}>
            <SelectItem value={ANY} className="min-h-11">All worlds</SelectItem>
            {basics.status === 'ready' && basics.value.worlds.map((world) => (
              <SelectItem key={world.id} value={world.id} className="min-h-11">{world.name}</SelectItem>
            ))}
          </FilterSelect>
          <FilterSelect label="Role" value={roleId} onChange={setRoleId}>
            <SelectItem value={ANY} className="min-h-11">Any role</SelectItem>
            {roles.status === 'ready' && roles.value.list.filter((role) => role.key !== 'member' && role.key !== 'everyone').map((role) => (
              <SelectItem key={role.id} value={role.id} className="min-h-11">{role.name}</SelectItem>
            ))}
          </FilterSelect>
        </div>
      </div>

      {failed ? (
        <LoadError label="members" retry={() => setAttempt((value) => value + 1)} />
      ) : !page || !ready ? (
        <LoadingRows label="members" rows={4} />
      ) : rows.length === 0 ? (
        filtered ? (
          <p className="text-sm text-muted-foreground" role="status">Nobody matches.</p>
        ) : (
          <EmptyCard kind="people" title="Nobody has joined yet." text="Invite people to give them a role." />
        )
      ) : (
        <div className="grid min-w-0 gap-0.5" data-testid="members">
          {rows.slice(0, visible).map((member) => {
            const name = member.name || member.email || 'Someone';
            const summary = summariseRoles(member as MemberRoles, rolesById, worldNames);
            return (
              <EntityRow
                key={member.userId}
                href={`/admin/universes/${id}/members/${member.userId}`}
                kind="people"
                leading={<WokaAvatar layers={member.woka ?? []} name={name} size={44} tinted round />}
                title={name}
                context={<StatLine items={[member.name ? member.email : null, joinedIn(member.joinedAt)]} />}
                meta={<RoleSummaryPills summary={summary} />}
              />
            );
          })}
          {remaining > 0 && (
            <div>
              <Button variant="outline" className="h-11 px-5" disabled={more === 'busy'} onClick={showMore}>
                Show {remaining} more
              </Button>
            </div>
          )}
        </div>
      )}

      {invitations && invitations.list.length > 0 && (
        <section className="grid min-w-0 gap-2" aria-labelledby="pending-invitations">
          <SectionHeader id="pending-invitations" title="Pending invitations" count={invitations.list.length} />
          <div className="grid min-w-0 gap-0.5">
            {invitations.list.map((invitation) => {
              const name = invitation.name || invitation.email || 'Someone';
              const held = invitation.roleIds
                .filter((roleId) => rolesById.has(roleId))
                .sort((a, b) => (rolesById.get(b)?.position ?? 0) - (rolesById.get(a)?.position ?? 0))
                .map((roleId) => ({ roleId, ...invitation.worlds }));
              const summary = summariseRoles({ isOwner: false, worlds: invitation.worlds, roles: held }, rolesById, worldNames);
              return (
                <EntityRow
                  key={invitation.id}
                  href={`/admin/users/${invitation.userId}`}
                  kind="people"
                  leading={<WokaAvatar layers={invitation.woka ?? []} name={name} size={44} tinted round />}
                  title={name}
                  context={<StatLine items={[`Invited by ${invitation.invitedBy.name || 'someone'}`, dayWord(new Date(invitation.invitedAt))]} />}
                  meta={<RoleSummaryPills summary={summary} />}
                  trailing={
                    invitations.canCancel ? (
                      <Button variant="outline" className="h-11 px-4" disabled={cancelling === invitation.id} onClick={() => void cancelInvite(invitation)}>
                        Cancel invite
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        </section>
      )}

      <InviteSheet open={inviting} onOpenChange={setInviting} universeId={id} onSent={loadInvitations} />
    </div>
  );
}
