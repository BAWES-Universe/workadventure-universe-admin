'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ChevronRight, AlertCircle, Loader2 } from 'lucide-react';

interface User {
  id: string;
  name: string | null;
  email: string | null;
}

export default function NewUniversePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    ownerId: '',
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
  }, []);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
      const data = await response.json();
      setUser(data.user);
      setFormData(prev => ({ ...prev, ownerId: data.user.id }));
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!formData.ownerId) {
      setError('Owner ID is missing. Please refresh the page and try again.');
      setLoading(false);
      return;
    }

    try {
      const payload = {
        ...formData,
        description: formData.description || null,
        thumbnailUrl: formData.thumbnailUrl || null,
      };
      
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/universes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        const errorMessage = data.message || data.error || 'Failed to create universe';
        throw new Error(errorMessage);
      }

      const universe = await response.json();
      router.push(`/admin/universes/${universe.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create universe');
    } finally {
      setLoading(false);
    }
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
        <span className="text-foreground">New Universe</span>
      </nav>

      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">Create Universe</h1>
        <p className="text-muted-foreground text-lg">
          Create a new universe. Universes contain worlds, which contain rooms.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Universe Details</CardTitle>
          <CardDescription>
            Fill in the information below to create a new universe.
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
                placeholder="My Universe"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">
                Slug <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground">
                URL identifier (e.g., "my-universe"). Must be unique and URL-safe. Auto-generated from name, but can be edited.
              </p>
              <Input
                id="slug"
                required
                value={formData.slug}
                onChange={(e) => {
                  setSlugManuallyEdited(true);
                  setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') });
                }}
                placeholder="my-universe"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                rows={3}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="A brief description of this universe"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="thumbnailUrl">Thumbnail URL</Label>
              <Input
                id="thumbnailUrl"
                type="url"
                value={formData.thumbnailUrl}
                onChange={(e) => setFormData({ ...formData, thumbnailUrl: e.target.value })}
                placeholder="https://example.com/thumbnail.jpg"
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
                <Link href="/admin/universes">Cancel</Link>
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Universe'
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
