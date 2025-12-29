'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight, Loader2, Edit, Trash2, AlertCircle, MapPin, ExternalLink, Plus, Star, Activity, Clock } from 'lucide-react';
import { ImageUpload } from '@/components/templates/ImageUpload';
import { cn } from '@/lib/utils';

interface TemplateMap {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string;
  previewImageUrl: string | null;
  sizeLabel: string | null;
  orientation: string;
  tileSize: number;
  recommendedWorldTags: string[];
  order: number;
  isActive: boolean;
  template: {
    id: string;
    slug: string;
    name: string;
    category: {
      id: string;
      slug: string;
      name: string;
      icon: string | null;
    };
  };
  _count: {
    rooms: number;
  };
}

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string | null;
  isPublic: boolean;
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
  _count?: {
    favorites?: number;
  };
}

interface ManagedWorld {
  id: string;
  name: string;
  slug: string;
  universe: {
    id: string;
    name: string;
    slug: string;
  };
}

interface RoomAnalytics {
  totalAccesses: number;
  peakHour: number | null;
  lastVisitedByUser: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
  lastVisitedOverall: { accessedAt: string; userId?: string | null; userUuid?: string | null } | null;
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

function RoomCard({ room, analytics }: { room: Room; analytics?: RoomAnalytics }) {
  const favorites = room._count?.favorites ?? 0;

  return (
    <Link
      href={`/admin/rooms/${room.id}`}
      className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label={`View room ${room.name} in world ${room.world.name}`}
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
              <p className="truncate text-xs font-mono text-muted-foreground">
                {room.world.universe.name} · {room.world.name}
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
}

export default function MapDetailPage() {
  const router = useRouter();
  const params = useParams();
  const [map, setMap] = useState<TemplateMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [analyticsByRoom, setAnalyticsByRoom] = useState<Record<string, RoomAnalytics>>({});
  const [roomsPage, setRoomsPage] = useState(1);
  const roomsPerPage = 12;
  const [roomsSortBy, setRoomsSortBy] = useState<'created' | 'accesses' | 'stars'>('created');
  const [roomsPagination, setRoomsPagination] = useState<{
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  } | null>(null);
  const [managedWorlds, setManagedWorlds] = useState<ManagedWorld[]>([]);
  const [worldsLoading, setWorldsLoading] = useState(false);
  const [isCreateRoomDialogOpen, setIsCreateRoomDialogOpen] = useState(false);
  const [selectedWorldId, setSelectedWorldId] = useState<string>('');

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    mapUrl: '',
    previewImageUrl: '',
    sizeLabel: '',
    order: 0,
    isActive: true,
  });
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);

  useEffect(() => {
    // Reset super admin state when params change
    setIsSuperAdmin(false);
    if (params.id) {
      fetchMap();
      setRoomsPage(1);
      setRoomsSortBy('created');
      fetchRooms(1, 'created');
      fetchManagedWorlds();
    }
  }, [params.id]);

  useEffect(() => {
    if (params.id && roomsPage > 0) {
      fetchRooms(roomsPage, roomsSortBy);
    }
  }, [roomsPage, roomsSortBy]);

  // Reset formData when edit dialog opens
  useEffect(() => {
    if (isEditDialogOpen && map) {
      setFormData({
        name: map.name,
        description: map.description || '',
        mapUrl: map.mapUrl,
        previewImageUrl: map.previewImageUrl || '',
        sizeLabel: map.sizeLabel ? map.sizeLabel.toLowerCase() : '',
        order: map.order,
        isActive: map.isActive,
      });
      setPendingImageFile(null); // Reset pending file when dialog opens
    }
  }, [isEditDialogOpen, map]);

  async function fetchMap() {
    try {
      setLoading(true);
      setError(null);
      
      // Check if user is super admin
      let userIsSuperAdmin = false;
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const authResponse = await authenticatedFetch('/api/auth/me');
        if (authResponse.ok) {
          const authData = await authResponse.json();
          // Explicitly check for true value
          userIsSuperAdmin = authData.user?.isSuperAdmin === true;
        }
      } catch {
        // Not authenticated, continue as regular user
        userIsSuperAdmin = false;
      }
      // Always set the state explicitly
      setIsSuperAdmin(userIsSuperAdmin);
      
      let mapData: any = null;
      
      if (userIsSuperAdmin) {
        // Super admin can use admin API for full data
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(`/api/admin/templates/maps/${params.id}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            router.push('/admin/templates');
            return;
          }
          throw new Error('Failed to fetch map');
        }

        const data = await response.json();
        mapData = data.map;
      } else {
        // Regular users use public API - need to find map by searching through templates
        const templatesResponse = await fetch('/api/templates');
        if (!templatesResponse.ok) {
          throw new Error('Failed to fetch templates');
        }
        
        const templatesData = await templatesResponse.json();
        let foundMap: any = null;
        let foundTemplate: any = null;
        
        // Search through all templates to find the map
        for (const template of templatesData.templates || []) {
          // Fetch full template details to get maps
          const templateDetailResponse = await fetch(`/api/templates/${template.slug}`);
          if (templateDetailResponse.ok) {
            const detailData = await templateDetailResponse.json();
            const map = detailData.template.maps.find((m: any) => m.id === params.id);
            if (map) {
              foundMap = map;
              foundTemplate = detailData.template;
              break;
            }
          }
        }
        
        if (!foundMap) {
          router.push('/admin/templates');
          return;
        }
        
        // Transform the map data to match the expected structure
        mapData = {
          id: foundMap.id,
          slug: foundMap.slug,
          name: foundMap.name,
          description: foundMap.description,
          mapUrl: foundMap.mapUrl,
          previewImageUrl: foundMap.previewImageUrl,
          sizeLabel: foundMap.sizeLabel,
          order: foundMap.order,
          isActive: true, // Public API only returns active maps
          _count: {
            rooms: foundMap._count?.rooms || 0,
          },
          template: {
            id: foundTemplate.id || '',
            slug: foundTemplate.slug,
            name: foundTemplate.name,
            category: foundTemplate.category,
          },
        };
      }

      // Ensure template.id exists
      if (!mapData.template?.id) {
        throw new Error('Template ID not found');
      }

      setMap(mapData);
      setFormData({
        name: mapData.name,
        description: mapData.description || '',
        mapUrl: mapData.mapUrl,
        previewImageUrl: mapData.previewImageUrl || '',
        sizeLabel: mapData.sizeLabel ? mapData.sizeLabel.toLowerCase() : '',
        order: mapData.order,
        isActive: mapData.isActive,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load map');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!map) return;

    try {
      setSaving(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      // Upload image if there's a pending file
      let previewImageUrl = formData.previewImageUrl;
      if (pendingImageFile) {
        const uploadFormData = new FormData();
        uploadFormData.append('file', pendingImageFile);
        uploadFormData.append('mapId', map.id);

        const uploadResponse = await authenticatedFetch('/api/admin/templates/maps/upload-image', {
          method: 'POST',
          body: uploadFormData,
        });

        if (!uploadResponse.ok) {
          const data = await uploadResponse.json();
          throw new Error(data.error || 'Failed to upload image');
        }

        const uploadData = await uploadResponse.json();
        previewImageUrl = uploadData.url;
        setPendingImageFile(null);
      }
      
      const response = await authenticatedFetch(`/api/admin/templates/maps/${map.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description || null,
          mapUrl: formData.mapUrl,
          previewImageUrl: previewImageUrl || null,
          sizeLabel: formData.sizeLabel && formData.sizeLabel.trim() !== '' ? formData.sizeLabel.toLowerCase() : null,
          orientation: 'orthogonal', // Default value
          tileSize: 32, // Default value
          recommendedWorldTags: [], // Default value
          order: formData.order,
          isActive: formData.isActive,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save map');
      }

      const data = await response.json();
      const updatedMap = data.map;
      
      // Update map state immediately - use updatedMap as base to ensure all fields are fresh
      // Ensure we preserve all relations and counts
      const newMapState = {
        ...updatedMap,
        _count: updatedMap._count || map._count, // Use updated count if available, otherwise preserve
      };
      
      // Explicitly set previewImageUrl to ensure it's updated
      if (updatedMap.previewImageUrl !== undefined) {
        newMapState.previewImageUrl = updatedMap.previewImageUrl;
      }
      
      setMap(newMapState);

      // Also update formData to reflect the saved state
      setFormData({
        name: updatedMap.name,
        description: updatedMap.description || '',
        mapUrl: updatedMap.mapUrl,
        previewImageUrl: updatedMap.previewImageUrl || '',
        sizeLabel: updatedMap.sizeLabel ? updatedMap.sizeLabel.toLowerCase() : '',
        order: updatedMap.order,
        isActive: updatedMap.isActive,
      });

      setIsEditDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save map');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!map) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/templates/maps/${map.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete map');
      }

      router.push(map.template?.id ? `/admin/templates/templates/${map.template.id}` : '/admin/templates');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete map');
      setIsDeleteDialogOpen(false);
    }
  }

  async function fetchRooms(page: number = roomsPage, sortBy: 'created' | 'accesses' | 'stars' = roomsSortBy) {
    if (!params.id) return;
    
    try {
      setRoomsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/admin/templates/maps/${params.id}/rooms?page=${page}&limit=${roomsPerPage}&sortBy=${sortBy}`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch rooms');
      }

      const data = await response.json();
      setRooms(data.rooms || []);
      setRoomsPagination(data.pagination || null);
    } catch (err) {
      console.error('Error fetching rooms:', err);
      setRooms([]);
      setRoomsPagination(null);
    } finally {
      setRoomsLoading(false);
    }
  }

  function handleSortChange(sortBy: 'created' | 'accesses' | 'stars') {
    setRoomsSortBy(sortBy);
    setRoomsPage(1); // Reset to first page when sorting changes
  }

  useEffect(() => {
    async function fetchAnalyticsForRooms() {
      const missing = rooms.filter((room) => !analyticsByRoom[room.id]);
      if (missing.length === 0) return;

      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const results = await Promise.all(
          missing.map(async (room) => {
            try {
              const response = await authenticatedFetch(
                `/api/admin/analytics/rooms/${room.id}`,
              );
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

        const newAnalytics: Record<string, RoomAnalytics> = {};
        results.forEach((result) => {
          if (result) {
            newAnalytics[result.roomId] = {
              totalAccesses: result.totalAccesses,
              peakHour: result.peakHour,
              lastVisitedByUser: result.lastVisitedByUser,
              lastVisitedOverall: result.lastVisitedOverall,
            };
          }
        });

        if (Object.keys(newAnalytics).length > 0) {
          setAnalyticsByRoom((prev) => ({ ...prev, ...newAnalytics }));
        }
      } catch (err) {
        console.error('Error fetching analytics:', err);
      }
    }

    if (rooms.length > 0) {
      fetchAnalyticsForRooms();
    }
  }, [rooms, analyticsByRoom]);

  async function fetchManagedWorlds() {
    try {
      setWorldsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/worlds/managed');
      
      if (!response.ok) {
        throw new Error('Failed to fetch managed worlds');
      }

      const data = await response.json();
      setManagedWorlds(data.worlds || []);
    } catch (err) {
      console.error('Error fetching managed worlds:', err);
      setManagedWorlds([]);
    } finally {
      setWorldsLoading(false);
    }
  }

  function handleCreateRoom() {
    if (!map || !selectedWorldId) return;

    // Navigate to create room page with template map pre-selected
    setIsCreateRoomDialogOpen(false);
    router.push(`/admin/rooms/new?worldId=${selectedWorldId}&templateMapId=${map.id}`);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!map) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Map not found</AlertTitle>
          <AlertDescription>
            The map you're looking for doesn't exist.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href={map.template?.id ? `/admin/templates/templates/${map.template.id}` : '/admin/templates'}>
            <ChevronLeft className="h-4 w-4 mr-2" />
            Back to {map.template?.name || 'Templates'}
          </Link>
        </Button>
        {isSuperAdmin && (
          <Button variant="outline" onClick={() => setIsEditDialogOpen(true)}>
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
        )}
      </div>

      <div className="space-y-1">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">{map.name}</h1>
          <div className="flex items-center gap-1.5 mt-2">
            {map.template.category.icon && (
              <span className="text-sm">{map.template.category.icon}</span>
            )}
            <p className="text-xs text-muted-foreground">
              {map.template.category.name}
            </p>
          </div>
        </div>
        {map.description && (
          <p className="text-muted-foreground mt-2">{map.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {isSuperAdmin && (
            <Badge variant={map.isActive ? 'default' : 'secondary'}>
              {map.isActive ? 'Active' : 'Inactive'}
            </Badge>
          )}
          {map.sizeLabel && (
            <Badge variant="secondary">
              {map.sizeLabel.charAt(0).toUpperCase() + map.sizeLabel.slice(1).toLowerCase()} size
            </Badge>
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

      {/* Map Details */}
      <Card className="border-0">
        <CardContent className="p-6">
          {map.previewImageUrl ? (
            <div className="space-y-4">
              <img
                src={map.previewImageUrl}
                alt={map.name}
                className="w-full rounded-lg object-cover"
              />
              {managedWorlds.length > 0 && (
                <Button
                  onClick={() => setIsCreateRoomDialogOpen(true)}
                  className="w-full"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Room from Template
                </Button>
              )}
            </div>
          ) : (
            managedWorlds.length > 0 && (
              <Button
                onClick={() => setIsCreateRoomDialogOpen(true)}
                className="w-full"
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Room from Template
              </Button>
            )
          )}
        </CardContent>
      </Card>

      {/* Rooms Using This Map */}
      <div>
        <h2 className="text-2xl font-semibold mb-2">Rooms Using This Map</h2>
        <div className="flex items-center gap-2 text-sm mb-4">
          <MapPin className="h-4 w-4 text-muted-foreground" />
          <span>
            {map._count.rooms} {map._count.rooms === 1 ? 'room' : 'rooms'} using this map
          </span>
        </div>
        {map._count.rooms > 3 && (
          <div className="flex items-center gap-2 mb-4">
            <Label htmlFor="sortBy" className="text-sm text-muted-foreground">Sort by:</Label>
            <Select
              value={roomsSortBy}
              onValueChange={(value) => handleSortChange(value as 'created' | 'accesses' | 'stars')}
              disabled={roomsLoading}
            >
              <SelectTrigger id="sortBy" className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created">Date Created</SelectItem>
                <SelectItem value="accesses">Access Count</SelectItem>
                <SelectItem value="stars">Stars</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {roomsLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : rooms.length === 0 ? (
          <Card className="border-0">
            <CardContent className="py-12 text-center">
              <MapPin className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-muted-foreground">No rooms are using this map yet.</p>
              {managedWorlds.length > 0 && (
                <Button
                  onClick={() => setIsCreateRoomDialogOpen(true)}
                  className="mt-4"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create First Room
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {rooms.map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  analytics={analyticsByRoom[room.id]}
                />
              ))}
            </div>
            {roomsPagination && roomsPagination.totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <div className="text-sm text-muted-foreground">
                  Showing {(roomsPagination.page - 1) * roomsPagination.limit + 1} to {Math.min(roomsPagination.page * roomsPagination.limit, roomsPagination.total)} of {roomsPagination.total} {roomsPagination.total === 1 ? 'room' : 'rooms'}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRoomsPage(prev => Math.max(1, prev - 1))}
                    disabled={roomsPage === 1 || roomsLoading}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRoomsPage(prev => prev + 1)}
                    disabled={roomsPage >= (roomsPagination?.totalPages || 1) || roomsLoading}
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Create Room Dialog */}
      <Dialog open={isCreateRoomDialogOpen} onOpenChange={setIsCreateRoomDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Room from Template Map</DialogTitle>
            <DialogDescription>
              Select a world to create a room using this template map.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="world">World *</Label>
              {worldsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : managedWorlds.length === 0 ? (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    You don't have any worlds you can manage. Create a universe and world first.
                  </AlertDescription>
                </Alert>
              ) : (
                <Select
                  value={selectedWorldId}
                  onValueChange={setSelectedWorldId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a world" />
                  </SelectTrigger>
                  <SelectContent>
                    {managedWorlds.map((world) => (
                      <SelectItem key={world.id} value={world.id}>
                        {world.universe.name} · {world.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {map && (
              <div className="space-y-2">
                <Label>Template Map</Label>
                <div className="p-3 bg-muted rounded-md">
                  <p className="font-medium">{map.name}</p>
                  {map.description && (
                    <p className="text-sm text-muted-foreground mt-1">{map.description}</p>
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateRoomDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateRoom}
              disabled={!selectedWorldId || worldsLoading || managedWorlds.length === 0}
            >
              Create Room
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader className="relative">
            <DialogTitle>Edit Map</DialogTitle>
            <DialogDescription>Update map details</DialogDescription>
            <Button
              variant="destructive"
              size="sm"
              className="absolute top-0 right-0"
              onClick={() => {
                setIsEditDialogOpen(false);
                setIsDeleteDialogOpen(true);
              }}
              disabled={map._count.rooms > 0}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mapUrl">Map URL *</Label>
              <Input
                id="mapUrl"
                type="url"
                value={formData.mapUrl}
                onChange={(e) => setFormData({ ...formData, mapUrl: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <ImageUpload
                value={formData.previewImageUrl}
                onChange={(url) => setFormData({ ...formData, previewImageUrl: url })}
                mapId={map.id}
                disabled={saving}
                deferUpload={true}
                onFileChange={(file) => setPendingImageFile(file)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sizeLabel">Size Label</Label>
                <Select
                  key={`size-select-${map?.id}-${map?.sizeLabel || 'empty'}`}
                  value={formData.sizeLabel && formData.sizeLabel.trim() !== '' ? formData.sizeLabel : undefined}
                  onValueChange={(value) => setFormData({ ...formData, sizeLabel: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select size (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Small</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="large">Large</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="order">Order</Label>
                <Input
                  id="order"
                  type="number"
                  value={formData.order}
                  onChange={(e) => setFormData({ ...formData, order: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, isActive: checked === true })
                }
              />
              <Label htmlFor="isActive" className="font-normal cursor-pointer">
                Active
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !formData.name || !formData.mapUrl}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Map</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{map.name}"? This action cannot be undone.
              {map._count.rooms > 0 && (
                <span className="block mt-2 text-destructive">
                  This map has {map._count.rooms} room(s) and cannot be deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={map._count.rooms > 0}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

