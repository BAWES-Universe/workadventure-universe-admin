'use client';

import { PersonIcon } from '../../components/profile-card';

import { useState, useEffect, type ReactNode } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useWorkAdventure } from '@/app/admin/workadventure-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, Loader2, Navigation, Pencil, Star, Trash2 } from 'lucide-react';
import { TemplateLibrary } from '@/components/templates/TemplateLibrary';
import { TemplateDetail } from '@/components/templates/TemplateDetail';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/time-ago';
import {
  EmptyCard,
  EntityRow,
  Figure,
  Figures,
  InContext,
  KindIcon,
  LoadingRows,
  PageHeader,
  RolePills,
  SectionHeader,
  StatLine,
  StatusPill,
} from '../../components/ds';

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
    previewImageUrl: string | null;
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

/** "4 PM": the hour a room is busiest, in the same short form everywhere. */
function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

const tabClass = (active: boolean) =>
  `py-3 px-1 border-b-2 font-medium text-sm ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'}`;

/** A visitor without an account: the same look as a row, with nothing to open. */
function StaticRow({ title, context, meta, woka }: { title: string; context?: ReactNode; meta?: ReactNode; woka?: string[] }) {
  return (
    <div className="flex min-h-[68px] items-center gap-3 rounded-[18px] border border-border bg-card px-3.5 py-3 [&+&]:mt-2">
      <PersonIcon woka={woka} name={title} />
      <div className="grid min-w-0 flex-1 gap-[3px]">
        <strong className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{title}</strong>
        {context}
        {meta}
      </div>
    </div>
  );
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
  const [selectedMapPreviewImageUrl, setSelectedMapPreviewImageUrl] = useState<string | null>(null);
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
    
    // Fetch template name and map preview image for display
    if (selectedTemplateSlug) {
      try {
        const response = await fetch(`/api/templates/${selectedTemplateSlug}`);
        const data = await response.json();
        if (data.template) {
          setSelectedTemplateName(data.template.name);
          const map = data.template.maps.find((m: any) => m.id === mapId);
          if (map) {
            setSelectedMapName(map.name);
            setSelectedMapPreviewImageUrl(map.previewImageUrl || null);
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
        // Explicitly don't send mapUrl - API will set it from template
        // This ensures the old mapUrl value doesn't interfere
        requestBody.mapUrl = undefined;
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
    return <LoadingRows label="this room" rows={3} />;
  }

  if (!room) {
    return <EmptyCard kind="room" title="Room not found." text="It may have been deleted, or you may not have access to it." />;
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

  const visits = typeof analytics?.totalAccesses === 'number' ? analytics.totalAccesses : null;
  const canEdit = room.canEdit !== false;

  return (
    <div className="space-y-8">
      <PageHeader
        kind="room"
        title={room.name}
        context={
          <InContext
            parts={[
              { label: room.world.universe.name, href: `/admin/universes/${room.world.universe.id}` },
              { label: room.world.name, href: `/admin/worlds/${room.world.id}` },
            ]}
          />
        }
        status={
          isInCurrentRoom || canEdit ? (
            <>
              {isInCurrentRoom && <StatusPill status="live" />}
              {canEdit && <StatusPill status={room.isPublic ? 'public' : 'private'} />}
            </>
          ) : undefined
        }
        stats={
          visits !== null || peakHour !== null ? (
            <Figures>
              {visits !== null && <Figure value={visits} label={visits === 1 ? 'visit' : 'visits'} />}
              {peakHour !== null && <Figure value={formatHour(peakHour)} label="busiest" />}
            </Figures>
          ) : undefined
        }
        actions={
          isEditing ? (
            canEdit ? (
              <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
                <Trash2 aria-hidden="true" />
                Delete
              </Button>
            ) : undefined
          ) : (
            <>
              {!isInCurrentRoom && (
                <Button
                  onClick={handleVisitRoomInUniverse}
                  disabled={waNavigating || !waReady}
                  title={!waReady ? 'WorkAdventure API not available (only works in iframe)' : undefined}
                >
                  {waNavigating ? (
                    <>
                      <Loader2 className="animate-spin" aria-hidden="true" />
                      Navigating...
                    </>
                  ) : (
                    <>
                      <Navigation aria-hidden="true" />
                      Visit
                    </>
                  )}
                </Button>
              )}
              {currentUser && (
                <Button variant="outline" onClick={handleToggleStar} disabled={togglingStar} aria-pressed={!!room.isStarred}>
                  {togglingStar ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Star
                      aria-hidden="true"
                      className={cn(room.isStarred && 'fill-[var(--kind-star-solid)] text-[var(--kind-star-solid)]')}
                    />
                  )}
                  {room.starCount !== undefined ? room.starCount : 0}
                </Button>
              )}
              {canEdit && (
                <Button variant="outline" onClick={() => setIsEditing(true)}>
                  <Pencil aria-hidden="true" />
                  Edit
                </Button>
              )}
            </>
          )
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
        <>
          {/* Template/Custom Map Toggle - At the top */}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Map source">
            <Button
              type="button"
              variant={!useCustomMap ? 'secondary' : 'outline'}
              aria-pressed={!useCustomMap}
              onClick={() => {
                setUseCustomMap(false);
                // If room has a template, restore it
                if (originalTemplateMapId || room?.templateMapId) {
                  const templateIdToRestore = originalTemplateMapId || room?.templateMapId;
                  setFormData(prev => ({
                    ...prev,
                    templateMapId: templateIdToRestore,
                  }));
                  // Clear any new selection when restoring original
                  setSelectedMapId(null);
                  setSelectedMapUrl(null);
                  setSelectedTemplateName(null);
                  setSelectedMapName(null);
                } else {
                  // If no original template, clear everything to show template library
                  setSelectedTemplateSlug(null);
                  setSelectedMapId(null);
                  setSelectedMapUrl(null);
                  setSelectedTemplateName(null);
                  setSelectedMapName(null);
                  setFormData(prev => ({
                    ...prev,
                    templateMapId: null,
                  }));
                }
              }}
            >
              Use a template
            </Button>
            <Button
              type="button"
              variant={useCustomMap ? 'secondary' : 'outline'}
              aria-pressed={useCustomMap}
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
              Custom map (advanced)
            </Button>
          </div>

          {/* Template Selection Flow - Only show when using template */}
          {!useCustomMap && (
            <>
              {selectedTemplateSlug ? (
                <Card className="border-0 shadow-none">
                  <div className="p-6 pb-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleBackToTemplates}
                      className="gap-2 -ml-2"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Back
                    </Button>
                  </div>
                  <CardContent className="pt-4">
                    <TemplateDetail
                      templateSlug={selectedTemplateSlug}
                      onSelectMap={handleSelectMap}
                      onBack={handleBackToTemplates}
                      selectedMapId={selectedMapId || room?.templateMapId || undefined}
                      hideBackButton={true}
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card className="border-0 shadow-none">
                  {isChangingTemplate ? (
                    <>
                      <div className="p-6 pb-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setIsChangingTemplate(false);
                            // Restore original template if it existed
                            if (originalTemplateMapId || room?.templateMapId) {
                              const templateIdToRestore = originalTemplateMapId || room?.templateMapId;
                              setFormData(prev => ({
                                ...prev,
                                templateMapId: templateIdToRestore,
                              }));
                            }
                          }}
                          className="gap-2 -ml-2"
                        >
                          <ChevronLeft className="h-4 w-4" />
                          Back
                        </Button>
                      </div>
                      <CardContent className="pt-4">
                        <TemplateLibrary onSelectTemplate={handleSelectTemplate} />
                      </CardContent>
                    </>
                  ) : (
                    <>
                      <CardHeader>
                        <CardTitle>Template map</CardTitle>
                        {!room?.templateMap && <CardDescription>Choose a template to start from.</CardDescription>}
                      </CardHeader>
                      <CardContent>
                        {selectedMapId && selectedTemplateName && selectedMapName ? (
                          <div className="rounded-lg bg-muted/50 border border-border/70 overflow-hidden">
                            {selectedMapPreviewImageUrl ? (
                              <div className="relative w-full h-48 overflow-hidden bg-muted">
                                <img
                                  src={selectedMapPreviewImageUrl}
                                  alt={selectedMapName}
                                  className="w-full h-full object-cover"
                                  onError={(e) => {
                                    const container = (e.target as HTMLImageElement).parentElement;
                                    if (container) {
                                      container.style.display = 'none';
                                    }
                                  }}
                                />
                              </div>
                            ) : null}
                            <div className="p-4">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium mb-1">Selected template map</div>
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
                                    setSelectedMapPreviewImageUrl(null);
                                  setSelectedTemplateName(null);
                                  setSelectedMapName(null);
                                }}
                              >
                                Change template
                              </Button>
                              </div>
                            </div>
                          </div>
                        ) : room?.templateMap && !selectedMapId ? (
                          <div className="rounded-lg bg-muted/50 border border-border/70 overflow-hidden">
                            {room.templateMap.previewImageUrl ? (
                              <div className="relative w-full h-48 overflow-hidden bg-muted">
                                <img
                                  src={room.templateMap.previewImageUrl}
                                  alt={room.templateMap.name}
                                  className="w-full h-full object-cover"
                                  onError={(e) => {
                                    const container = (e.target as HTMLImageElement).parentElement;
                                    if (container) {
                                      container.style.display = 'none';
                                    }
                                  }}
                                />
                              </div>
                            ) : null}
                            <div className="p-4">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium mb-1">Current template map</div>
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
                                    setSelectedMapPreviewImageUrl(null);
                                  setSelectedTemplateName(null);
                                  setSelectedMapName(null);
                                }}
                              >
                                Change template
                              </Button>
                              </div>
                            </div>
                          </div>
                        ) : !room?.templateMapId ? (
                          <TemplateLibrary onSelectTemplate={handleSelectTemplate} />
                        ) : null}
                      </CardContent>
                    </>
                  )}
                </Card>
              )}
            </>
          )}

          {/* Room Form - Only show when not using template, or when template map is selected (and not actively selecting) */}
          {(!useCustomMap ? ((selectedMapId || room?.templateMapId) && !selectedTemplateSlug && !isChangingTemplate) : true) && (
            <Card className="border-0 shadow-none">
              <CardHeader>
                <CardTitle>Room details</CardTitle>
                {!useCustomMap && (selectedMapId || room?.templateMapId) && (
                  <CardDescription>The map comes from the template.</CardDescription>
                )}
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
                    variant="outline"
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
                      'Save changes'
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <>
          <nav className="flex flex-wrap gap-x-6 border-b border-border" aria-label="Room sections">
            <button type="button" onClick={() => setActiveTab('details')} className={tabClass(activeTab === 'details')}>
              Details
            </button>
            <button type="button" onClick={() => setActiveTab('analytics')} className={tabClass(activeTab === 'analytics')}>
              Visitors
            </button>
          </nav>

          {activeTab === 'details' && (
            <section aria-labelledby="room-about" className="space-y-2">
              <SectionHeader id="room-about" title="About" />
              {room.description ? (
                <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/85">{room.description}</p>
              ) : (
                <p className="text-sm text-muted-foreground">No description yet.</p>
              )}
            </section>
          )}

          {activeTab === 'analytics' && (
            <section aria-labelledby="room-visitors">
              {analyticsLoading ? (
                <LoadingRows label="visitors" rows={3} />
              ) : analytics && analytics.recentActivity && analytics.recentActivity.length > 0 ? (
                <div className="space-y-4">
                  <SectionHeader id="room-visitors" title="Recent visitors" count={analytics.pagination?.total} />
                  <div>
                    {analytics.recentActivity.map((access: Visit) => {
                      const userName = access.userName || access.userEmail || access.userUuid || 'Guest';
                      const roles: string[] = access.hasMembership && access.membershipTags.length > 0 ? access.membershipTags : [];
                      const context = (
                        <StatLine
                          items={[
                            roles.length > 0 ? null : access.isAuthenticated ? 'Signed in' : 'Guest',
                            timeAgo(new Date(access.accessedAt)),
                          ]}
                        />
                      );
                      const meta =
                        roles.length > 0 || (isSuperAdmin && access.ipAddress) ? (
                          <span className="flex flex-wrap items-center gap-2">
                            {roles.length > 0 && <RolePills roles={roles} />}
                            {isSuperAdmin && access.ipAddress && (
                              <span className="font-mono text-xs text-muted-foreground">{access.ipAddress}</span>
                            )}
                          </span>
                        ) : undefined;
                      return access.userId ? (
                        <EntityRow
                          key={access.id}
                          href={`/admin/users/${access.userId}`}
                          kind="people"
                          leading={<PersonIcon woka={access.woka} name={userName} />}
                          title={userName}
                          context={context}
                          meta={meta}
                        />
                      ) : (
                        <StaticRow key={access.id} title={userName} context={context} meta={meta} woka={access.woka} />
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
                <EmptyCard kind="people" title="No visitors yet." text="Visits to this room show up here." />
              )}
            </section>
          )}
        </>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete room</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{room.name}&quot;? This action cannot be undone.
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
