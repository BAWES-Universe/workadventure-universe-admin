'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ChevronRight, AlertCircle, Loader2, AlertTriangle } from 'lucide-react';

interface Universe {
  id: string;
  name: string;
  slug: string;
}

function NewWorldPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const universeIdParam = searchParams.get('universeId');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [universes, setUniverses] = useState<Universe[]>([]);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  
  const [formData, setFormData] = useState({
    universeId: universeIdParam || '',
    slug: '',
    name: '',
    description: '',
    isPublic: true,
    featured: false,
    thumbnailUrl: '',
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
    fetchUniverses();
  }, []);

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

  async function fetchUniverses() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/universes?limit=100');
      if (response.ok) {
        const data = await response.json();
        setUniverses(data.universes || []);
      }
    } catch (err) {
      if (universeIdParam) {
        try {
          const { authenticatedFetch } = await import('@/lib/client-auth');
          const universeResponse = await authenticatedFetch(`/api/admin/universes/${universeIdParam}`);
          if (universeResponse.ok) {
            const universe = await universeResponse.json();
            setUniverses([universe]);
          }
        } catch (universeErr) {
          setError('Failed to load universe');
        }
      } else {
        setError('Failed to load universes');
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    if (!formData.universeId) {
      setError('Universe ID is required. Please navigate to this page from a universe.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = {
        ...formData,
        description: formData.description || null,
        thumbnailUrl: formData.thumbnailUrl || null,
      };
      
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/worlds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        const errorMessage = data.message || data.error || 'Failed to create world';
        throw new Error(errorMessage);
      }

      const world = await response.json();
      router.push(`/admin/worlds/${world.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create world');
    } finally {
      setLoading(false);
    }
  }

  const selectedUniverse = universes.find(u => u.id === formData.universeId);

  return (
    <div className="space-y-8">
      <nav className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Link href="/admin" className="hover:text-foreground">
          Dashboard
        </Link>
        {universeIdParam && selectedUniverse && (
          <>
            <ChevronRight className="h-4 w-4" />
            <Link href={`/admin/universes/${universeIdParam}`} className="hover:text-foreground">
              {selectedUniverse.name}
            </Link>
          </>
        )}
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">New World</span>
      </nav>

      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">Create World</h1>
        <p className="text-muted-foreground text-lg">
          Create a new world. Worlds belong to a universe and contain rooms.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!universeIdParam && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Universe Required</AlertTitle>
          <AlertDescription>
            Universe ID is required. Please navigate to this page from a universe.{' '}
            <Link href="/admin/universes" className="underline font-medium">
              Go to Universes
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {universeIdParam && !selectedUniverse && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Loading</AlertTitle>
          <AlertDescription>
            Loading universe information...
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>World Details</CardTitle>
          <CardDescription>
            Fill in the information below to create a new world.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <input type="hidden" name="universeId" value={formData.universeId} />

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
                placeholder="Office Building"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">
                Slug <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground">
                URL identifier (e.g., "office-world"). Must be unique within the universe. Auto-generated from name, but can be edited.
                {selectedUniverse && (
                  <span className="block mt-1">
                    Full path: <code className="bg-muted px-1 rounded">/{selectedUniverse.slug}/[slug]</code>
                  </span>
                )}
              </p>
              <Input
                id="slug"
                required
                value={formData.slug}
                onChange={(e) => {
                  setSlugManuallyEdited(true);
                  setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') });
                }}
                placeholder="office-world"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                rows={3}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="A brief description of this world"
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
              <Button type="button" variant="secondary" asChild>
                <Link href={formData.universeId ? `/admin/universes/${formData.universeId}` : '/admin'}>
                  Cancel
                </Link>
              </Button>
              <Button type="submit" disabled={loading || !universeIdParam || !selectedUniverse}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create World'
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function NewWorldPage() {
  return (
    <Suspense fallback={
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    }>
      <NewWorldPageContent />
    </Suspense>
  );
}
