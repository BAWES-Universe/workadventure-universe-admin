'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2 } from 'lucide-react';
import { PageHeader, SettingSwitch, Settings } from '../../../components/ds';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

export default function NewCategoryPage() {
  const router = useRouter();
  const replacePage = useReplacePage();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    icon: '',
    order: 0,
    isActive: true,
  });

  // Helper function to generate slug from name
  function generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
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
      if (!data.user?.isSuperAdmin) {
        replacePage('/admin/templates');
        return;
      }
    } catch (err) {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const payload = {
        ...formData,
        description: formData.description || null,
        icon: formData.icon || null,
      };
      
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates/categories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        const errorMessage = data.error || 'Failed to create category';
        throw new Error(errorMessage);
      }

      const data = await response.json();
      replacePage(`/admin/templates/categories/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create category');
      setLoading(false);
    }
  }

  if (checkingAuth) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kind="category"
        title="New category"
        context={<span className="text-sm text-muted-foreground">A category groups room templates in the library.</span>}
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              className="h-11"
              value={formData.name}
              onChange={(e) => {
                setFormData({ ...formData, name: e.target.value });
                if (!slugManuallyEdited) {
                  setFormData(prev => ({ ...prev, slug: generateSlug(e.target.value) }));
                }
              }}
              placeholder="Work Rooms"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="slug">
              Category key <span className="text-destructive">*</span>
            </Label>
            <Input
              id="slug"
              className="h-11"
              value={formData.slug}
              onChange={(e) => {
                setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') });
                setSlugManuallyEdited(true);
              }}
              placeholder="work"
              required
            />
            <p className="text-xs text-muted-foreground">
              Used by the templates API. Lowercase letters, numbers and dashes.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Rooms designed for focused productivity..."
              rows={3}
            />
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="icon">Icon (emoji)</Label>
              <Input
                id="icon"
                className="h-11"
                value={formData.icon}
                onChange={(e) => setFormData({ ...formData, icon: e.target.value })}
                placeholder="🛠️"
                maxLength={2}
              />
              <p className="text-xs text-muted-foreground">One emoji for this category.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="order">Order</Label>
              <Input
                id="order"
                type="number"
                className="h-11"
                value={formData.order}
                onChange={(e) => setFormData({ ...formData, order: parseInt(e.target.value) || 0 })}
              />
              <p className="text-xs text-muted-foreground">Lower numbers appear first.</p>
            </div>
          </div>

          <Settings label="Visibility">
            <SettingSwitch
              id="isActive"
              label="Active"
              hint="Shown in the template library. Off: hidden from people creating rooms."
              checked={formData.isActive}
              onChange={(checked) => setFormData({ ...formData, isActive: checked })}
            />
          </Settings>

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11" asChild>
              <Link href="/admin/templates">Cancel</Link>
            </Button>
            <Button type="submit" className="h-11" disabled={loading || !formData.slug || !formData.name}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create category'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
