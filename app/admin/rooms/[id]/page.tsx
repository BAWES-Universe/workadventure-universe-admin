'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { useWorkAdventure } from '@/app/admin/workadventure-context';
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
import { ChevronRight, AlertCircle, Loader2, Edit, Trash2, Navigation, CheckCircle2 } from 'lucide-react';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string | null;
  wamUrl: string | null;
  isPublic: boolean;
  canEdit?: boolean;
  world: {
    id: string;
    name: string;
    slug: string;
    universe: {
      id: string;
      name: string;
      slug: string;
    };
  };
}

export default function RoomDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [waNavigating, setWaNavigating] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [currentRoomPath, setCurrentRoomPath] = useState<string | null>(null);
  
  const { wa, isReady: waReady, navigateToRoom } = useWorkAdventure();
  
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    isPublic: true,
  });

  useEffect(() => {
    checkAuth();
    fetchRoom();
    fetchAnalytics();
  }, [id]);

  useEffect(() => {
    if (room && wa && waReady) {
      checkCurrentRoom();
    }
  }, [room?.id, wa, waReady]); // Only depend on room.id to avoid unnecessary re-runs

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
      setIsSuperAdmin(data.user?.isSuperAdmin || false);
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchRoom() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${id}`);

      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/rooms');
          return;
        }
        throw new Error('Failed to fetch room');
      }

      const data = await response.json();
      setRoom(data);
      setFormData({
        slug: data.slug,
        name: data.name,
        description: data.description || '',
        mapUrl: data.mapUrl || '',
        isPublic: data.isPublic,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load room');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAnalytics() {
    try {
      setAnalyticsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/rooms/${id}`);
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
      const response = await authenticatedFetch(`/api/admin/rooms/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...formData,
          description: formData.description || null,
          mapUrl: formData.mapUrl || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update room');
      }

      const updated = await response.json();
      setRoom(updated);
      setIsEditing(false);
      await fetchRoom();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update room');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    setDeleting(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete room');
      }

      router.push(`/admin/worlds/${room?.world.id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete room');
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  }

  async function checkCurrentRoom() {
    if (!waReady || !wa || !room) {
      setCurrentRoomPath(null);
      return;
    }

    try {
      await wa.onInit();
      
      // Construct the expected room path for this room
      const expectedRoomPath = `/@/${room.world.universe.slug}/${room.world.slug}/${room.slug}`;
      
      // Get current room info from WorkAdventure
      const currentRoomId = wa.room.id;
      
      // Extract the path from the full URL if it's a URL
      // WorkAdventure returns: http://play.workadventure.localhost/@/universe/world/room
      // We need: /@/universe/world/room
      let currentRoomPath = currentRoomId;
      if (currentRoomId && typeof currentRoomId === 'string') {
        if (currentRoomId.startsWith('http')) {
          try {
            const url = new URL(currentRoomId);
            currentRoomPath = url.pathname;
          } catch {
            // If URL parsing fails, try to extract path manually
            const pathMatch = currentRoomId.match(/\/@\/[^?#]+/);
            if (pathMatch) {
              currentRoomPath = pathMatch[0];
            }
          }
        }
      }
      
      // Compare the paths
      if (currentRoomPath === expectedRoomPath) {
        setCurrentRoomPath('match');
        return;
      }
      
      setCurrentRoomPath(null);
    } catch (err) {
      console.error('[RoomDetail] Failed to get current room:', err);
      setCurrentRoomPath(null);
    }
  }

  async function handleVisitRoomInUniverse() {
    if (!room) {
      alert('Room data not available');
      return;
    }

    if (!waReady) {
      alert('WorkAdventure API is not available. This feature only works when the admin page is loaded in a WorkAdventure iframe modal.');
      return;
    }

    try {
      setWaNavigating(true);
      const roomUrl = `/@/${room.world.universe.slug}/${room.world.slug}/${room.slug}`;
      await navigateToRoom(roomUrl);
    } catch (err) {
      console.error('[RoomDetail] Failed to navigate to room:', err);
      alert(err instanceof Error ? err.message : 'Failed to navigate to room');
    } finally {
      setWaNavigating(false);
    }
  }

  // Check if user is currently in this room
  // Compare by room ID (WorkAdventure might store the database room ID)
  const isInCurrentRoom = waReady && currentRoomPath === 'match' && room;

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Not Found</AlertTitle>
          <AlertDescription>Room not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Calculate peak hour
  let peakHour = null;
  let peakCount = 0;
  if (analytics?.recentActivity && analytics.recentActivity.length > 0) {
    const hourCounts = new Map<number, number>();
    analytics.recentActivity.forEach((access: any) => {
      const date = new Date(access.accessedAt);
      const hour = date.getHours();
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    });
    const localPeakTimes = Array.from(hourCounts.entries())
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => b.count - a.count);
    if (localPeakTimes.length > 0) {
      peakHour = localPeakTimes[0].hour;
      peakCount = localPeakTimes[0].count;
    }
  }
  if (peakHour === null && analytics?.peakTimes && analytics.peakTimes.length > 0) {
    peakHour = analytics.peakTimes[0].hour;
    peakCount = analytics.peakTimes[0].count;
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
        <Link href={`/admin/universes/${room.world.universe.id}`} className="hover:text-foreground">
          {room.world.universe.name}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/admin/worlds/${room.world.id}`} className="hover:text-foreground">
          {room.world.name}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{room.name}</span>
      </nav>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">{room.name}</h1>
          <p className="text-muted-foreground">
            In <Link href={`/admin/worlds/${room.world.id}`} className="text-primary hover:underline">{room.world.name}</Link> • Slug: <code className="bg-muted px-1.5 py-0.5 rounded text-sm">{room.slug}</code>
          </p>
        </div>
        {!isEditing && (
          <div className="flex flex-wrap gap-2">
            {isInCurrentRoom ? (
              <Alert className="border-green-200 bg-green-50 dark:bg-green-950 dark:border-green-800">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                <AlertTitle className="text-green-800 dark:text-green-200">You are currently in this room</AlertTitle>
              </Alert>
            ) : (
              <Button
                variant="default"
                onClick={handleVisitRoomInUniverse}
                disabled={waNavigating || !waReady}
                title={!waReady ? 'WorkAdventure API not available (only works in iframe)' : undefined}
              >
                {waNavigating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Navigating...
                  </>
                ) : (
                  <>
                    <Navigation className="mr-2 h-4 w-4" />
                    Visit
                  </>
                )}
              </Button>
            )}
            {room.canEdit !== false && (
              <>
                <Button variant="outline" onClick={() => setIsEditing(true)}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </Button>
                <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              </>
            )}
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
            <CardTitle>Edit Room</CardTitle>
            <CardDescription>Update the room details below.</CardDescription>
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
              <Label htmlFor="mapUrl">Map URL (Optional)</Label>
              <p className="text-sm text-muted-foreground">
                Override the world's map URL for this room. Leave empty to use the world's map.
              </p>
              <Input
                id="mapUrl"
                type="url"
                value={formData.mapUrl}
                onChange={(e) => setFormData({ ...formData, mapUrl: e.target.value })}
              />
            </div>

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

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 pt-4">
              <Button
                variant="secondary"
                onClick={() => {
                  setIsEditing(false);
                  fetchRoom();
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
                  <dd className="mt-1 text-sm">{room.description || 'No description'}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                  <dd className="mt-1">
                    <Badge variant={room.isPublic ? 'default' : 'secondary'}>
                      {room.isPublic ? 'Public' : 'Private'}
                    </Badge>
                  </dd>
                </div>
                {isSuperAdmin && room.mapUrl && (
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">Map URL</dt>
                    <dd className="mt-1 text-sm break-all">
                      <a href={room.mapUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {room.mapUrl}
                      </a>
                    </dd>
                  </div>
                )}
                {isSuperAdmin && room.wamUrl && (
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">WAM URL</dt>
                    <dd className="mt-1 text-sm break-all">
                      <a href={room.wamUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {room.wamUrl}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
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
                    {peakHour !== null && (
                      <div className="rounded-lg border p-4">
                        <div className="text-sm font-medium text-muted-foreground">Peak Hour</div>
                        <div className="mt-1 text-lg font-semibold">
                          {String(peakHour).padStart(2, '0')}:00
                        </div>
                        <div className="text-xs text-muted-foreground">{peakCount} accesses</div>
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
                              {isSuperAdmin && <TableHead>IP Address</TableHead>}
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
                                  {access.userName || access.userEmail || access.userUuid || 'Guest'}
                                </TableCell>
                                {isSuperAdmin && (
                                  <TableCell className="text-sm font-mono text-muted-foreground">
                                    {access.ipAddress}
                                  </TableCell>
                                )}
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
            <AlertDialogTitle>Delete Room</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{room.name}"? This action cannot be undone.
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
