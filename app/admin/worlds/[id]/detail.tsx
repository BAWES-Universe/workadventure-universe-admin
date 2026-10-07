'use client';

import { useIsSuperAdmin } from '../../admin-bootstrap-context';

import { Suspense, useState, useEffect, useMemo } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, Pencil, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { timeAgo } from '@/lib/time-ago';
import { activityStats } from '@/lib/analytics-peak';
import { EmptyCard, EntityCard, EntityRow, Figure, Figures, InContext, LoadError, LoadingRows, PageHeader, RolePills, SectionHeader, SettingSwitch, Settings, StatLine, StatusPill, VisitLine } from '../../components/ds';
import InviteMemberDialog from '../../components/invite-member-dialog';
import MemberList from '../../components/member-list';
import MembersRow from '../../components/members-row';
import { AddButton, Crumb, PlaceHero, RoomRows, SectionHead, StarButton, VisitButton, playPathOf, type RoomRowData } from '../../components/place-hero';
import WorldSafety, { useWorldSafety, waitingCount } from '../../components/world-safety';
import { PersonIcon } from '../../components/profile-card';
import RecentVisitors from '../../components/recent-visitors';
import { useEntitySummaries } from '../../hooks/use-entity-summaries';
import { useHere, useMembersPreview, useStarToggle } from '../../hooks/use-place-data';
import { formatHour } from '../../hooks/use-room-analytics';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

interface World {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  featured: boolean;
  thumbnailUrl: string | null;
  canEdit?: boolean;
  /** Stars on the world itself, and whether you gave one. */
  starCount?: number;
  isStarred?: boolean;
  universe: {
    id: string;
    name: string;
    slug: string;
    ownerId?: string;
  };
  rooms: Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    mapUrl: string | null;
    _count: {
      favorites: number;
    };
  }>;
}

/** One visit, as the analytics API lists it. */
interface Visit {
  woka?: string[];
  id: string;
  accessedAt: string;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  userUuid?: string | null;
  hasMembership?: boolean;
  membershipTags: string[];
  isAuthenticated?: boolean;
  ipAddress?: string | null;
  room: { id: string; name: string };
}

const TAB_CLASS = 'orbit-press inline-flex h-10 items-center rounded-full px-4 text-sm font-semibold transition-colors';
const tabClass = (active: boolean) =>
  `${TAB_CLASS} ${active ? 'bg-[image:var(--brand-gradient)] text-white shadow-[0_6px_18px_-8px_rgb(134_41_252/0.8)]' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`;

/** useSearchParams needs a Suspense boundary above it (the tab comes from ?tab=). */
type WorldView = 'details' | 'visitors' | 'members' | 'safety';

export function WorldDetailPage({ view = 'details' }: { view?: WorldView }) {
  return (
    <Suspense fallback={null}>
      <WorldDetail view={view} />
    </Suspense>
  );
}

const VIEW_TITLE: Record<WorldView, string> = { details: '', visitors: 'Visitors', members: 'Members', safety: 'Safety' };

