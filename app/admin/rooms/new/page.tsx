'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ChevronRight, AlertCircle, Loader2, AlertTriangle, X, ArrowLeft } from 'lucide-react';
import { TemplateLibrary } from '@/components/templates/TemplateLibrary';
import { TemplateDetail } from '@/components/templates/TemplateDetail';
import { Badge } from '@/components/ui/badge';

interface World {
  id: string;
  name: string;
  universe: {
    id: string;
    name: string;
  };
}

function NewRoomPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const worldIdParam = searchParams.get('worldId');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [worldDetails, setWorldDetails] = useState<World | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  
  // Template selection state
  const [useTemplate, setUseTemplate] = useState(true);
  const [selectedTemplateSlug, setSelectedTemplateSlug] = useState<string | null>(null);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [selectedMapUrl, setSelectedMapUrl] = useState<string | null>(null);
  const [selectedTemplateName, setSelectedTemplateName] = useState<string | null>(null);
  const [selectedMapName, setSelectedMapName] = useState<string | null>(null);
  
  const [formData, setFormData] = useState({
    worldId: worldIdParam || '',
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    templateMapId: null as string | null,
    isPublic: true,
  });

  // Helper function to generate slug from name
  function generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  }

  useEffect(() => {
    checkAuth();
    if (!worldIdParam) {
      fetchWorlds();
    }
  }, []);

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
        } catch (err) {
          setError('Failed to load world details');
        }
      }
    }
    fetchWorldDetails();
  }, [worldIdParam]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchWorlds() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/worlds?limit=100');
      if (response.ok) {
        const data = await response.json();
        setWorlds(data.worlds || []);
      }
    } catch (err) {
      setError('Failed to load worlds');
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
  }

  function handleBackToTemplates() {
    setSelectedTemplateSlug(null);
    // Clear map selection when going back
    setSelectedMapId(null);
    setSelectedMapUrl(null);
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
    
    if (!formData.worldId || !worldIdParam) {
      setError('World is required. Please create a room from a world detail page.');
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
      const requestBody: any = {
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
      router.push(`/admin/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room');
    } finally {
      setLoading(false);
    }
  }

  const selectedWorld = worlds.find(w => w.id === formData.worldId);
  const displayWorld = worldDetails || selectedWorld;

  return (
    <div className="space-y-8">
      <nav className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Link href="/admin" className="hover:text-foreground">
          Dashboard
        </Link>
        {worldIdParam && displayWorld && (
          <>
            <ChevronRight className="h-4 w-4" />
            <Link href={`/admin/universes/${displayWorld.universe.id}`} className="hover:text-foreground">
              {displayWorld.universe.name}
            </Link>
            <ChevronRight className="h-4 w-4" />
            <Link href={`/admin/worlds/${worldIdParam}`} className="hover:text-foreground">
              {displayWorld.name}
            </Link>
          </>
        )}
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">New Room</span>
      </nav>

      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">Create Room</h1>
        <p className="text-muted-foreground text-lg">
          Create a new room. Rooms belong to a world.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!worldIdParam && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>World Required</AlertTitle>
          <AlertDescription>
            Rooms must be created from a world detail page. Please navigate to a world and click "Create Room" from there.
          </AlertDescription>
        </Alert>
      )}

      {/* Template/Manual Toggle */}
      <div className="flex items-center gap-4">
        <Button
          type="button"
          variant={useTemplate ? 'default' : 'outline'}
          onClick={() => setUseTemplate(true)}
        >
          Use Template
        </Button>
        <Button
          type="button"
          variant={useTemplate ? 'outline' : 'default'}
          onClick={() => {
            setUseTemplate(false);
            handleClearTemplate();
          }}
        >
          Custom Map (Advanced)
        </Button>
      </div>

      {/* Template Selection Flow */}
      {useTemplate && (
        <Card className="border-0 shadow-none">
          <CardHeader>
            {selectedTemplateSlug && (
              <div className="flex items-center gap-2 mb-2">
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
            )}
            <CardTitle>Select Template</CardTitle>
            <CardDescription>
              Choose a template to get started, or switch to manual entry.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {selectedTemplateSlug ? (
              <TemplateDetail
                templateSlug={selectedTemplateSlug}
                onSelectMap={handleSelectMap}
                onBack={handleBackToTemplates}
                selectedMapId={selectedMapId || undefined}
                hideBackButton={true}
              />
            ) : selectedMapId && selectedTemplateName && selectedMapName ? (
              <div className="p-4 rounded-lg bg-muted/50">
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
                      setSelectedTemplateSlug(null);
                      setSelectedMapId(null);
                      setSelectedMapUrl(null);
                      setSelectedTemplateName(null);
                      setSelectedMapName(null);
                      setFormData(prev => ({
                        ...prev,
                        templateMapId: null,
                        mapUrl: '',
                      }));
                    }}
                  >
                    Change Template
                  </Button>
                </div>
              </div>
            ) : (
              <TemplateLibrary
                onSelectTemplate={handleSelectTemplate}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Room Form - Only show when not using template, or when template map is selected */}
      {(useTemplate ? (selectedMapId !== null && selectedMapId !== '') : true) && (
        <Card className="border-0 shadow-none">
          <CardHeader>
            <CardTitle>Room Details</CardTitle>
            <CardDescription>
              {useTemplate && selectedMapId
                ? 'Review and customize your room details. Map is set from template.'
                : 'Fill in the information below to create a new room.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                required
                value={formData.name}
                onChange={(e) => {
                  const newName = e.target.value;
                  setFormData((prev) => {
                    const newData = { ...prev, name: newName };
                    // Auto-generate slug from name if slug hasn't been manually edited
                    if (!slugManuallyEdited) {
                      newData.slug = generateSlug(newName);
                    }
                    return newData;
                  });
                }}
                placeholder="Lobby"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">
                Slug <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground">
                URL identifier (e.g., "lobby"). Must be unique within the world. Auto-generated from name, but can be edited.
              </p>
              <Input
                id="slug"
                required
                value={formData.slug}
                onChange={(e) => {
                  setSlugManuallyEdited(true);
                  setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') });
                }}
                placeholder="lobby"
              />
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
                  value={formData.mapUrl}
                  onChange={(e) => {
                    setFormData({ ...formData, mapUrl: e.target.value });
                  }}
                  placeholder="https://example.com/room-map.tmj"
                />
              </div>
            ) : null}

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
              <Button type="button" variant="secondary" asChild>
                <Link href={formData.worldId ? `/admin/worlds/${formData.worldId}` : '/admin'}>
                  Cancel
                </Link>
              </Button>
              <Button type="submit" disabled={loading || !worldIdParam}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Room'
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
