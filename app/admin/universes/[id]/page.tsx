'use client';

import { useIsSuperAdmin } from '../../admin-bootstrap-context';

import { PersonIcon } from '../../components/profile-card';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
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
import { ChevronRight, AlertCircle, Loader2, Plus, Edit, Trash2, ChevronLeft } from 'lucide-react';
import { timeAgo } from '@/lib/time-ago';
import { activityStats } from '@/lib/analytics-peak';
import { useEntitySummaries } from '../../hooks/use-entity-summaries';
import { EmptyCard, EntityCard, EntityRow, Figure, Figures, KindIcon, LoadError, LoadingRows, PageHeader, RolePills, SectionHeader, SettingSwitch, Settings, StatLine, StatusPill, VisitLine, count } from '../../components/ds';

interface Universe {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string;
  isPublic: boolean;
  featured: boolean;
  thumbnailUrl: string | null;
  createdAt: string;
  canEdit?: boolean;
  owner: {
    id: string;
    name: string | null;
    email: string | null;
    woka?: string[];
  };
  worlds: Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    _count: {
      rooms: number;
      members: number;
      favorites?: number;
    };
  }>;
}

export default function UniverseDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  
  const [universe, setUniverse] = useState<Universe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Each world's activity for its card, asked for once per world (a failure offers a retry, never a request loop).
  const worldIds = useMemo(() => universe?.worlds?.map((world) => world.id) ?? [], [universe]);
  const worldSummaries = useEntitySummaries('worlds', worldIds);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'details' | 'analytics'>('details');
  const [visitorsPage, setVisitorsPage] = useState(1);
  const visitorsPerPage = 10;
  
  const isSuperAdmin = useIsSuperAdmin();
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    ownerId: '',
    isPublic: true,
    featured: false,
    thumbnailUrl: '',
  });

  useEffect(() => {
    checkAuth();
    fetchUniverse();
  }, [id]);

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

  async function fetchUniverse() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${id}`);

      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/universes');
          return;
        }
        throw new Error('Failed to fetch universe');
      }

      const data = await response.json();
      setUniverse(data);
      setFormData({
        slug: data.slug,
        name: data.name,
        description: data.description || '',
        ownerId: data.ownerId,
        isPublic: data.isPublic,
        featured: data.featured,
        thumbnailUrl: data.thumbnailUrl || '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load universe');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAnalytics(page: number = 1) {
    try {
      setAnalyticsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/universes/${id}?page=${page}&limit=${visitorsPerPage}`);
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
  
  useEffect(() => {
    if (universe) {
      // Fetch analytics on initial load to show totalAccesses count
      fetchAnalytics(1);
    }
  }, [universe, id]);

  useEffect(() => {
    if (activeTab === 'analytics' && universe) {
      // Fetch analytics when switching to analytics tab or changing page
      fetchAnalytics(visitorsPage);
    }
  }, [visitorsPage, activeTab, universe]);

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: formData.slug,
          name: formData.name,
          description: formData.description || null,
          thumbnailUrl: formData.thumbnailUrl || null,
          isPublic: formData.isPublic,
          featured: formData.featured,
          // ownerId is not included - it belongs to the owner and cannot be changed
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update universe');
      }

      const updated = await response.json();
      setUniverse(updated);
      setIsEditing(false);
      await fetchUniverse();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update universe');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    setDeleting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete universe');
      }

      router.push('/admin/universes');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete universe');
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  }

  if (loading) {
    return <LoadingRows label="this universe" rows={3} />;
  }

  if (!universe) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Not Found</AlertTitle>
          <AlertDescription>Universe not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  const isOwner = !!currentUser && currentUser.id === universe.ownerId;
  const worlds = universe.worlds || [];
  const statusPills =
    isOwner || universe.featured ? (
      <>
        {isOwner && <StatusPill status={universe.isPublic ? 'public' : 'private'} />}
        {universe.featured && <StatusPill status="featured" />}
      </>
    ) : undefined;

  return (
    <div className="space-y-8">
      <PageHeader
        kind="universe"
        universeId={universe.id}
        title={universe.name}
        status={statusPills}
        stats={
          <Figures>
            <Figure value={worlds.length} label={worlds.length === 1 ? 'world' : 'worlds'} />
            {analytics && (
              <Figure value={analytics.totalAccesses || 0} label={analytics.totalAccesses === 1 ? 'access' : 'accesses'} />
            )}
          </Figures>
        }
        actions={
          !isEditing && universe.canEdit === true ? (
            <>
              <Button asChild>
                <Link href={`/admin/worlds/new?universeId=${id}`}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create world
                </Link>
              </Button>
              <Button variant="outline" onClick={() => setIsEditing(true)}>
                <Edit className="mr-2 h-4 w-4" />
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
              <div className="min-w-0">
                <CardTitle>Edit universe</CardTitle>
              </div>
              {universe.canEdit === true && (
                <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
                  <Trash2 className="mr-2 h-4 w-4" />
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
                hint="Shown in Space. Off: hidden, and everything in it is members only."
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
                  fetchUniverse();
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
          {/* Tabs */}
          <div className="border-b border-border">
            <nav className="flex gap-6" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'details'}
                onClick={() => setActiveTab('details')}
                className={`-mb-px py-3 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'details'
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Details
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'analytics'}
                onClick={() => setActiveTab('analytics')}
                className={`-mb-px py-3 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'analytics'
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Visitors
              </button>
            </nav>
          </div>

          {/* Tab Content */}
          {activeTab === 'details' && (
            <>
              <section className="space-y-3" aria-labelledby="universe-about">
                <SectionHeader id="universe-about" title="About" />
                {universe.description && (
                  <p className="text-sm text-foreground/85 whitespace-pre-line">{universe.description}</p>
                )}
                {universe.thumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={universe.thumbnailUrl} alt={universe.name} className="h-12 w-12 object-cover rounded" />
                )}
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Created on{' '}
                    {new Date(universe.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} by
                  </p>
                  <EntityRow
                    href={`/admin/users/${universe.owner.id}`}
                    kind="people"
                    leading={<PersonIcon woka={universe.owner.woka} name={universe.owner.name} />}
                    title={universe.owner.name || 'Someone'}
                    context={<StatLine items={['Owner']} />}
                  />
                </div>
              </section>

              {/* Worlds: shown when there are some, or to the owner when there are none */}
              {(worlds.length === 0 && isOwner) || worlds.length > 0 ? (
                <section aria-labelledby="universe-worlds">
                  <SectionHeader id="universe-worlds" title="Worlds" count={worlds.length} />
                  {worlds.length === 0 ? (
                    <EmptyCard
                      kind="world"
                      title="No worlds yet."
                      text="Worlds hold the rooms in this universe."
                      href={universe.canEdit === true ? `/admin/worlds/new?universeId=${id}` : undefined}
                      action={universe.canEdit === true ? 'Create a world' : undefined}
                    />
                  ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {worlds.map((world) => {
                        const visits = worldSummaries.summary(world.id);
                        const youAt: string | null = visits?.lastVisitedByUser?.accessedAt ?? null;
                        const latestAt: string | null = visits?.lastVisitedOverall?.accessedAt ?? null;
                        const stars = world._count?.favorites ?? 0;
                        return (
                          <EntityCard
                            key={world.id}
                            href={`/admin/worlds/${world.id}`}
                            kind="world"
                            title={world.name}
                            description={world.description}
                            aside={stars > 0 ? `★ ${stars}` : undefined}
                            meta={
                              <>
                                <StatLine
                                  items={[
                                    count(world._count.rooms ?? 0, 'room'),
                                    count(world._count.members ?? 0, 'member'),
                                    ...activityStats(visits),
                                  ]}
                                />
                                <VisitLine you={youAt} latest={latestAt} youWereLast={visits?.youWereLast ?? false} />
                              </>
                            }
                          />
                        );
                      })}
                    </div>
                  )}
                  {worlds.length > 0 && worldSummaries.failed.length > 0 && (
                    <div className="mt-3">
                      <LoadError label="activity for some worlds" retry={() => worldSummaries.retry()} />
                    </div>
                  )}
                </section>
              ) : null}
            </>
          )}

          {activeTab === 'analytics' && (
            <>
              {analyticsLoading ? (
                <LoadingRows label="visitors" rows={3} />
              ) : analytics && analytics.recentActivity && analytics.recentActivity.length > 0 ? (
                <section className="space-y-4" aria-labelledby="universe-visitors">
                  <SectionHeader id="universe-visitors" title="Recent visitors" count={analytics.pagination?.total} />
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {analytics.recentActivity.map((access: any) => {
                      const userName = access.userName || access.userUuid || 'Guest';
                      const accessDate = new Date(access.accessedAt);
                      const isClickable = !!access.userId;

                      return (
                        <div
                          key={access.id}
                          className="flex min-w-0 items-start gap-3 rounded-[18px] border border-border bg-card p-3"
                        >
                          <PersonIcon woka={access.woka} name={access.userName} size={32} />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              {isClickable ? (
                                <Link
                                  href={`/admin/users/${access.userId}`}
                                  className="min-w-0 truncate text-sm font-semibold text-foreground hover:underline"
                                >
                                  {userName}
                                </Link>
                              ) : (
                                <span className="min-w-0 truncate text-sm font-semibold text-muted-foreground">{userName}</span>
                              )}
                              {access.hasMembership && access.membershipTags.length > 0 ? (
                                <RolePills roles={access.membershipTags} />
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {access.isAuthenticated ? 'Signed in' : 'Guest'}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground break-words">
                              <Link
                                href={`/admin/worlds/${access.world.id}`}
                                className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                              >
                                {access.world.name}
                              </Link>
                              <span aria-hidden="true"> › </span>
                              <Link
                                href={`/admin/rooms/${access.room.id}`}
                                className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                              >
                                {access.room.name}
                              </Link>
                              {' · '}
                              {timeAgo(accessDate)}
                            </p>
                          </div>
                        </div>
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
                          <ChevronLeft className="h-4 w-4 mr-1" />
                          Previous
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setVisitorsPage(prev => prev + 1)}
                          disabled={visitorsPage >= (analytics.pagination?.totalPages || 1)}
                        >
                          Next
                          <ChevronRight className="h-4 w-4 ml-1" />
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              ) : (
                <EmptyCard
                  kind="people"
                  title="No visitors yet."
                  text="Visits show up here once people come to this universe."
                />
              )}
            </>
          )}
        </>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Universe</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete “{universe.name}”? This will also delete all worlds and rooms in it. This action cannot be undone.
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
