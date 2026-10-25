'use client';

import { useIsSuperAdmin } from '../../admin-bootstrap-context';

import RecentVisitors from '../../components/recent-visitors';
import UniverseMembersRow from '../../components/universe-members-row';
import { VisitorPeople } from '../../components/visitor-people';
import { AddButton, BrowseButton, By, PlaceHero, Rank, SectionHead, StarButton, WorldGroups, playPathOf, type WorldGroupData } from '../../components/place-hero';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
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
import { AlertCircle, Loader2, Plus, Edit, Trash2 } from 'lucide-react';
import { activityStats } from '@/lib/analytics-peak';
import { useEntitySummaries } from '../../hooks/use-entity-summaries';
import { useHere, useStarToggle, useUniverseRank, useWorldRooms } from '../../hooks/use-place-data';
import { EmptyCard, EntityCard, EntityRow, Figure, Figures, InContext, KindIcon, LoadError, LoadingRows, PageHeader, SectionHeader, SettingSwitch, Settings, StatLine, StatusPill, VisitLine, count } from '../../components/ds';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { UniverseAdvanced } from '@/components/bot-telemetry';

interface Universe {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string;
  isPublic: boolean;
  featured: boolean;
  thumbnailUrl: string | null;
  /** Bot chat telemetry is off (#435); stored as hide-conversations. */
  hideBotConversations?: boolean;
  createdAt: string;
  canEdit?: boolean;
  /** Owns it (a super admin can edit and delete without owning it). */
  manages?: boolean;
  /** Stars on the universe itself, and whether you gave one. */
  starCount?: number;
  isStarred?: boolean;
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
    /** Stars on the world itself. */
    starCount?: number;
  }>;
}

