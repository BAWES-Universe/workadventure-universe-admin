'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { timeAgo } from '@/lib/time-ago';
import { activityStats } from '@/lib/analytics-peak';
import {
  EmptyCard,
  EntityCard,
  EntityRow,
  Figure,
  Figures,
  InContext,
  LoadError,
  LoadingRows,
  PageHeader,
  RolePills,
  SectionHeader,
  StatLine,
  StatusPill,
  VisitLine,
} from '../../components/ds';
import InviteMemberDialog from '../../components/invite-member-dialog';
import MemberList from '../../components/member-list';
import { PersonIcon } from '../../components/profile-card';
import { useEntitySummaries } from '../../hooks/use-entity-summaries';

interface World {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  featured: boolean;
  thumbnailUrl: string | null;
  canEdit?: boolean;
  universe: {
    id: string;
    name: string;
    slug: string;
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

const TAB_CLASS = 'py-3 px-1 border-b-2 font-medium text-sm';
const tabClass = (active: boolean) =>
  `${TAB_CLASS} ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'}`;

export default function WorldDetailPage() {
  const router = useRouter();
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
  // The game can open Orbit straight on a world's members (`?tab=members`, see lib/orbit-bridge.ts).
  const [activeTab, setActiveTab] = useState<'details' | 'analytics' | 'members'>(
    searchParams.get('tab') === 'members' ? 'members' : 'details',
  );
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [visitorsPage, setVisitorsPage] = useState(1);
  const visitorsPerPage = 10;
  // Each room's activity for its card, asked for once per room (a failure offers a retry, never a request loop).
  const roomIds = useMemo(() => world?.rooms?.map((room) => room.id) ?? [], [world]);
  const roomSummaries = useEntitySummaries('rooms', roomIds);
  
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
          router.push('/admin/worlds');
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

      router.push(`/admin/universes/${world?.universe.id}`);
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

  return (
    <div className="space-y-8">
      <PageHeader
        kind="world"
        title={world.name}
        context={<InContext parts={[{ label: world.universe.name, href: `/admin/universes/${world.universe.id}` }]} />}
        status={
          world.canEdit === true || world.featured ? (
            <>
              {world.canEdit === true && <StatusPill status={world.isPublic ? 'public' : 'private'} />}
              {world.featured && <StatusPill status="featured" />}
            </>
          ) : undefined
        }
        stats={
          <Figures>
            {visits !== null && <Figure value={visits} label={visits === 1 ? 'visit' : 'visits'} />}
            <Figure value={world.rooms.length} label={world.rooms.length === 1 ? 'room' : 'rooms'} />
          </Figures>
        }
        actions={
          !isEditing && world.canEdit === true ? (
            <>
              <Button asChild>
                <Link href={`/admin/rooms/new?worldId=${id}`}>
                  <Plus aria-hidden="true" />
                  Create room
                </Link>
              </Button>
              <Button variant="outline" onClick={() => setIsEditing(true)}>
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            </>
          ) : undefined
        }
      />

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

            <div className="flex flex-wrap gap-6">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="isPublic"
                  checked={formData.isPublic}
                  onCheckedChange={(checked) => setFormData({ ...formData, isPublic: checked === true })}
                />
                <Label htmlFor="isPublic" className="font-normal cursor-pointer">
                  Public
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="featured"
                  checked={formData.featured}
                  onCheckedChange={(checked) => setFormData({ ...formData, featured: checked === true })}
                />
                <Label htmlFor="featured" className="font-normal cursor-pointer">
                  Featured
                </Label>
              </div>
            </div>

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
          <nav className="flex flex-wrap gap-x-6 border-b border-border" aria-label="World sections">
            <button type="button" onClick={() => setActiveTab('details')} className={tabClass(activeTab === 'details')}>
              Details
            </button>
            <button type="button" onClick={() => setActiveTab('analytics')} className={tabClass(activeTab === 'analytics')}>
              Visitors
            </button>
            <button type="button" onClick={() => setActiveTab('members')} className={tabClass(activeTab === 'members')}>
              Members
            </button>
          </nav>

          {activeTab === 'details' && (
            <>
              {(world.description || world.thumbnailUrl) && (
                <section aria-labelledby="world-about" className="space-y-3">
                  <SectionHeader id="world-about" title="About" />
                  {world.thumbnailUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={world.thumbnailUrl} alt={world.name} className="h-20 w-20 rounded-xl object-cover" />
                  )}
                  {world.description && (
                    <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/85">{world.description}</p>
                  )}
                </section>
              )}

              <section aria-labelledby="world-rooms">
                <SectionHeader id="world-rooms" title="Rooms" count={world.rooms.length} />
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
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {sortedRooms.map((room) => {
                      const favorites = room._count.favorites ?? 0;
                      const roomStats = roomSummaries.summary(room.id);
                      const you = roomStats?.lastVisitedByUser?.accessedAt ?? null;
                      const latest = roomStats?.lastVisitedOverall?.accessedAt ?? null;
                      return (
                        <EntityCard
                          key={room.id}
                          href={`/admin/rooms/${room.id}`}
                          kind="room"
                          title={room.name}
                          description={room.description}
                          aside={favorites > 0 ? `★ ${favorites}` : undefined}
                          meta={
                            roomStats ? (
                              <>
                                <StatLine items={activityStats(roomStats)} />
                                <VisitLine you={you} latest={latest} youWereLast={roomStats.youWereLast} />
                              </>
                            ) : undefined
                          }
                        />
                      );
                    })}
                  </div>
                )}
                {world.rooms.length > 0 && roomSummaries.failed.length > 0 && (
                  <div className="mt-3">
                    <LoadError label="activity for some rooms" retry={() => roomSummaries.retry()} />
                  </div>
                )}
              </section>
            </>
          )}

          {activeTab === 'analytics' && (
            <section aria-labelledby="world-visitors">
              {analyticsLoading ? (
                <LoadingRows label="visitors" rows={3} />
              ) : analytics && analytics.recentActivity && analytics.recentActivity.length > 0 ? (
                <div className="space-y-4">
                  <SectionHeader id="world-visitors" title="Recent visitors" count={analytics.pagination?.total} />
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
                            leading={<PersonIcon woka={access.woka} name={userName} />}
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
                          leading={<PersonIcon woka={access.woka} name={userName} />}
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
              <div className="flex flex-wrap items-center justify-between gap-x-3">
                <div className="min-w-0 flex-1">
                  <SectionHeader id="world-members" title="Members" />
                </div>
                {world.canEdit !== false && (
                  <Button variant="outline" onClick={() => setInviteDialogOpen(true)}>
                    <UserPlus aria-hidden="true" />
                    Invite member
                  </Button>
                )}
              </div>
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
