'use client';

import { localPeakHour } from '@/lib/analytics-peak';
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight, Loader2, Edit, Trash2, AlertCircle, ExternalLink, Plus, Star } from 'lucide-react';
import { ImageUpload } from '@/components/templates/ImageUpload';
import { Context, EmptyCard, EntityRow, InContext, LoadError, LoadingRows, PageHeader, SectionHeader, SettingSwitch, Settings, StatLine, VisitLine, count } from '../../../components/ds';
import { FactPill, InactivePill } from '../../components/template-bits';

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

function RoomRow({ room, analytics }: { room: Room; analytics?: RoomAnalytics }) {
  const favorites = room._count?.favorites ?? 0;
  const you = analytics?.lastVisitedByUser?.accessedAt ?? null;
  const latest = analytics?.lastVisitedOverall?.accessedAt ?? null;

  return (
    <EntityRow
      href={`/admin/rooms/${room.id}`}
      kind="room"
      title={room.name}
      context={<Context parts={[{ label: room.world.universe.name }, { label: room.world.name }]} />}
      meta={
        analytics ? (
          <>
            <StatLine
              items={[
                count(analytics.totalAccesses, 'access', 'accesses'),
                analytics.peakHour !== null && `Peak ${formatHourTo12Hour(analytics.peakHour)}`,
              ]}
            />
            {you || latest ? (
              <VisitLine you={you} latest={latest} youWereLast={!!you && you === latest} />
            ) : (
              <StatLine items={['No visits yet']} />
            )}
          </>
        ) : (
          <StatLine items={['Loading visits…']} />
        )
      }
      aside={
        <span className="inline-flex items-center gap-1" aria-label={count(favorites, 'star') ?? undefined}>
          <Star className="h-3.5 w-3.5" aria-hidden="true" />
          {favorites}
        </span>
      }
    />
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
  const [roomsFailed, setRoomsFailed] = useState(false);
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
      setRoomsFailed(false);
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
      setRoomsFailed(true);
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
              
              // Peak: the busiest hour of all visits, on your clock.
              const peakHour = localPeakHour(data.peakTimes);

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

  const sizeText = map.sizeLabel ? `${map.sizeLabel.charAt(0).toUpperCase()}${map.sizeLabel.slice(1).toLowerCase()} size` : null;

  return (
    <div className="space-y-8">
      <PageHeader
        kind="map"
        title={map.name}
        context={
          <InContext
            parts={[
              {
                label: map.template.category.icon ? `${map.template.category.icon} ${map.template.category.name}` : map.template.category.name,
                href: `/admin/templates/categories/${map.template.category.id}`,
              },
              { label: map.template.name, href: `/admin/templates/templates/${map.template.id}` },
            ]}
          />
        }
        status={
          <>
            {sizeText && <FactPill>{sizeText}</FactPill>}
            {isSuperAdmin && !map.isActive && <InactivePill />}
          </>
        }
        actions={
          managedWorlds.length > 0 || isSuperAdmin ? (
            <>
              {managedWorlds.length > 0 && (
                <Button className="h-11" onClick={() => setIsCreateRoomDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create a room from this map
                </Button>
              )}
              {isSuperAdmin && (
                <Button variant="outline" className="h-11" onClick={() => setIsEditDialogOpen(true)}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit map
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {map.description && <p className="max-w-3xl text-sm text-foreground/80">{map.description}</p>}
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Map Details */}
      {map.previewImageUrl && (
        <div className="overflow-hidden rounded-2xl border bg-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={map.previewImageUrl} alt={map.name} className="w-full object-cover" />
        </div>
      )}

      {isSuperAdmin && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          Map key <code className="rounded bg-muted px-1 text-foreground">{map.slug}</code>
          {' · '}
          <a href={map.mapUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
            Map file
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </p>
      )}

      {/* Rooms Using This Map */}
      <section aria-labelledby="map-rooms">
        <SectionHeader id="map-rooms" title="Rooms using this map" count={map._count.rooms} />
        {map._count.rooms > 3 && (
          <div className="mb-4 flex items-center gap-2">
            <Label htmlFor="sortBy" className="text-sm text-muted-foreground">Sort by</Label>
            <Select
              value={roomsSortBy}
              onValueChange={(value) => handleSortChange(value as 'created' | 'accesses' | 'stars')}
              disabled={roomsLoading}
            >
              <SelectTrigger id="sortBy" className="h-11 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created">Date created</SelectItem>
                <SelectItem value="accesses">Access count</SelectItem>
                <SelectItem value="stars">Stars</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {roomsLoading ? (
          <LoadingRows label="rooms using this map" rows={3} />
        ) : roomsFailed ? (
          <LoadError label="the rooms using this map" retry={() => fetchRooms(roomsPage, roomsSortBy)} />
        ) : rooms.length === 0 ? (
          <EmptyCard
            kind="room"
            title="No rooms use this map yet"
            text={managedWorlds.length > 0 ? 'Create a room from this map in one of your worlds.' : 'Rooms started from this map will show here.'}
          />
        ) : (
          <>
            <div>
              {rooms.map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  analytics={analyticsByRoom[room.id]}
                />
              ))}
            </div>
            {roomsPagination && roomsPagination.totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
                <div className="text-sm text-muted-foreground">
                  Showing {(roomsPagination.page - 1) * roomsPagination.limit + 1} to {Math.min(roomsPagination.page * roomsPagination.limit, roomsPagination.total)} of {roomsPagination.total} {roomsPagination.total === 1 ? 'room' : 'rooms'}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={() => setRoomsPage(prev => Math.max(1, prev - 1))}
                    disabled={roomsPage === 1 || roomsLoading}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
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
      </section>

      {/* Create Room Dialog */}
      <Dialog open={isCreateRoomDialogOpen} onOpenChange={setIsCreateRoomDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a room from this map</DialogTitle>
            <DialogDescription>
              Choose the world the new room goes in.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="world">
                World <span className="text-destructive">*</span>
              </Label>
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
                  <SelectTrigger id="world" className="h-11">
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
                <Label>Map</Label>
                <div className="p-3 bg-muted rounded-md">
                  <p className="font-medium">{map.name}</p>
                  {map.description && (
                    <p className="text-sm text-muted-foreground mt-1">{map.description}</p>
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11" onClick={() => setIsCreateRoomDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-11"
              onClick={handleCreateRoom}
              disabled={!selectedWorldId || worldsLoading || managedWorlds.length === 0}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit map</DialogTitle>
            <DialogDescription>Change how this map shows in the template library.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                className="h-11"
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
              <Label htmlFor="mapUrl">
                Map URL <span className="text-destructive">*</span>
              </Label>
              <Input
                id="mapUrl"
                className="h-11"
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
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sizeLabel">Size</Label>
                <Select
                  key={`size-select-${map?.id}-${map?.sizeLabel || 'empty'}`}
                  value={formData.sizeLabel && formData.sizeLabel.trim() !== '' ? formData.sizeLabel : undefined}
                  onValueChange={(value) => setFormData({ ...formData, sizeLabel: value })}
                >
                  <SelectTrigger id="sizeLabel" className="h-11">
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
                  className="h-11"
                  type="number"
                  value={formData.order}
                  onChange={(e) => setFormData({ ...formData, order: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>
            <Settings label="Library">
              <SettingSwitch
                id="isActive"
                label="Active"
                hint="Offered when people start a room from this template. Off: hidden."
                checked={formData.isActive}
                onChange={(checked) => setFormData({ ...formData, isActive: checked })}
              />
            </Settings>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="h-11 text-destructive hover:text-destructive sm:mr-auto"
              onClick={() => {
                setIsEditDialogOpen(false);
                setIsDeleteDialogOpen(true);
              }}
              disabled={map._count.rooms > 0}
              title={map._count.rooms > 0 ? 'Rooms use this map, so it can’t be deleted.' : undefined}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
            <Button variant="outline" className="h-11" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button className="h-11" onClick={handleSave} disabled={saving || !formData.name || !formData.mapUrl}>
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
            <AlertDialogTitle>Delete map</AlertDialogTitle>
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

