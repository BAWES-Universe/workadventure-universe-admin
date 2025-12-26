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
import { ChevronRight, AlertCircle, Loader2, Edit, Trash2, Navigation, CheckCircle2, Star, Activity, ChevronLeft, Users, X } from 'lucide-react';
import { TemplateLibrary } from '@/components/templates/TemplateLibrary';
import { TemplateDetail } from '@/components/templates/TemplateDetail';
import { cn } from '@/lib/utils';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string | null;
  wamUrl: string | null;
  templateMapId: string | null;
  templateMap?: {
    id: string;
    name: string;
    template: {
      id: string;
      slug: string;
      name: string;
      category: {
        name: string;
      };
    };
  } | null;
  isPublic: boolean;
  canEdit?: boolean;
  isStarred?: boolean;
  starCount?: number;
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
  const [togglingStar, setTogglingStar] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'analytics'>('details');
  const [visitorsPage, setVisitorsPage] = useState(1);
  const visitorsPerPage = 10;
  
  const { wa, isReady: waReady, navigateToRoom } = useWorkAdventure();
  
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    templateMapId: null as string | null,
    isPublic: true,
  });
  const [useCustomMap, setUseCustomMap] = useState(false);
  const [selectedTemplateSlug, setSelectedTemplateSlug] = useState<string | null>(null);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [selectedMapUrl, setSelectedMapUrl] = useState<string | null>(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState<string | null>(null);
  const [selectedMapName, setSelectedMapName] = useState<string | null>(null);
  const [isChangingTemplate, setIsChangingTemplate] = useState(false);
  const [originalTemplateMapId, setOriginalTemplateMapId] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();
    fetchRoom();
  }, [id]);

  useEffect(() => {
    if (room) {
      // Fetch analytics on initial load to show totalAccesses count
      fetchAnalytics(1);
    }
  }, [room, id]);

  useEffect(() => {
    if (activeTab === 'analytics' && room) {
      // Fetch analytics when switching to analytics tab or changing page
      fetchAnalytics(visitorsPage);
    }
  }, [visitorsPage, activeTab, room]);

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
        templateMapId: data.templateMapId || null,
        isPublic: data.isPublic,
      });
      // If room has a templateMap, default to template mode; otherwise use custom map mode
      setUseCustomMap(!data.templateMapId);
      // Preserve original templateMapId for restoration when switching back from custom map
      setOriginalTemplateMapId(data.templateMapId || null);
      // Don't set selectedMapId on initial load - we'll use room.templateMapId to check if template exists
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load room');
    } finally {
      setLoading(false);
    }
  }

  function handleSelectTemplate(templateSlug: string) {
    setSelectedTemplateSlug(templateSlug);
    setIsChangingTemplate(false); // Reset flag when template is selected
  }

  async function handleSelectMap(mapId: string, mapUrl: string) {
    setSelectedMapId(mapId);
    setSelectedMapUrl(mapUrl);
    setFormData(prev => ({
      ...prev,
      templateMapId: mapId,
      mapUrl: mapUrl,
    }));
    
    // Fetch template name for display
    if (selectedTemplateSlug) {
      try {
        const response = await fetch(`/api/templates/${selectedTemplateSlug}`);
        const data = await response.json();
        if (data.template) {
          setSelectedTemplateName(data.template.name);
          const map = data.template.maps.find((m: any) => m.id === mapId);
          if (map) {
            setSelectedMapName(map.name);
          }
        }
      } catch (err) {
        console.error('Failed to fetch template details:', err);
      }
    }
    
    // Close template selection after map is selected
    setSelectedTemplateSlug(null);
    setIsChangingTemplate(false); // Reset changing template flag
  }

  function handleBackToTemplates() {
    setSelectedTemplateSlug(null);
    // If we were changing template, go back to showing current template
    if (isChangingTemplate && room?.templateMap) {
      setIsChangingTemplate(false);
      setSelectedMapId(null);
      setSelectedMapUrl(null);
      setSelectedTemplateName(null);
      setSelectedMapName(null);
      setFormData(prev => ({
        ...prev,
        templateMapId: room.templateMap!.id,
      }));
    }
  }


  async function fetchAnalytics(page: number = 1) {
    try {
      setAnalyticsLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/rooms/${id}?page=${page}&limit=${visitorsPerPage}`);
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

    // Validate based on mode
    if (useCustomMap) {
      if (!formData.mapUrl || formData.mapUrl.trim() === '') {
        setError('Map URL is required when using custom map');
        setSaving(false);
        return;
      }
    } else {
      if (!formData.templateMapId) {
        setError('Template map is required');
        setSaving(false);
        return;
      }
    }

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      // Build request body based on mode
      const requestBody: any = {
        slug: formData.slug,
        name: formData.name,
        description: formData.description || null,
        isPublic: formData.isPublic,
      };
      
      if (useCustomMap) {
        requestBody.mapUrl = formData.mapUrl.trim();
        requestBody.templateMapId = null; // Clear template reference
      } else {
        requestBody.templateMapId = formData.templateMapId;
        // Don't send mapUrl - API will set it from template
      }
      
      const response = await authenticatedFetch(`/api/admin/rooms/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
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

  async function handleToggleStar() {
    if (!room || !currentUser) return;

    const previousIsStarred = room.isStarred;
    const previousStarCount = room.starCount || 0;

    // Optimistic update
    setRoom({
      ...room,
      isStarred: !previousIsStarred,
      starCount: previousIsStarred ? previousStarCount - 1 : previousStarCount + 1,
    });

    try {
      setTogglingStar(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${id}/favorite`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to toggle star');
      }

      const data = await response.json();
      setRoom({
        ...room,
        isStarred: data.isStarred,
        starCount: data.starCount,
      });
    } catch (err) {
      // Revert on error
      setRoom({
        ...room,
        isStarred: previousIsStarred,
        starCount: previousStarCount,
      });
      alert(err instanceof Error ? err.message : 'Failed to toggle star');
    } finally {
      setTogglingStar(false);
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

      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-4xl font-bold tracking-tight">{room.name}</h1>
          <div className="flex items-center gap-2">
            {room.canEdit !== false && (
              <Badge variant={room.isPublic ? 'default' : 'secondary'}>
                {room.isPublic ? 'Public' : 'Private'}
              </Badge>
            )}
          </div>
        </div>
        <p className="text-muted-foreground">
          In <Link href={`/admin/worlds/${room.world.id}`} className="text-primary hover:underline">{room.world.name}</Link>
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
              Slug: <code className="bg-muted px-1.5 py-0.5 rounded text-sm">{room.slug}</code>
            </span>
          </p>
          {!isEditing && (
            <div className="flex flex-wrap gap-2">
              {currentUser && (
                <Button
                  variant="outline"
                  onClick={handleToggleStar}
                  disabled={togglingStar}
                >
                  {togglingStar ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Star className={`mr-2 h-4 w-4 ${room.isStarred ? 'fill-yellow-400 text-yellow-400' : ''}`} />
                  )}
                  {room.starCount !== undefined ? room.starCount : 0}
                </Button>
              )}
              {room.canEdit !== false && (
                <Button variant="outline" onClick={() => setIsEditing(true)}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </Button>
              )}
            </div>
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
        <>
          {/* Template/Custom Map Toggle - At the top */}
          <div className="flex items-center gap-4">
            <Button
              type="button"
              variant={!useCustomMap ? 'default' : 'outline'}
              onClick={() => {
                setUseCustomMap(false);
                // Restore original templateMapId if it existed
                if (originalTemplateMapId || room?.templateMapId) {
                  const templateIdToRestore = originalTemplateMapId || room?.templateMapId;
                  setFormData(prev => ({
                    ...prev,
                    templateMapId: templateIdToRestore,
                  }));
                }
                // If switching back to template and no map selected, show template selection
                if (!formData.templateMapId && !selectedMapId && !originalTemplateMapId && !room?.templateMapId) {
                  setSelectedTemplateSlug(null);
                }
              }}
            >
              Use Template
            </Button>
            <Button
              type="button"
              variant={useCustomMap ? 'default' : 'outline'}
              onClick={() => {
                setUseCustomMap(true);
                // Clear template selection when switching to custom map
                setSelectedTemplateSlug(null);
                setSelectedMapId(null);
                setSelectedMapUrl(null);
                setSelectedTemplateName(null);
                setSelectedMapName(null);
                setIsChangingTemplate(false);
                // Clear templateMapId from form data
                setFormData(prev => ({
                  ...prev,
                  templateMapId: null,
                }));
              }}
            >
              Custom Map (Advanced)
            </Button>
          </div>

          {/* Template Selection Flow - Only show when using template */}
          {!useCustomMap && (
            <>
              {selectedTemplateSlug ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Select Template</CardTitle>
                    <CardDescription>
                      Choose a template to get started, or switch to custom map.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <TemplateDetail
                      templateSlug={selectedTemplateSlug}
                      onSelectMap={handleSelectMap}
                      onBack={handleBackToTemplates}
                      selectedMapId={selectedMapId || room?.templateMapId || undefined}
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>Template Map</CardTitle>
                    <CardDescription>
                      {room?.templateMap 
                        ? 'Current template map for this room. Click "Change Template" to select a different one.'
                        : 'Choose a template to get started, or switch to custom map.'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {selectedTemplateSlug ? null : isChangingTemplate || !room?.templateMapId ? (
                      <TemplateLibrary onSelectTemplate={handleSelectTemplate} />
                    ) : selectedMapId && selectedTemplateName && selectedMapName ? (
                      <div className="p-4 border rounded-lg bg-muted/50">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="text-sm font-medium mb-1">Selected Template Map</div>
                            <div className="text-sm text-muted-foreground">
                              <div><strong>Template:</strong> {selectedTemplateName}</div>
                              <div><strong>Map:</strong> {selectedMapName}</div>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              // Show template library to change template
                              setIsChangingTemplate(true);
                              setSelectedTemplateSlug(null);
                              setSelectedMapId(null);
                              setSelectedMapUrl(null);
                              setSelectedTemplateName(null);
                              setSelectedMapName(null);
                            }}
                          >
                            Change Template
                          </Button>
                        </div>
                      </div>
                    ) : room?.templateMap && !selectedMapId ? (
                      <div className="p-4 border rounded-lg bg-muted/50">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="text-sm font-medium mb-1">Current Template Map</div>
                            <div className="text-sm text-muted-foreground">
                              <div><strong>Template:</strong> {room.templateMap.template.category.name} - {room.templateMap.template.name}</div>
                              <div><strong>Map:</strong> {room.templateMap.name}</div>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              // Show template library to change template
                              setIsChangingTemplate(true);
                              setSelectedTemplateSlug(null);
                              setSelectedMapId(null);
                              setSelectedMapUrl(null);
                              setSelectedTemplateName(null);
                              setSelectedMapName(null);
                            }}
                          >
                            Change Template
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* Room Form - Only show when not using template, or when template map is selected (and not actively selecting) */}
          {(!useCustomMap ? ((selectedMapId || room?.templateMapId) && !selectedTemplateSlug && !isChangingTemplate) : true) && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Room Details</CardTitle>
                    <CardDescription>
                      {!useCustomMap && (selectedMapId || room?.templateMapId)
                        ? 'Review and customize your room details. Map is set from template.'
                        : 'Update the room details below.'}
                    </CardDescription>
                  </div>
                  {room.canEdit !== false && (
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

                {/* Custom Map URL Input - Only show when using custom map */}
                {useCustomMap && (
                  <div className="space-y-2">
                    <Label htmlFor="mapUrl">
                      Map URL <span className="text-destructive">*</span>
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      External TMJ map URL for this room (e.g., https://example.com/map.tmj). Each room must have its own map.
                    </p>
                    <Input
                      id="mapUrl"
                      type="url"
                      required
                      value={formData.mapUrl}
                      onChange={(e) => setFormData({ ...formData, mapUrl: e.target.value })}
                    />
                    {room?.templateMapId && (
                      <p className="text-xs text-muted-foreground mt-1">
                        ⚠️ Switching to custom map will disconnect this room from the template.
                      </p>
                    )}
                  </div>
                )}

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
          )}
        </>
      ) : (
        <>
          {/* Visit Button / Current Room Alert */}
          <div className="w-full">
            {isInCurrentRoom ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                <div className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-sm font-medium text-foreground">You are currently in this room</span>
              </div>
            ) : (
              <Button
                variant="default"
                className="w-full"
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
          </div>

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
              <section className="space-y-3">
                <div>
                  <h3 className="text-xl font-semibold mb-2">About this Room</h3>
                  {room.description ? (
                    <div className="text-sm text-foreground whitespace-pre-line">
                      {room.description}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      No description provided
                    </div>
                  )}
                </div>
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

                            {isSuperAdmin && access.ipAddress && (
                              <div className="text-xs text-muted-foreground font-mono mb-2">
                                {access.ipAddress}
                              </div>
                            )}
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
                      Visitor activity will appear here once people start accessing this room.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent />
                </Empty>
              )}
            </>
          )}
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