export function UniverseDetailPage({ view = 'details' }: { view?: 'details' | 'visitors' }) {
  const router = useRouter();
  const replacePage = useReplacePage();
  const params = useParams();
  const id = params.id as string;
  
  const [universe, setUniverse] = useState<Universe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Each world's activity for its card, asked for once per world (a failure offers a retry, never a request loop).
  const worldIds = useMemo(() => universe?.worlds?.map((world) => world.id) ?? [], [universe]);
  const universeSummaries = useEntitySummaries('universes', useMemo(() => [id], [id]));
  const { here, known: hereKnown, byRoom } = useHere('universe', id);
  const worldRooms = useWorldRooms(worldIds);
  const rank = useUniverseRank(id, universe?.isPublic === true);
  const star = useStarToggle(
    `/api/admin/universes/${id}/favorite`,
    universe ? { isStarred: !!universe.isStarred, starCount: universe.starCount ?? 0 } : null,
    (next) => setUniverse((current) => (current ? { ...current, ...next } : current)),
  );
  const roomIds = useMemo(() => Object.values(worldRooms).flatMap((world) => world.rooms.map((room) => room.id)), [worldRooms]);
  const roomSummaries = useEntitySummaries('rooms', roomIds);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'details' | 'analytics'>(view === 'visitors' ? 'analytics' : 'details');
  
  const isSuperAdmin = useIsSuperAdmin();
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    ownerId: '',
    isPublic: true,
    featured: false,
    thumbnailUrl: '',
    hideBotConversations: false,
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
          // Gone, private or not yours: the page says so in place, with Back still there.
          setUniverse(null);
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
        hideBotConversations: data.hideBotConversations === true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load universe');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAnalytics() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/analytics/universes/${id}?limit=1`);
      if (response.ok) {
        const data = await response.json();
        setAnalytics(data);
      }
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
    }
  }
  
  // Once the universe has loaded (not each time it changes, e.g. a star: that would send the visitors list back to page 1).
  const universeLoaded = universe !== null;
  useEffect(() => {
    if (universeLoaded) {
      // Fetch analytics on initial load to show totalAccesses count
      fetchAnalytics();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universeLoaded, id]);


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
          hideBotConversations: formData.hideBotConversations,
          // ownerId is not included - it belongs to the owner and cannot be changed
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update universe');
      }

      const updated = await response.json();
      setUniverse((current) => (current ? { ...current, ...updated } : updated));
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

      replacePage('/admin/universes');
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
    return <EmptyCard kind="universe" title="Universe not found." text="It may have been deleted, or you may not have access to it." />;
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

  const summary = universeSummaries.summary(id);
  const worldGroups: WorldGroupData[] = worlds.map((world) => {
    const loaded = worldRooms[world.id];
    return {
      id: world.id,
      name: world.name,
      rooms: world._count.rooms ?? 0,
      members: world._count.members ?? 0,
      favorites: world.starCount ?? 0,
      roomList: loaded
        ? loaded.rooms.map((room) => {
            const activity = roomSummaries.summary(room.id);
            return {
              id: room.id,
              name: room.name,
              favorites: room._count?.favorites ?? 0,
              playPath: playPathOf(universe.slug, world.slug, room.slug),
              here: byRoom.get(room.id) ?? { count: 0, bots: 0, people: [], youAreHere: false },
              you: activity?.lastVisitedByUser?.accessedAt ?? null,
              latest: activity?.lastVisitedOverall?.accessedAt ?? null,
            };
          })
        : null,
    };
  });
  // Browse worlds is offered once there is somewhere to go: a world with at least one room.
  const hasRooms = worlds.some((world) => worldRooms[world.id]?.rooms.length);

  return (
    <div className="space-y-8">
      {view === 'visitors' ? (
        <PageHeader
          kind="people"
          title="Visitors"
          context={<InContext parts={[{ label: universe.name, href: `/admin/universes/${id}`, kind: 'universe' }]} />}
          stats={analytics ? <Figures><Figure value={analytics.totalAccesses || 0} label="accesses" /></Figures> : undefined}
        />
      ) : (
      <PlaceHero
        kind="universe"
        title={universe.name}
        context={
          <>
            <By name={universe.owner.name || 'Someone'} woka={universe.owner.woka} you={isOwner} href={`/admin/users/${universe.owner.id}`} />
            {statusPills}
          </>
        }
        description={universe.description}
        stats={[
          { value: hereKnown ? here.count : '–', label: 'here now', live: true },
          { value: summary?.visitsThisWeek ?? '–', label: 'visits this week', href: `/admin/universes/${id}/visitors` },
          { value: worlds.length, label: worlds.length === 1 ? 'world' : 'worlds' },
          { value: worlds.reduce((sum, world) => sum + (world._count.rooms ?? 0), 0), label: 'rooms' },
        ]}
        rank={rank ? <Rank position={rank.position} of={rank.of} /> : undefined}
        here={here}
        actions={
          <>
            {!isEditing && hasRooms && <BrowseButton label="Browse worlds" targetId="universe-worlds-section" />}
            {currentUser && <StarButton count={universe.starCount ?? 0} starred={!!universe.isStarred} onClick={star.toggle} disabled={star.busy} />}
          </>
        }
        manageLine={`${isOwner ? 'You own this universe · c' : 'C'}reated ${new Date(universe.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`}
        manage={
          !isEditing && universe.canEdit === true ? (
            <Button variant="outline" onClick={() => setIsEditing(true)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          ) : undefined
        }
      />
      )}

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

            <UniverseAdvanced
              universeName={universe.name}
              telemetryOn={!formData.hideBotConversations}
              onChange={(on) => setFormData({ ...formData, hideBotConversations: !on })}
              confirmTurnOn={universe.hideBotConversations === true}
            />

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

          {activeTab === 'details' && (
            <>
              <RecentVisitors scope="universe" id={id} onOpenVisitors={() => router.push(`/admin/universes/${id}/visitors`)} />
              <UniverseMembersRow universeId={id} />
              {universe.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={universe.thumbnailUrl} alt={universe.name} className="h-12 w-12 object-cover rounded" />
              )}
              {((worlds.length === 0 && isOwner) || worlds.length > 0) && (
                <section id="universe-worlds-section" aria-labelledby="universe-worlds" className="scroll-mt-4">
                  <SectionHead
                    title="Worlds"
                    count={worlds.length}
                    action={universe.manages === true ? <AddButton href={`/admin/worlds/new?universeId=${id}`}>Create world</AddButton> : undefined}
                  />
                  {worlds.length === 0 ? (
                    <EmptyCard
                      kind="world"
                      title="No worlds yet."
                      text="Worlds hold the rooms in this universe."
                      href={universe.manages === true ? `/admin/worlds/new?universeId=${id}` : undefined}
                      action={universe.manages === true ? 'Create a world' : undefined}
                    />
                  ) : (
                    <WorldGroups worlds={worldGroups} canEdit={universe.manages === true} />
                  )}
                </section>
              )}
            </>
          )}

          {activeTab === 'analytics' && (
            <section aria-label="Visitors">
              <VisitorPeople scope="universe" id={id} />
            </section>
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
