'use client';

import { useState, useEffect, useRef, Suspense, useMemo } from 'react';
import { DraftNotice } from '../../components/draft-notice';
import { useDraft } from '../../hooks/use-draft';
import { EmptyCard, InContext, KindIcon, LoadError, LoadingRows, PageHeader, SectionHeader, SettingSwitch, Settings } from '../../components/ds';
import { FORM_DRAFT_VERSION, addressFromName, scopedDraftKey, upgradeFormDraft } from '@/lib/drafts';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, ArrowLeft } from 'lucide-react';
import { TemplateLibrary } from '@/components/templates/TemplateLibrary';
import { TemplateDetail } from '@/components/templates/TemplateDetail';

interface World {
  id: string;
  name: string;
  slug?: string;
  universe: {
    id: string;
    name: string;
    slug?: string;
  };
}

type MapMode = 'template' | 'custom';

// What was typed survives leaving the page. The world comes from where you came from, so it isn't kept, unless it was
// picked here from several. Version 2 also remembers the map choice (template or custom, and which template map) and
// whether the address was edited by hand.
const BASE_ROOM_DRAFT = {
  v: FORM_DRAFT_VERSION,
  slug: '',
  name: '',
  description: '',
  mapUrl: '',
  isPublic: true,
  addressEdited: false,
  mapMode: 'template' as MapMode,
  templateMapId: null as string | null,
  worldId: '',
};
type RoomDraft = typeof BASE_ROOM_DRAFT;

/** A saved room draft, of any version, in the current shape. A version 1 draft with a map URL was a custom map. */
function upgradeRoomDraft(saved: unknown, empty: RoomDraft): RoomDraft | null {
  const draft = upgradeFormDraft(saved, empty);
  if (!draft) return null;
  const old = saved as Record<string, unknown>;
  if (typeof old.mapMode !== 'string') {
    draft.mapMode = typeof old.mapUrl === 'string' && old.mapUrl.trim() !== '' ? 'custom' : 'template';
  }
  if (draft.mapMode !== 'custom') draft.mapMode = 'template';
  return draft;
}

function NewRoomPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const worldIdParam = searchParams.get('worldId');
  const templateMapIdParam = searchParams.get('templateMapId');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [worldsStatus, setWorldsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [worldDetails, setWorldDetails] = useState<World | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const slugInput = useRef<HTMLInputElement>(null);

  // Template selection state
  const [selectedTemplateSlug, setSelectedTemplateSlug] = useState<string | null>(null);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(templateMapIdParam);
  const [, setSelectedMapUrl] = useState<string | null>(null);
  const [selectedMapPreviewImageUrl, setSelectedMapPreviewImageUrl] = useState<string | null>(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState<string | null>(null);
  const [selectedMapName, setSelectedMapName] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    worldId: worldIdParam || '',
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    templateMapId: templateMapIdParam || null as string | null,
    isPublic: true,
    addressEdited: false,
    mapMode: 'template' as MapMode,
  });

  const useTemplate = formData.mapMode === 'template';
  function setUseTemplate(value: boolean) {
    setFormData((prev) => ({ ...prev, mapMode: value ? 'template' : 'custom' }));
  }

  // A template map in the address is where the form starts, so it isn't a draft on its own.
  const emptyDraft = useMemo(() => ({ ...BASE_ROOM_DRAFT, templateMapId: templateMapIdParam }), [templateMapIdParam]);
  // A world picked here from several is part of the draft; one from the address, or the only one, isn't.
  const keepsWorld = !worldIdParam && worlds.length !== 1;
  const draftFields = useMemo(
    () => ({
      v: FORM_DRAFT_VERSION,
      slug: formData.slug,
      name: formData.name,
      description: formData.description,
      // A template's map URL comes from the template, so only a custom one is kept.
      mapUrl: formData.mapMode === 'custom' ? formData.mapUrl : '',
      isPublic: formData.isPublic,
      addressEdited: formData.addressEdited,
      mapMode: formData.mapMode,
      templateMapId: formData.mapMode === 'template' ? formData.templateMapId : null,
      worldId: keepsWorld ? formData.worldId : '',
    }),
    [formData.slug, formData.name, formData.description, formData.mapUrl, formData.isPublic, formData.addressEdited, formData.mapMode, formData.templateMapId, formData.worldId, keepsWorld],
  );
  const { discard: discardDraft, restored: draftRestored, revert: revertDraft } = useDraft(
    scopedDraftKey('room.new', worldIdParam),
    draftFields,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ({ v, worldId, mapMode, templateMapId, mapUrl, ...draft }) =>
      setFormData((prev) => {
        // A template map in the address wins over the draft's map choice.
        const custom = !templateMapIdParam && mapMode === 'custom';
        const mapId = templateMapIdParam || (custom ? null : templateMapId);
        return {
          ...prev,
          ...draft,
          worldId: worldIdParam || worldId || prev.worldId,
          mapMode: custom ? 'custom' : 'template',
          templateMapId: mapId,
          // A template map's URL is loaded with the map (below); keep it when the map is the one already loaded.
          mapUrl: custom ? mapUrl : mapId && mapId === prev.templateMapId ? prev.mapUrl : '',
        };
      }),
    emptyDraft,
    true,
    (saved) => upgradeRoomDraft(saved, emptyDraft),
  );

  useEffect(() => {
    checkAuth();
    if (!worldIdParam) {
      fetchWorlds();
    }
    if (templateMapIdParam) {
      fetchTemplateMap(templateMapIdParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateMapIdParam]);

  useEffect(() => {
    async function fetchWorldDetails() {
      if (worldIdParam) {
        try {
          const { authenticatedFetch } = await import('@/lib/client-auth');
          const response = await authenticatedFetch(`/api/admin/worlds/${worldIdParam}`);
          if (response.ok) {
            const data = await response.json();
            setWorldDetails(data);
            setFormData(prev => ({ ...prev, worldId: data.id }));
          }
        } catch {
          setError('Failed to load world details');
        }
      }
    }
    fetchWorldDetails();
  }, [worldIdParam]);

  useEffect(() => {
    if (addressOpen) slugInput.current?.focus();
  }, [addressOpen]);

  // Without a world in the address: the only one is chosen for you; a choice you can't use any more is cleared.
  useEffect(() => {
    if (worldIdParam || worldsStatus !== 'ready') return;
    setFormData((prev) => {
      if (worlds.some((world) => world.id === prev.worldId)) return prev;
      const worldId = worlds.length === 1 ? worlds[0].id : '';
      return prev.worldId === worldId ? prev : { ...prev, worldId };
    });
  }, [worlds, worldsStatus, worldIdParam]);

  // A restored draft's template map: load it, so its card shows and its map URL is set.
  const requestedMapId = useRef<string | null>(templateMapIdParam);
  useEffect(() => {
    const mapId = formData.templateMapId;
    if (formData.mapMode !== 'template' || !mapId || mapId === selectedMapId || mapId === requestedMapId.current) return;
    requestedMapId.current = mapId;
    fetchTemplateMap(mapId);
  }, [formData.mapMode, formData.templateMapId, selectedMapId]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
    } catch {
      router.push('/admin/login');
    }
  }

  async function fetchWorlds() {
    setWorldsStatus('loading');
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      // Rooms can be created in worlds whose universe you own or where you're an admin: the same rule the API applies.
      const response = await authenticatedFetch('/api/admin/worlds/managed');
      if (!response.ok) throw new Error('Failed to load worlds');
      const data = await response.json();
      setWorlds(data.worlds || []);
      setWorldsStatus('ready');
    } catch {
      setWorldsStatus('error');
    }
  }

  async function fetchTemplateMap(mapId: string) {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/templates/maps/${mapId}`);
      if (response.ok) {
        const data = await response.json();
        const map = data.map;
        if (map && map.template) {
          // Don't set selectedTemplateSlug - we want to show the selection card, not the full detail view
          // Only set the map info so it shows "Selected Template Map" card
          setSelectedMapId(map.id);
          setSelectedMapUrl(map.mapUrl);
          setSelectedMapPreviewImageUrl(map.previewImageUrl || null);
          setSelectedMapName(map.name);
          setSelectedTemplateName(map.template.name);
          setFormData(prev => ({
            ...prev,
            templateMapId: map.id,
            mapUrl: map.mapUrl,
            // Don't pre-fill name and description - let user enter them
          }));
        }
      }
    } catch (err) {
      console.error('Failed to load template map:', err);
      // Don't set error, just continue without pre-selection
    }
  }

  function handleSelectTemplate(templateSlug: string) {
    setSelectedTemplateSlug(templateSlug);
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
          const map = data.template.maps.find((m: { id: string }) => m.id === mapId);
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
  }

  function handleBackToTemplates() {
    setSelectedTemplateSlug(null);
    // Clear map selection when going back
    setSelectedMapId(null);
    setSelectedMapUrl(null);
    setSelectedMapPreviewImageUrl(null);
    setSelectedTemplateName(null);
    setSelectedMapName(null);
    setFormData(prev => ({
      ...prev,
      templateMapId: null,
      mapUrl: '',
    }));
  }

  function handleClearTemplate() {
    setUseTemplate(false);
    setSelectedTemplateSlug(null);
    setSelectedMapId(null);
    setSelectedMapUrl(null);
    setSelectedMapPreviewImageUrl(null);
    setSelectedTemplateName(null);
    setSelectedMapName(null);
    setFormData(prev => ({
      ...prev,
      templateMapId: null,
      mapUrl: '',
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!formData.worldId) {
      setError('Choose the world this room belongs to.');
      return;
    }

    if (!formData.mapUrl || formData.mapUrl.trim() === '') {
      setError('Map URL is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');

      // Build request body
      const requestBody: Record<string, unknown> = {
        worldId: formData.worldId,
        slug: formData.slug,
        name: formData.name,
        description: formData.description || null,
        isPublic: formData.isPublic,
      };

      // Handle mapUrl and templateMapId
      // If using template (templateMapId exists and is valid UUID), use it and let API set mapUrl
      // Otherwise, use the manually entered mapUrl
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const templateMapIdValue = formData.templateMapId ? String(formData.templateMapId).trim() : '';

      if (templateMapIdValue && uuidRegex.test(templateMapIdValue)) {
        // Valid templateMapId - API will fetch and use the mapUrl from template
        requestBody.templateMapId = templateMapIdValue;
        // Don't send mapUrl when using template - API will set it
      } else {
        // No valid templateMapId - use manually entered mapUrl
        requestBody.mapUrl = formData.mapUrl.trim();
      }

      const response = await authenticatedFetch('/api/admin/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || data.error || 'Failed to create room');
      }

      const room = await response.json();
      discardDraft();
      router.push(`/admin/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room');
    } finally {
      setLoading(false);
    }
  }

  const selectedWorld = worlds.find(w => w.id === formData.worldId);
  const displayWorld = worldDetails || selectedWorld;
  const noWorld = !worldIdParam && worldsStatus === 'ready' && worlds.length === 0;
  const picking = !worldIdParam && worlds.length > 1;
  const showAddressInput = addressOpen || formData.addressEdited || (formData.name.trim() !== '' && formData.slug === '');

  return (
    <div className="space-y-6">
      <PageHeader
        kind="room"
        title="New room"
        context={
          displayWorld ? (
            <InContext
              parts={[
                { label: displayWorld.universe.name, href: `/admin/universes/${displayWorld.universe.id}` },
                { label: displayWorld.name, href: `/admin/worlds/${displayWorld.id}` },
              ]}
            />
          ) : (
            <span>A room belongs to a world, and opens on its own map.</span>
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

      {!worldIdParam && worldsStatus === 'loading' && <LoadingRows label="your worlds" />}
      {!worldIdParam && worldsStatus === 'error' && <LoadError label="your worlds" retry={fetchWorlds} />}
      {noWorld && (
        <EmptyCard
          kind="world"
          title="A room lives in a world."
          text="You don’t run a world yet. Create one, then add this room to it."
          href="/admin/worlds/new"
          action="Create a world"
          testId="room-needs-world"
        />
      )}
      {picking && (
        <WorldChoice
          worlds={worlds}
          value={formData.worldId}
          onChange={(worldId) => setFormData((prev) => ({ ...prev, worldId }))}
        />
      )}

      {!noWorld && (
        <section aria-labelledby="room-map" className="space-y-4">
          <SectionHeader id="room-map" title="Map" />
          {/* Template/Manual Toggle */}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Map source">
            <Button
              type="button"
              variant={useTemplate ? 'secondary' : 'outline'}
              aria-pressed={useTemplate}
              className="h-11"
              onClick={() => setUseTemplate(true)}
            >
              Use a template
            </Button>
            <Button
              type="button"
              variant={useTemplate ? 'outline' : 'secondary'}
              aria-pressed={!useTemplate}
              className="h-11"
              onClick={() => {
                // Already custom: keep the map URL typed so far.
                if (!useTemplate) return;
                setUseTemplate(false);
                handleClearTemplate();
              }}
            >
              Custom map (advanced)
            </Button>
          </div>

          {/* Template Selection Flow */}
          {useTemplate && (
            <Card className="p-4 shadow-none sm:p-5">
              {selectedTemplateSlug ? (
                <>
                  <div className="pb-0">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleBackToTemplates}
                      className="-ml-2 h-11 gap-2"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Back
                    </Button>
                  </div>
                  <CardContent className="px-0 pt-4">
                    <TemplateDetail
                      templateSlug={selectedTemplateSlug}
                      onSelectMap={handleSelectMap}
                      onBack={handleBackToTemplates}
                      selectedMapId={selectedMapId || undefined}
                      hideBackButton={true}
                    />
                  </CardContent>
                </>
              ) : (
                <CardContent className="p-0">
                  {selectedMapId && selectedTemplateName && selectedMapName ? (
                    <div className="rounded-lg bg-muted/50 border border-border/70 overflow-hidden">
                      {selectedMapPreviewImageUrl ? (
                        <div className="relative w-full h-48 overflow-hidden bg-muted">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
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
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium mb-1">Selected Template Map</div>
                            <div className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                              <div><strong>Template:</strong> {selectedTemplateName}</div>
                              <div><strong>Map:</strong> {selectedMapName}</div>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-11"
                            onClick={() => {
                              // Clear map selection but keep template info for display
                              setSelectedMapId(null);
                              setSelectedMapUrl(null);
                              setSelectedMapPreviewImageUrl(null);
                              setSelectedMapName(null);
                              setFormData(prev => ({
                                ...prev,
                                templateMapId: null,
                                mapUrl: '',
                              }));
                              // Show template library
                              setSelectedTemplateSlug(null);
                            }}
                          >
                            Change Template
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <TemplateLibrary
                      onSelectTemplate={handleSelectTemplate}
                    />
                  )}
                </CardContent>
              )}
            </Card>
          )}
        </section>
      )}

      {/* Room Form - Only show when not using template, or when template map is selected */}
      {!noWorld && (useTemplate ? (selectedMapId !== null && selectedMapId !== '') : true) && (
        <Card>
          <CardContent className="p-4 sm:p-6">
            <form onSubmit={handleSubmit} className="space-y-6">
            {draftRestored && <DraftNotice onDiscard={revertDraft} />}
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                required
                className="h-11"
                value={formData.name}
                onChange={(e) => {
                  const newName = e.target.value;
                  setFormData((prev) => ({
                    ...prev,
                    name: newName,
                    // The address follows the name until it's edited by hand.
                    slug: prev.addressEdited ? prev.slug : addressFromName(newName),
                  }));
                }}
                placeholder="Lobby"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={showAddressInput ? 'slug' : undefined}>
                Address <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                Opens at{' '}
                <code className="rounded bg-muted px-1 text-foreground">
                  /@/{displayWorld?.universe.slug || 'universe'}/{displayWorld?.slug || 'world'}/{formData.slug || 'lobby'}
                </code>
              </p>
              {showAddressInput ? (
                <>
                  <Input
                    id="slug"
                    ref={slugInput}
                    required
                    className="h-11"
                    value={formData.slug}
                    onChange={(e) => {
                      const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                      setFormData((prev) => ({ ...prev, slug, addressEdited: true }));
                    }}
                    placeholder="lobby"
                  />
                  <p className="text-xs text-muted-foreground">
                    Lowercase letters, numbers and dashes. Must be unique within the world.
                  </p>
                </>
              ) : (
                <Button type="button" variant="outline" className="h-11" onClick={() => setAddressOpen(true)}>
                  Change address
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                rows={3}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="A brief description of this room"
              />
            </div>

            {/* Map URL - Hidden when using template (set automatically) */}
            {!useTemplate || !selectedMapId ? (
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
                  className="h-11"
                  value={formData.mapUrl}
                  onChange={(e) => {
                    setFormData({ ...formData, mapUrl: e.target.value });
                  }}
                  placeholder="https://example.com/room-map.tmj"
                />
              </div>
            ) : null}

            <Settings label="Visibility">
              <SettingSwitch
                id="isPublic"
                label="Public"
                hint="Anyone can enter, if its world and universe are public too. Off: members only."
                checked={formData.isPublic}
                onChange={(checked) => setFormData({ ...formData, isPublic: checked })}
              />
            </Settings>

            <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="h-11" asChild>
                <Link href={formData.worldId ? `/admin/worlds/${formData.worldId}` : '/admin'}>
                  Cancel
                </Link>
              </Button>
              <Button type="submit" className="h-11" disabled={loading || !formData.worldId}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create room'
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      )}
    </div>
  );
}

/** Which of your worlds the room goes in: every one visible at once, a card each, nothing to drop down. */
function WorldChoice({
  worlds,
  value,
  onChange,
}: {
  worlds: World[];
  value: string;
  onChange: (worldId: string) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-2 text-sm font-medium">
        World <span className="text-destructive">*</span>
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {worlds.map((world) => (
          <label
            key={world.id}
            className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border/70 px-3 py-2 transition-colors hover:bg-muted/50 has-[:checked]:border-foreground/40 has-[:checked]:bg-accent/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input
              type="radio"
              name="world"
              value={world.id}
              checked={value === world.id}
              onChange={() => onChange(world.id)}
              className="sr-only"
            />
            <KindIcon kind="world" size="sm" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span className="block text-sm font-medium">{world.name}</span>
              <span className="block text-xs text-muted-foreground">In {world.universe.name}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function NewRoomPage() {
  return (
    <Suspense fallback={
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    }>
      <NewRoomPageContent />
    </Suspense>
  );
}
