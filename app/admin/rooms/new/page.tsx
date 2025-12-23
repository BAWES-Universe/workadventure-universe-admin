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
import { ChevronRight, AlertCircle, Loader2, AlertTriangle } from 'lucide-react';

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
  
  const [formData, setFormData] = useState({
    worldId: worldIdParam || '',
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
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
      const response = await authenticatedFetch('/api/admin/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...formData,
          description: formData.description || null,
          mapUrl: formData.mapUrl.trim(),
        }),
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

      <Card>
        <CardHeader>
          <CardTitle>Room Details</CardTitle>
          <CardDescription>
            Fill in the information below to create a new room.
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
                placeholder="https://example.com/room-map.tmj"
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
