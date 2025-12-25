'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
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
import { ChevronRight, AlertCircle, Loader2, Plus, Edit, Trash2, Globe, Home, Users as UsersIcon, Activity, Star, ChevronLeft, Clock, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

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
  const [worldAnalytics, setWorldAnalytics] = useState<Record<string, { totalAccesses: number; lastVisitedByUser: any; lastVisitedOverall: any }>>({});
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'details' | 'analytics'>('details');
  const [visitorsPage, setVisitorsPage] = useState(1);
  const visitorsPerPage = 10;
  
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

  useEffect(() => {
    if (universe && universe.worlds && universe.worlds.length > 0) {
      fetchWorldAnalytics();
    }
  }, [universe]);

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

  async function fetchWorldAnalytics() {
    if (!universe || !universe.worlds || !universe.worlds.length) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const results = await Promise.all(
        universe.worlds.map(async (world) => {
          try {
            const response = await authenticatedFetch(
              `/api/admin/analytics/worlds/${world.id}`,
            );
            if (!response.ok) return null;
            const data = await response.json();
            return {
              worldId: world.id,
              totalAccesses: data.totalAccesses || 0,
              lastVisitedByUser: data.lastVisitedByUser || null,
              lastVisitedOverall: data.lastVisitedOverall || null,
            };
          } catch {
            return null;
          }
        }),
      );

      setWorldAnalytics((prev) => {
        const updated = { ...prev };
        for (const result of results) {
          if (result) {
            updated[result.worldId] = {
              totalAccesses: result.totalAccesses,
              lastVisitedByUser: result.lastVisitedByUser,
              lastVisitedOverall: result.lastVisitedOverall,
            };
          }
        }
        return updated;
      });
    } catch {
      // Ignore errors
    }
  }

  function formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
    if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
    if (diffDays < 7) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
    if (diffWeeks < 4) return `${diffWeeks} ${diffWeeks === 1 ? 'week' : 'weeks'} ago`;
    if (diffMonths < 12) return `${diffMonths} ${diffMonths === 1 ? 'month' : 'months'} ago`;
    return `${diffYears} ${diffYears === 1 ? 'year' : 'years'} ago`;
  }

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
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
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

  return (
    <div className="space-y-8">
      <nav className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Link href="/admin" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{universe.name}</span>
      </nav>

      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-4xl font-bold tracking-tight">{universe.name}</h1>
          <div className="flex items-center gap-2">
            {currentUser && currentUser.id === universe.ownerId && (
              <Badge variant={universe.isPublic ? 'default' : 'secondary'}>
                {universe.isPublic ? 'Public' : 'Private'}
              </Badge>
            )}
            {universe.featured && <Badge variant="outline">Featured</Badge>}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground flex items-center gap-3">
            {analytics && (
              <>
                <span className="flex items-center gap-1.5 text-sm">
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium text-foreground/80">
                    {analytics.totalAccesses?.toLocaleString() || 0} {analytics.totalAccesses === 1 ? 'access' : 'accesses'}
                  </span>
                </span>
                <span className="text-muted-foreground">•</span>
              </>
            )}
            <span>
              Slug: <code className="bg-muted px-1.5 py-0.5 rounded text-sm">{universe.slug}</code>
            </span>
          </p>
          {!isEditing && universe.canEdit === true && (
            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          )}
        </div>
      </div>

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
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Edit Universe</CardTitle>
                <CardDescription>Update the universe details below.</CardDescription>
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

            <div className="space-y-2">
              <Label htmlFor="thumbnailUrl">Thumbnail URL</Label>
              <Input
                id="thumbnailUrl"
                type="url"
                value={formData.thumbnailUrl}
                onChange={(e) => setFormData({ ...formData, thumbnailUrl: e.target.value })}
              />
            </div>

            <div className="flex flex-col sm:flex-row gap-6">
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
                variant="secondary"
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
                  'Save Changes'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Tabs */}
          <div>
            <nav className="flex space-x-8">
              <button
                onClick={() => setActiveTab('details')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'details'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
                }`}
              >
                Details
              </button>
              <button
                onClick={() => setActiveTab('analytics')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'analytics'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
                }`}
              >
                Visitors
              </button>
            </nav>
          </div>

          {/* Tab Content */}
          {activeTab === 'details' && (
            <>
              {/* Details Section */}
              <section className="space-y-3">
            <div>
              <h3 className="text-xl font-semibold mb-2">About this Universe</h3>
              {universe.description && (
                <div className="text-sm text-foreground whitespace-pre-line">
                  {universe.description}
                </div>
              )}
            </div>
            <div>
              <span className="text-sm font-medium text-muted-foreground mb-2 block">
                Created on {new Date(universe.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} by
              </span>
              <Link
                href={`/admin/users/${universe.owner.id}`}
                className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Card className="group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg max-w-xs">
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-pink-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                  <CardContent className="relative flex h-full flex-col p-5">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted text-sm font-semibold">
                        {(universe.owner.name || universe.owner.email || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <h3 className="truncate text-base font-semibold leading-tight">
                          {universe.owner.name || universe.owner.email || 'Unknown'}
                        </h3>
                        <p className="truncate text-xs text-muted-foreground">
                          {universe.owner.email || 'No email'}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </div>
            {universe.thumbnailUrl && (
              <div>
                <img src={universe.thumbnailUrl} alt={universe.name} className="h-12 w-12 object-cover rounded" />
              </div>
            )}
          </section>

          {/* Worlds Section - Only show if (0 worlds AND user owns) OR (has worlds) */}
          {((!universe.worlds || universe.worlds.length === 0) && currentUser && currentUser.id === universe.ownerId) || (universe.worlds && universe.worlds.length > 0) ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h2 className="text-xl font-semibold tracking-tight">Worlds</h2>
                  <p className="text-sm text-muted-foreground">
                    {(universe.worlds || []).length} {(universe.worlds || []).length === 1 ? 'world' : 'worlds'} in this universe
                  </p>
                </div>
                {universe.canEdit === true && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/admin/worlds/new?universeId=${id}`}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create World
                    </Link>
                  </Button>
                )}
              </div>
              {!universe.worlds || universe.worlds.length === 0 ? (
                <Empty className="border border-border/70">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Globe className="h-6 w-6 text-muted-foreground" />
                    </EmptyMedia>
                    <EmptyTitle>No worlds yet</EmptyTitle>
                    <EmptyDescription>
                      Create your first world to organize rooms in this universe.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    {universe.canEdit === true && (
                      <Button variant="default" asChild>
                        <Link href={`/admin/worlds/new?universeId=${id}`}>
                          <Plus className="mr-2 h-4 w-4" />
                          Create World
                        </Link>
                      </Button>
                    )}
                  </EmptyContent>
                </Empty>
              ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {universe.worlds.map((world) => {
                  const roomsCount = world._count.rooms ?? 0;
                  const membersCount = world._count.members ?? 0;
                  return (
                    <Link
                      key={world.id}
                      href={`/admin/worlds/${world.id}`}
                      className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <Card
                        className={cn(
                          'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                          'hover:-translate-y-1 hover:shadow-lg',
                        )}
                      >
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-purple-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

                        <div className="relative flex h-full flex-col p-5">
                          <div className="mb-4 flex items-start gap-3">
                            {world.thumbnailUrl ? (
                              <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border bg-muted">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={world.thumbnailUrl}
                                  alt={world.name}
                                  className="h-full w-full object-cover"
                                />
                              </div>
                            ) : (
                              <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border bg-muted text-lg font-semibold">
                                {world.name?.charAt(0)?.toUpperCase() || '?'}
                              </div>
                            )}

                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex items-start justify-between gap-2">
                                <h3 className="truncate text-base font-semibold leading-tight">
                                  {world.name}
                                </h3>
                              </div>
                              <p className="truncate text-xs font-mono text-muted-foreground">
                                {world.slug}
                              </p>
                            </div>
                          </div>

                          {world.description && (
                            <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                              {world.description}
                            </p>
                          )}

                          <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
                            <div className="flex flex-col gap-1.5 min-h-[3rem]">
                              {worldAnalytics[world.id] ? (
                                <>
                                  <div className="flex items-center gap-1.5">
                                    <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="font-medium text-foreground/80">
                                      {worldAnalytics[world.id].totalAccesses.toLocaleString()} accesses
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-muted-foreground">
                                      {roomsCount} {roomsCount === 1 ? 'room' : 'rooms'} · {membersCount}{' '}
                                      {membersCount === 1 ? 'member' : 'members'}
                                    </span>
                                  </div>
                                  {(worldAnalytics[world.id].lastVisitedByUser || worldAnalytics[world.id].lastVisitedOverall) && (
                                    <div className="flex flex-col gap-0.5 mt-0.5">
                                      {worldAnalytics[world.id].lastVisitedByUser && (
                                        <div className="text-[11px]">
                                          <span className="text-muted-foreground/70">Last visited by you: </span>
                                          <span className="font-medium text-foreground/80">
                                            {formatTimeAgo(new Date(worldAnalytics[world.id].lastVisitedByUser.accessedAt))}
                                          </span>
                                        </div>
                                      )}
                                      {worldAnalytics[world.id].lastVisitedOverall && (
                                        <div className="text-[11px]">
                                          {worldAnalytics[world.id].lastVisitedByUser && 
                                           worldAnalytics[world.id].lastVisitedByUser.accessedAt === worldAnalytics[world.id].lastVisitedOverall.accessedAt ? (
                                            <span className="text-muted-foreground/70 italic">
                                              You were the last visitor
                                            </span>
                                          ) : (
                                            <>
                                              <span className="text-muted-foreground/70">Most recent visitor: </span>
                                              <span className="font-medium text-foreground/80">
                                                {formatTimeAgo(new Date(worldAnalytics[world.id].lastVisitedOverall.accessedAt))}
                                              </span>
                                            </>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
                                  <span className="flex items-center gap-1 font-medium text-foreground/80">
                                    <Globe className="h-3 w-3" />
                                    {universe.name}
                                  </span>
                                  <span className="line-clamp-1">
                                    {roomsCount} {roomsCount === 1 ? 'room' : 'rooms'} · {membersCount}{' '}
                                    {membersCount === 1 ? 'member' : 'members'}
                                  </span>
                                </>
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-primary self-end">
                              <Star className="h-4 w-4" aria-hidden="true" />
                              <span className="text-xs font-medium">{world._count?.favorites ?? 0}</span>
                            </div>
                          </div>
                        </div>
                      </Card>
                    </Link>
                  );
                })}
              </div>
              )}
              </section>
            ) : null}
            </>
          )}

          {activeTab === 'analytics' && (
            <>
              {analyticsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : analytics && analytics.recentActivity && analytics.recentActivity.length > 0 ? (
                <div className="space-y-6">
                  <div className="space-y-1">
                    <h2 className="text-xl font-semibold tracking-tight">Recent Activity</h2>
                    <p className="text-sm text-muted-foreground">
                      Visitor activity and access history
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {analytics.recentActivity.map((access: any) => {
                      const userName = access.userName || access.userEmail || access.userUuid || 'Guest';
                      const accessDate = new Date(access.accessedAt);
                      const isClickable = !!access.userId;
                      
                      return (
                        <Card
                          key={access.id}
                          className={cn(
                            'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                            'hover:-translate-y-1 hover:shadow-lg',
                          )}
                        >
                          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-pink-500/20 opacity-0 transition-opacity group-hover:opacity-100" />
                          <CardContent className="relative flex h-full flex-col p-4">
                            <div className="flex items-start justify-between gap-3 mb-3">
                              <div className="min-w-0 flex-1 flex items-center gap-2">
                                {isClickable ? (
                                  <Link
                                    href={`/admin/users/${access.userId}`}
                                    className="block"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <div className="text-sm font-medium text-primary hover:underline truncate">
                                      {userName}
                                    </div>
                                  </Link>
                                ) : (
                                  <div className="text-sm font-medium text-muted-foreground truncate">
                                    {userName}
                                  </div>
                                )}
                                {access.hasMembership && access.membershipTags.length > 0 ? (
                                  <Badge variant="outline" className="text-xs flex-shrink-0">{access.membershipTags.join(', ')}</Badge>
                                ) : access.isAuthenticated ? (
                                  <Badge className="text-xs flex-shrink-0">Authenticated</Badge>
                                ) : (
                                  <Badge variant="secondary" className="text-xs flex-shrink-0">Guest</Badge>
                                )}
                              </div>
                              <div className="flex-shrink-0 text-xs text-muted-foreground">
                                {formatTimeAgo(accessDate)}
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3 text-xs">
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground">World:</span>
                                <Link
                                  href={`/admin/worlds/${access.world.id}`}
                                  className="text-primary hover:underline truncate"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {access.world.name}
                                </Link>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground">Room:</span>
                                <Link
                                  href={`/admin/rooms/${access.room.id}`}
                                  className="text-primary hover:underline truncate"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {access.room.name}
                                </Link>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                  {analytics.pagination && analytics.pagination.totalPages > 1 && (
                    <div className="flex items-center justify-between">
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
                </div>
              ) : (
                <Empty className="border border-border/70">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <UsersIcon className="h-6 w-6 text-muted-foreground" />
                    </EmptyMedia>
                    <EmptyTitle>No visitors yet</EmptyTitle>
                    <EmptyDescription>
                      Visitor activity will appear here once people start accessing this universe.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
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
              Are you sure you want to delete "{universe.name}"? This will also delete all worlds and rooms in it. This action cannot be undone.
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