function WorldDetail({ view }: { view: WorldView }) {
  const router = useRouter();
  const replacePage = useReplacePage();
  const params = useParams();
  const id = params.id as string;
  const searchParams = useSearchParams();
  
  const [world, setWorld] = useState<World | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);
  // The game can open Orbit straight on a world's members (`?tab=members`, see lib/orbit-bridge.ts); the home's
  // report card opens its Safety tab (`?tab=safety`).
  const activeTab = view === 'visitors' ? 'analytics' : view;
  // Old links (the game's `?tab=members`, the home report card's `?tab=safety`) land on the matching page.
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (view === 'details' && (tab === 'members' || tab === 'safety')) replacePage(`/admin/worlds/${id}/${tab}`);
  }, [view, searchParams, id, replacePage]);
  // Reports and bans, only for the people who run this world; everyone else gets no Safety tab
  const safety = useWorldSafety(id);
  const waiting = waitingCount(safety.data);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [visitorsPage, setVisitorsPage] = useState(1);
  const visitorsPerPage = 10;
  // Each room's activity for its card, asked for once per room (a failure offers a retry, never a request loop).
  const roomIds = useMemo(() => world?.rooms?.map((room) => room.id) ?? [], [world]);
  const roomSummaries = useEntitySummaries('rooms', roomIds);
  const worldSummaries = useEntitySummaries('worlds', useMemo(() => [id], [id]));
  const { here, known: hereKnown, byRoom } = useHere('world', id);
  const membersPreview = useMembersPreview(id);
  const star = useStarToggle(
    `/api/admin/worlds/${id}/favorite`,
    world ? { isStarred: !!world.isStarred, starCount: world.starCount ?? 0 } : null,
    (next) => setWorld((current) => (current ? { ...current, ...next } : current)),
  );
  
  const isSuperAdmin = useIsSuperAdmin();
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    isPublic: true,
    featured: false,
    thumbnailUrl: '',
  });

  useEffect(() => {
    checkAuth();
    fetchWorld();
  }, [id]);

  useEffect(() => {
    if (world) {
      // Fetch analytics on initial load to show totalAccesses count
      fetchAnalytics(1);
    }
  }, [world, id]);

  useEffect(() => {
    if (activeTab === 'analytics' && world) {
      // Fetch analytics when switching to analytics tab or changing page
      fetchAnalytics(visitorsPage);
    }
  }, [visitorsPage, activeTab, world]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      const data = await response.json();
      setCurrentUser(data.user);
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchWorld() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/worlds/${id}`);

      if (!response.ok) {
        if (response.status === 404) {
          // Gone, private or not yours: the page says so in place, with Back still there.
          setWorld(null);
          return;
        }
        throw new Error('Failed to fetch world');
      }

      const data = await response.json();
      setWorld(data);
      setFormData({
        slug: data.slug,
        name: data.name,
        description: data.description || '',
        isPublic: data.isPublic,
        featured: data.featured,
        thumbnailUrl: data.thumbnailUrl || '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load world');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAnalytics(page: number = 1) {
    try {
      setAnalyticsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/worlds/${id}?page=${page}&limit=${visitorsPerPage}`);
      if (response.ok) {
        const data = await response.json();
        setAnalytics(data);
      }
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/worlds/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...formData,
          description: formData.description || null,
          thumbnailUrl: formData.thumbnailUrl || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update world');
      }

      const updated = await response.json();
      setWorld(updated);
      setIsEditing(false);
      await fetchWorld();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update world');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    setDeleting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/worlds/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete world');
      }

      replacePage(`/admin/universes/${world?.universe.id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete world');
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  }

  if (loading) {
    return <LoadingRows label="this world" rows={3} />;
  }

  if (!world) {
    return <EmptyCard kind="world" title="World not found." text="It may have been deleted, or you may not have access to it." />;
  }

  const visits = typeof analytics?.totalAccesses === 'number' ? analytics.totalAccesses : null;
  const sortedRooms = [...world.rooms].sort((a, b) => {
    const aAccesses = roomSummaries.summary(a.id)?.totalAccesses ?? 0;
    const bAccesses = roomSummaries.summary(b.id)?.totalAccesses ?? 0;
    return bAccesses - aAccesses;
  });

  const summary = worldSummaries.summary(id);
  const universeSlug = world.universe.slug;
  const roomRows: RoomRowData[] = sortedRooms.map((room) => {
    const activity = roomSummaries.summary(room.id);
    return {
      id: room.id,
      name: room.name,
      favorites: room._count?.favorites ?? 0,
      playPath: playPathOf(universeSlug, world.slug, room.slug),
      here: byRoom.get(room.id) ?? { count: 0, people: [], youAreHere: false },
      you: activity?.lastVisitedByUser?.accessedAt ?? null,
      latest: activity?.lastVisitedOverall?.accessedAt ?? null,
    };
  });
  const startRoom = world.rooms[0];
  // Your roles in this world: its members' tags, and owner when the universe is yours.
  const yourRoles = currentUser && world.universe.ownerId === currentUser.id ? ['owner'] : (membersPreview?.yourTags ?? []);
  const peakHour = summary?.peakHour ?? null;

  return (
    <div className="space-y-8">
      {view !== 'details' ? (
        <PageHeader
          kind={view === 'safety' ? 'world' : 'people'}
          title={VIEW_TITLE[view]}
          context={
            <InContext
              parts={[
                { label: world.universe.name, href: `/admin/universes/${world.universe.id}` },
                { label: world.name, href: `/admin/worlds/${id}` },
              ]}
            />
          }
          stats={view === 'visitors' && visits !== null ? <Figures><Figure value={visits} label={visits === 1 ? "access" : "accesses"} /></Figures> : undefined}
          actions={
            view === 'members' && world.canEdit !== false ? (
              <Button variant="outline" onClick={() => setInviteDialogOpen(true)}>
                <UserPlus aria-hidden="true" />
                Invite member
              </Button>
            ) : undefined
          }
        />
      ) : (
      <PlaceHero
        kind="world"
        title={world.name}
        context={
          <>
            <Crumb kind="universe" label={world.universe.name} href={`/admin/universes/${world.universe.id}`} />
            {world.canEdit === true && <StatusPill status={world.isPublic ? 'public' : 'private'} />}
            {world.featured && <StatusPill status="featured" />}
            {yourRoles.length > 0 && <RolePills roles={yourRoles} />}
          </>
        }
        description={world.description}
        stats={[
          { value: hereKnown ? here.count : '–', label: 'here now', live: true },
          { value: summary?.visitsThisWeek ?? '–', label: 'visits this week', href: `/admin/worlds/${id}/visitors` },
          { value: peakHour !== null ? formatHour(peakHour) : '–', label: 'busiest hour' },
          { value: membersPreview?.total ?? '–', label: 'members' },
        ]}
        here={here}
        actions={
          <>
            {startRoom && (
              <VisitButton hero playPath={playPathOf(universeSlug, world.slug, startRoom.slug)} roomId={startRoom.id} name={startRoom.name} />
            )}
            {currentUser && <StarButton count={world.starCount ?? 0} starred={!!world.isStarred} onClick={star.toggle} disabled={star.busy} />}
          </>
        }
        manageLine={!isEditing && world.canEdit === true ? 'You run this world' : undefined}
        manage={
          !isEditing && world.canEdit === true ? (
            <>
              <Button variant="outline" onClick={() => setIsEditing(true)}>
                <Pencil aria-hidden="true" />
                Edit
              </Button>
              {(safety.data || safety.failed) && (
                <Button variant="outline" asChild>
                  <Link href={`/admin/worlds/${id}/safety`}>
                    <ShieldCheck aria-hidden="true" />
                    Safety
                    {waiting > 0 && (
                      <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[image:var(--brand-gradient)] px-1.5 text-[11px] font-bold tabular-nums text-white">
                        {waiting}
                        <span className="sr-only"> waiting</span>
                      </span>
                    )}
                  </Link>
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isEditing ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Edit world</CardTitle>
              {world.canEdit === true && (
                <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
                  <Trash2 aria-hidden="true" />
                  Delete
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">
                Slug <span className="text-destructive">*</span>
              </Label>
              <Input
                id="slug"
                required
                value={formData.slug}
                onChange={(e) => setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                rows={3}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <Settings label="Visibility">
              <SettingSwitch
                id="isPublic"
                label="Public"
                hint="Shown in Space, and its public rooms are open to everyone. Off: members only."
                checked={formData.isPublic}
                onChange={(checked) => setFormData({ ...formData, isPublic: checked })}
              />
              {isSuperAdmin && (
                <SettingSwitch
                  id="featured"
                  label="Featured"
                  hint="Pinned to the top of Space and Discover. Only super admins can change this."
                  checked={formData.featured}
                  onChange={(checked) => setFormData({ ...formData, featured: checked })}
                />
              )}
            </Settings>

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 pt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setIsEditing(false);
                  fetchWorld();
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Saving...
                  </>
                ) : (
                  'Save changes'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>

          {activeTab === 'safety' && (
            <WorldSafety worldId={id} worldName={world.name} data={safety.data} failed={safety.failed} reload={safety.reload} />
          )}

          {activeTab === 'details' && (
            <>
              <RecentVisitors scope="world" id={id} onOpenVisitors={() => router.push(`/admin/worlds/${id}/visitors`)} />
              {world.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={world.thumbnailUrl} alt={world.name} className="h-20 w-20 rounded-xl object-cover" />
              )}

              <section aria-labelledby="world-rooms">
                <SectionHead
                  title="Rooms"
                  count={world.rooms.length}
                  action={world.canEdit === true ? <AddButton href={`/admin/rooms/new?worldId=${id}`}>Create room</AddButton> : undefined}
                />
                {world.rooms.length === 0 ? (
                  world.canEdit === true ? (
                    <EmptyCard
                      kind="room"
                      title="No rooms yet."
                      text="Rooms are the places people visit in this world."
                      href={`/admin/rooms/new?worldId=${id}`}
                      action="Create a room"
                    />
                  ) : (
                    <EmptyCard kind="room" title="No rooms yet." text="Rooms are the places people visit in this world." />
                  )
                ) : (
                  <RoomRows rooms={roomRows} />
                )}
                {world.rooms.length > 0 && roomSummaries.failed.length > 0 && (
                  <div className="mt-3">
                    <LoadError label="activity for some rooms" retry={() => roomSummaries.retry()} />
                  </div>
                )}
              </section>
              <MembersRow worldId={id} preview={membersPreview} onInvite={() => setInviteDialogOpen(true)} />
            </>
          )}

          {activeTab === 'analytics' && (
            <section aria-labelledby="world-visitors">
              {analyticsLoading ? (
                <LoadingRows label="visitors" rows={3} />
              ) : analytics && analytics.recentActivity && analytics.recentActivity.length > 0 ? (
                <div className="space-y-4">
                                    <div>
                    {analytics.recentActivity.map((access: Visit) => {
                      const userName = access.userName || access.userEmail || access.userUuid || 'Guest';
                      const when = timeAgo(new Date(access.accessedAt));
                      const roles: string[] = access.hasMembership && access.membershipTags.length > 0 ? access.membershipTags : [];
                      const who = roles.length > 0 ? null : access.isAuthenticated ? 'Signed in' : 'Guest';
                      if (access.userId) {
                        return (
                          <EntityRow
                            key={access.id}
                            href={`/admin/users/${access.userId}`}
                            kind="people"
                            leading={<PersonIcon woka={access.woka} name={userName} face />}
                            title={userName}
                            context={<StatLine items={[who, when]} />}
                            meta={roles.length > 0 ? <RolePills roles={roles} /> : undefined}
                            trailing={
                              <Link
                                href={`/admin/rooms/${access.room.id}`}
                                className="flex min-h-9 max-w-[9rem] items-center truncate text-xs font-semibold underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
                              >
                                {access.room.name}
                              </Link>
                            }
                          />
                        );
                      }
                      return (
                        <EntityRow
                          key={access.id}
                          href={`/admin/rooms/${access.room.id}`}
                          kind="people"
                          leading={<PersonIcon woka={access.woka} name={userName} face />}
                          title={userName}
                          context={<StatLine items={[who, `in ${access.room.name}`, when]} />}
                          meta={roles.length > 0 ? <RolePills roles={roles} /> : undefined}
                        />
                      );
                    })}
                  </div>
                  {analytics.pagination && analytics.pagination.totalPages > 1 && (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-sm text-muted-foreground">
                        Showing {(analytics.pagination.page - 1) * analytics.pagination.limit + 1} to {Math.min(analytics.pagination.page * analytics.pagination.limit, analytics.pagination.total)} of {analytics.pagination.total} visitors
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setVisitorsPage(prev => Math.max(1, prev - 1))}
                          disabled={visitorsPage === 1}
                        >
                          <ChevronLeft aria-hidden="true" />
                          Previous
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setVisitorsPage(prev => prev + 1)}
                          disabled={visitorsPage >= (analytics.pagination?.totalPages || 1)}
                        >
                          Next
                          <ChevronRight aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <EmptyCard kind="people" title="No visitors yet." text="Visits to rooms in this world show up here." />
              )}
            </section>
          )}

          {activeTab === 'members' && (
            <section aria-labelledby="world-members" className="space-y-2">
              <MemberList worldId={id} onRefresh={fetchWorld} />
            </section>
          )}

          <InviteMemberDialog
            open={inviteDialogOpen}
            onOpenChange={setInviteDialogOpen}
            worldId={id}
            onInviteSent={() => {
              fetchWorld();
            }}
          />
        </>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete world</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{world.name}&quot;? This will also delete all rooms in it. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
