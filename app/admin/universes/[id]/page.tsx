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
import { ChevronRight, AlertCircle, Loader2, Plus, Edit, Trash2, Globe, Home, Users as UsersIcon, Activity, Star } from 'lucide-react';
import { cn } from '@/lib/utils';

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
    fetchAnalytics();
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
      }
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

  async function fetchAnalytics() {
    try {
      setAnalyticsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/universes/${id}`);
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

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">{universe.name}</h1>
          <p className="text-muted-foreground">
            Slug: <code className="bg-muted px-1.5 py-0.5 rounded text-sm">{universe.slug}</code>
          </p>
        </div>
        {!isEditing && universe.canEdit === true && (
          <div className="flex flex-wrap gap-2">
            <Button variant="default" asChild>
              <Link href={`/admin/worlds/new?universeId=${id}`}>
                <Plus className="mr-2 h-4 w-4" />
                Create World
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setIsEditing(true)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
            <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </div>
        )}
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
            <CardTitle>Edit Universe</CardTitle>
            <CardDescription>Update the universe details below.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
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
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Description</dt>
                  <dd className="mt-1 text-sm">{universe.description || 'No description'}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Owner</dt>
                  <dd className="mt-1 text-sm">
                    {universe.owner.name || universe.owner.email || 'Unknown'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                  <dd className="mt-1 text-sm">{new Date(universe.createdAt).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                  <dd className="mt-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={universe.isPublic ? 'default' : 'secondary'}>
                        {universe.isPublic ? 'Public' : 'Private'}
                      </Badge>
                      {universe.featured && <Badge variant="outline">Featured</Badge>}
                    </div>
                  </dd>
                </div>
                {universe.thumbnailUrl && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Thumbnail</dt>
                    <dd className="mt-1">
                      <img src={universe.thumbnailUrl} alt={universe.name} className="h-20 w-20 object-cover rounded" />
                    </dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Worlds ({(universe.worlds || []).length})</CardTitle>
                {universe.canEdit === true && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/admin/worlds/new?universeId=${id}`}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add World
                    </Link>
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!universe.worlds || universe.worlds.length === 0 ? (
                <p className="text-sm text-muted-foreground">No worlds yet. Create one to get started.</p>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Analytics</CardTitle>
            </CardHeader>
            <CardContent>
              {analyticsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : analytics ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg border p-4">
                      <div className="text-sm font-medium text-muted-foreground">Total Accesses</div>
                      <div className="mt-1 text-2xl font-semibold">{analytics.totalAccesses || 0}</div>
                    </div>
                    <div className="rounded-lg border p-4">
                      <div className="text-sm font-medium text-muted-foreground">Unique Users</div>
                      <div className="mt-1 text-2xl font-semibold">{analytics.uniqueUsers || 0}</div>
                    </div>
                    <div className="rounded-lg border p-4">
                      <div className="text-sm font-medium text-muted-foreground">Unique IPs</div>
                      <div className="mt-1 text-2xl font-semibold">{analytics.uniqueIPs || 0}</div>
                    </div>
                    {analytics.mostActiveWorld && (
                      <div className="rounded-lg border p-4">
                        <div className="text-sm font-medium text-muted-foreground">Most Active World</div>
                        <div className="mt-1 text-lg font-semibold">{analytics.mostActiveWorld.name}</div>
                        <div className="text-xs text-muted-foreground">{analytics.mostActiveWorld.accessCount} accesses</div>
                      </div>
                    )}
                  </div>

                  {analytics.recentActivity && analytics.recentActivity.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium mb-3">Recent Activity</h3>
                      <div className="rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Date</TableHead>
                              <TableHead>User</TableHead>
                              <TableHead>World / Room</TableHead>
                              <TableHead>Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {analytics.recentActivity.slice(0, 10).map((access: any) => (
                              <TableRow key={access.id}>
                                <TableCell className="text-sm">
                                  {new Date(access.accessedAt).toLocaleString()}
                                </TableCell>
                                <TableCell className="text-sm">
                                  {access.userId ? (
                                    <Link
                                      href={`/admin/users/${access.userId}`}
                                      className="text-primary hover:underline"
                                    >
                                      {access.userName || access.userEmail || access.userUuid || 'Guest'}
                                    </Link>
                                  ) : (
                                    access.userName || access.userEmail || access.userUuid || 'Guest'
                                  )}
                                </TableCell>
                                <TableCell className="text-sm">
                                  <Link href={`/admin/worlds/${access.world.id}`} className="text-primary hover:underline">
                                    {access.world.name}
                                  </Link>
                                  <span className="text-muted-foreground mx-1">/</span>
                                  <Link href={`/admin/rooms/${access.room.id}`} className="text-primary hover:underline">
                                    {access.room.name}
                                  </Link>
                                </TableCell>
                                <TableCell>
                                  {access.hasMembership && access.membershipTags.length > 0 ? (
                                    <Badge variant="outline">{access.membershipTags.join(', ')}</Badge>
                                  ) : access.isAuthenticated ? (
                                    <Badge>Authenticated</Badge>
                                  ) : (
                                    <Badge variant="secondary">Guest</Badge>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-12">No analytics data available.</p>
              )}
            </CardContent>
          </Card>
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
