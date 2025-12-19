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
import { ChevronRight, AlertCircle, Loader2, Plus, Edit, Trash2, Users, MapPin, Star, Globe, Home, Activity, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import InviteMemberDialog from '../../components/invite-member-dialog';
import MemberList from '../../components/member-list';

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

function formatHourTo12Hour(hour: number): string {
  if (hour === 0) return '12:00 AM';
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return '12:00 PM';
  return `${hour - 12}:00 PM`;
}

export default function WorldDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  
  const [world, setWorld] = useState<World | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'analytics' | 'members'>('details');
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [roomAnalytics, setRoomAnalytics] = useState<Record<string, { totalAccesses: number; peakHour: number | null }>>({});
  
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
    fetchAnalytics();
  }, [id]);

  useEffect(() => {
    async function fetchRoomAnalytics() {
      if (!world?.rooms || world.rooms.length === 0) return;

      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const results = await Promise.all(
          world.rooms.map(async (room) => {
            try {
              const response = await authenticatedFetch(`/api/admin/analytics/rooms/${room.id}`);
              if (!response.ok) {
                return null;
              }
              const data = await response.json();
              
              // Calculate peak hour from recent activity in local timezone (like detail page)
              let peakHour = null;
              if (data.recentActivity && data.recentActivity.length > 0) {
                const hourCounts = new Map<number, number>();
                data.recentActivity.forEach((access: any) => {
                  const date = new Date(access.accessedAt);
                  const hour = date.getHours(); // Local timezone
                  hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
                });
                const localPeakTimes = Array.from(hourCounts.entries())
                  .map(([hour, count]) => ({ hour, count }))
                  .sort((a, b) => b.count - a.count);
                if (localPeakTimes.length > 0) {
                  peakHour = localPeakTimes[0].hour;
                }
              }
              
              // Fallback to UTC peakTimes if no recent activity
              if (peakHour === null && Array.isArray(data.peakTimes) && data.peakTimes.length > 0) {
                peakHour = data.peakTimes[0].hour;
              }
              
              return {
                roomId: room.id,
                totalAccesses: data.totalAccesses || 0,
                peakHour,
              };
            } catch {
              return null;
            }
          }),
        );

        const analyticsMap: Record<string, { totalAccesses: number; peakHour: number | null }> = {};
        for (const result of results) {
          if (result) {
            analyticsMap[result.roomId] = {
              totalAccesses: result.totalAccesses,
              peakHour: result.peakHour,
            };
          }
        }
        setRoomAnalytics(analyticsMap);
      } catch {
        // Silently fail - analytics are optional
      }
    }

    if (world) {
      fetchRoomAnalytics();
    }
  }, [world]);

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

  async function fetchAnalytics() {
    try {
      setAnalyticsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/worlds/${id}`);
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
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!world) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Not Found</AlertTitle>
          <AlertDescription>World not found</AlertDescription>
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
        <Link href="/admin/universes" className="hover:text-foreground">
          Universes
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/admin/universes/${world.universe.id}`} className="hover:text-foreground">
          {world.universe.name}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{world.name}</span>
      </nav>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">{world.name}</h1>
          <p className="text-muted-foreground">
            In <Link href={`/admin/universes/${world.universe.id}`} className="text-primary hover:underline">{world.universe.name}</Link> • Slug: <code className="bg-muted px-1.5 py-0.5 rounded text-sm">{world.slug}</code>
          </p>
        </div>
        {!isEditing && world.canEdit === true && (
          <div className="flex flex-wrap gap-2">
            <Button variant="default" asChild>
              <Link href={`/admin/rooms/new?worldId=${id}`}>
                <Plus className="mr-2 h-4 w-4" />
                Create Room
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
            <CardTitle>Edit World</CardTitle>
            <CardDescription>Update the world details below.</CardDescription>
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
                  fetchWorld();
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
          <div className="border-b">
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
                Analytics
              </button>
              <button
                onClick={() => setActiveTab('members')}
                className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center gap-2 ${
                  activeTab === 'members'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
                }`}
              >
                <Users className="h-4 w-4" />
                Members
              </button>
            </nav>
          </div>

          {/* Tab Content */}
          {activeTab === 'details' && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Description</dt>
                      <dd className="mt-1 text-sm">{world.description || 'No description'}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                      <dd className="mt-1">
                        <div className="flex items-center gap-2">
                          <Badge variant={world.isPublic ? 'default' : 'secondary'}>
                            {world.isPublic ? 'Public' : 'Private'}
                          </Badge>
                          {world.featured && <Badge variant="outline">Featured</Badge>}
                        </div>
                      </dd>
                    </div>
                    {world.thumbnailUrl && (
                      <div className="sm:col-span-2">
                        <dt className="text-sm font-medium text-muted-foreground">Thumbnail</dt>
                        <dd className="mt-1">
                          <img src={world.thumbnailUrl} alt={world.name} className="h-20 w-20 object-cover rounded" />
                        </dd>
                      </div>
                    )}
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Rooms ({world.rooms.length})</CardTitle>
                    {world.canEdit === true && (
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/admin/rooms/new?worldId=${id}`}>
                          <Plus className="mr-2 h-4 w-4" />
                          Add Room
                        </Link>
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {world.rooms.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No rooms yet. Create one to get started.</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {world.rooms.map((room) => {
                        const favorites = room._count.favorites ?? 0;
                        const analytics = roomAnalytics[room.id];
                        return (
                          <Link
                            key={room.id}
                            href={`/admin/rooms/${room.id}`}
                            className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          >
                            <Card
                              className={cn(
                                'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                                'hover:-translate-y-1 hover:shadow-lg',
                              )}
                            >
                              <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-transparent to-sky-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

                              <div className="relative flex h-full flex-col p-5">
                                <div className="mb-3 flex items-start gap-3">
                                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted">
                                    <MapPin className="h-5 w-5 text-muted-foreground" />
                                  </div>

                                  <div className="min-w-0 flex-1 space-y-1">
                                    <h3 className="truncate text-base font-semibold leading-tight">
                                      {room.name}
                                    </h3>
                                    <p className="truncate text-xs text-muted-foreground">
                                      {world.universe.name} · {world.name}
                                    </p>
                                  </div>
                                </div>

                                {room.description && (
                                  <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                                    {room.description}
                                  </p>
                                )}

                                <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground">
                                  <div className="flex flex-col gap-1.5">
                                    {analytics ? (
                                      <>
                                        <div className="flex items-center gap-1.5">
                                          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                                          <span className="font-medium text-foreground/80">
                                            {analytics.totalAccesses.toLocaleString()} accesses
                                          </span>
                                        </div>
                                        {analytics.peakHour !== null && (
                                          <div className="flex items-center gap-1.5">
                                            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                            <span className="text-muted-foreground">
                                              Peak: {formatHourTo12Hour(analytics.peakHour)}
                                            </span>
                                          </div>
                                        )}
                                      </>
                                    ) : (
                                      <span className="text-muted-foreground">Access data loading...</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1 text-primary">
                                    <Star className="h-4 w-4" aria-hidden="true" />
                                    <span className="text-xs font-medium">{favorites}</span>
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
            </>
          )}

          {activeTab === 'analytics' && (
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
                    {analytics.mostActiveRoom && (
                      <div className="rounded-lg border p-4">
                        <div className="text-sm font-medium text-muted-foreground">Most Active Room</div>
                        <div className="mt-1 text-lg font-semibold">{analytics.mostActiveRoom.name}</div>
                        <div className="text-xs text-muted-foreground">{analytics.mostActiveRoom.accessCount} accesses</div>
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
                              <TableHead>Room</TableHead>
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
          )}

          {activeTab === 'members' && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Members</CardTitle>
                  {world.canEdit !== false && (
                    <Button onClick={() => setInviteDialogOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Invite Member
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <MemberList worldId={id} onRefresh={fetchWorld} />
              </CardContent>
            </Card>
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
            <AlertDialogTitle>Delete World</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{world.name}"? This will also delete all rooms in it. This action cannot be undone.
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
