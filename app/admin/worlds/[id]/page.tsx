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
import { ChevronRight, AlertCircle, Loader2, Plus, Edit, Trash2, Users, MapPin, Star, Globe, Home, Activity, Clock, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
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
  const [visitorsPage, setVisitorsPage] = useState(1);
  const visitorsPerPage = 10;
  const [roomAnalytics, setRoomAnalytics] = useState<Record<string, { totalAccesses: number; peakHour: number | null; lastVisitedByUser: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null; lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null }>>({});
  
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
                lastVisitedByUser: data.lastVisitedByUser || null,
                lastVisitedOverall: data.lastVisitedOverall || null,
              };
            } catch {
              return null;
            }
          }),
        );

        const analyticsMap: Record<string, { totalAccesses: number; peakHour: number | null; lastVisitedByUser: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null; lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null }> = {};
        for (const result of results) {
          if (result) {
            analyticsMap[result.roomId] = {
              totalAccesses: result.totalAccesses,
              peakHour: result.peakHour,
              lastVisitedByUser: result.lastVisitedByUser || null,
              lastVisitedOverall: result.lastVisitedOverall || null,
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
        <Link href={`/admin/universes/${world.universe.id}`} className="hover:text-foreground">
          {world.universe.name}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{world.name}</span>
      </nav>

      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">{world.name}</h1>
        <p className="text-muted-foreground">
          In <Link href={`/admin/universes/${world.universe.id}`} className="text-primary hover:underline">{world.universe.name}</Link>
        </p>
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
              Slug: <code className="bg-muted px-1.5 py-0.5 rounded text-sm">{world.slug}</code>
            </span>
          </p>
          {!isEditing && world.canEdit === true && (
            <Button variant="outline" onClick={() => setIsEditing(true)}>
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
                <CardTitle>Edit World</CardTitle>
                <CardDescription>Update the world details below.</CardDescription>
              </div>
              {world.canEdit === true && (
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
              <section className="space-y-3">
                {world.description && (
                  <div>
                    <h3 className="text-xl font-semibold mb-2">About this World</h3>
                    <div className="text-sm text-foreground whitespace-pre-line">
                      {world.description}
                    </div>
                  </div>
                )}
                {!world.description && (
                  <div>
                    <h3 className="text-xl font-semibold mb-2">About this World</h3>
                  </div>
                )}
                {world.thumbnailUrl && (
                  <div>
                    <div className="text-sm font-medium text-muted-foreground mb-1">Thumbnail</div>
                    <div>
                      <img src={world.thumbnailUrl} alt={world.name} className="h-20 w-20 object-cover rounded" />
                    </div>
                  </div>
                )}
              </section>

              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold tracking-tight">Rooms ({world.rooms.length})</h2>
                  {world.canEdit === true && (
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/admin/rooms/new?worldId=${id}`}>
                        <Plus className="mr-2 h-4 w-4" />
                        Create Room
                      </Link>
                    </Button>
                  )}
                </div>
                {world.rooms.length === 0 ? (
                  <Empty className="border border-border/70">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <MapPin className="h-6 w-6 text-muted-foreground" />
                      </EmptyMedia>
                      <EmptyTitle>No rooms yet</EmptyTitle>
                      <EmptyDescription>
                        Create your first room to get started.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      {world.canEdit === true && (
                        <Button variant="default" asChild>
                          <Link href={`/admin/rooms/new?worldId=${id}`}>
                            <Plus className="mr-2 h-4 w-4" />
                            Create Room
                          </Link>
                        </Button>
                      )}
                    </EmptyContent>
                  </Empty>
                ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {[...world.rooms].sort((a, b) => {
                        const aAccesses = roomAnalytics[a.id]?.totalAccesses ?? 0;
                        const bAccesses = roomAnalytics[b.id]?.totalAccesses ?? 0;
                        return bAccesses - aAccesses;
                      }).map((room) => {
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

                                <div className="mt-auto flex items-start justify-between pt-3 text-xs text-muted-foreground">
                                  <div className="flex flex-col gap-1.5 min-h-[3rem]">
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
                                        {/* Last visited information */}
                                        {analytics.lastVisitedByUser || analytics.lastVisitedOverall ? (
                                          <div className="flex flex-col gap-0.5 mt-0.5">
                                            {analytics.lastVisitedByUser && (
                                              <div className="text-[11px]">
                                                <span className="text-muted-foreground/70">Last visited by you: </span>
                                                <span className="font-medium text-foreground/80">
                                                  {formatTimeAgo(new Date(analytics.lastVisitedByUser.accessedAt))}
                                                </span>
                                              </div>
                                            )}
                                            {analytics.lastVisitedOverall && (
                                              <div className="text-[11px]">
                                                {analytics.lastVisitedByUser && 
                                                 analytics.lastVisitedByUser.accessedAt === analytics.lastVisitedOverall.accessedAt ? (
                                                  <span className="text-muted-foreground/70 italic">
                                                    You were the last visitor
                                                  </span>
                                                ) : (
                                                  <>
                                                    <span className="text-muted-foreground/70">Most recent visitor: </span>
                                                    <span className="font-medium text-foreground/80">
                                                      {formatTimeAgo(new Date(analytics.lastVisitedOverall.accessedAt))}
                                                    </span>
                                                  </>
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        ) : (
                                          <div className="text-[11px] text-muted-foreground/70 mt-0.5">
                                            No visits recorded
                                          </div>
                                        )}
                                      </>
                                    ) : (
                                      <span className="text-muted-foreground">Access data loading...</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1 text-primary self-end">
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
              </section>
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
                      <Users className="h-6 w-6 text-muted-foreground" />
                    </EmptyMedia>
                    <EmptyTitle>No visitors yet</EmptyTitle>
                    <EmptyDescription>
                      Visitor activity will appear here once people start accessing rooms in this world.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent />
                </Empty>
              )}
            </>
          )}

          {activeTab === 'members' && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold tracking-tight">Members</h2>
                {world.canEdit !== false && (
                  <Button onClick={() => setInviteDialogOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Invite Member
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
