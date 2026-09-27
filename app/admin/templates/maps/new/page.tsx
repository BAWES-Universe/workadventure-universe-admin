'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2 } from 'lucide-react';
import { InContext, PageHeader, SettingSwitch, Settings } from '../../../components/ds';
import { ImageUpload } from '@/components/templates/ImageUpload';

interface Template {
  id: string;
  slug: string;
  name: string;
  category: {
    id: string;
    slug: string;
    name: string;
  };
}

function NewMapPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const templateIdParam = searchParams.get('templateId');
  
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  
  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    previewImageUrl: '',
    sizeLabel: '',
    order: 0,
    isActive: true,
  });
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);

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
    if (templateIdParam) {
      fetchTemplate();
    }
  }, [templateIdParam]);

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
        router.push('/admin/templates');
        return;
      }
    } catch (err) {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchTemplate() {
    if (!templateIdParam) return;
    
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/templates/${templateIdParam}`);
      if (response.ok) {
        const data = await response.json();
        setTemplate(data.template);
      }
    } catch (err) {
      // Ignore errors
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!templateIdParam) {
      setError('Template ID is required');
      setLoading(false);
      return;
    }

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      // Upload image to temp location if there's a pending file
      let previewImageUrl = formData.previewImageUrl;
      if (pendingImageFile) {
        const uploadFormData = new FormData();
        uploadFormData.append('file', pendingImageFile);
        uploadFormData.append('templateId', templateIdParam);

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
      }
      
      const payload = {
        templateId: templateIdParam,
        slug: formData.slug,
        name: formData.name,
        description: formData.description || null,
        mapUrl: formData.mapUrl,
        previewImageUrl: previewImageUrl || null,
        sizeLabel: formData.sizeLabel || null,
        orientation: 'orthogonal', // Default value
        tileSize: 32, // Default value
        recommendedWorldTags: [], // Default value
        order: formData.order,
        isActive: formData.isActive,
      };
      
      const response = await authenticatedFetch('/api/admin/templates/maps', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        const errorMessage = data.error || 'Failed to create map';
        throw new Error(errorMessage);
      }

      const data = await response.json();
      router.push(`/admin/templates/maps/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create map');
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

  if (!templateIdParam) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Template required</AlertTitle>
          <AlertDescription>
            Template ID is required. Please navigate to this page from a template.{' '}
            <Link href="/admin/templates" className="underline font-medium">
              Go to templates
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kind="map"
        title="New map"
        context={
          template ? (
            <InContext
              parts={[
                { label: template.category.name, href: `/admin/templates/categories/${template.category.id}` },
                { label: template.name, href: `/admin/templates/templates/${template.id}` },
              ]}
            />
          ) : (
            <span className="text-sm text-muted-foreground">A map people can pick when they start a room from this template.</span>
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
              placeholder="Small Focus Room"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="slug">
              Map key <span className="text-destructive">*</span>
            </Label>
            <Input
              id="slug"
              className="h-11"
              value={formData.slug}
              onChange={(e) => {
                setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') });
                setSlugManuallyEdited(true);
              }}
              placeholder="small-focus"
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
              placeholder="A compact version of the focus room..."
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
              placeholder="https://example.com/map.tmj"
              required
            />
          </div>

          {templateIdParam && (
            <div className="space-y-2">
              <ImageUpload
                value={formData.previewImageUrl}
                onChange={(url) => setFormData({ ...formData, previewImageUrl: url })}
                templateId={templateIdParam}
                disabled={loading}
                deferUpload={true}
                onFileChange={(file) => setPendingImageFile(file)}
              />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sizeLabel">Size</Label>
              <Select
                value={formData.sizeLabel || undefined}
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

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11" asChild>
              <Link href={templateIdParam ? `/admin/templates/templates/${templateIdParam}` : '/admin/templates'}>
                Cancel
              </Link>
            </Button>
            <Button type="submit" className="h-11" disabled={loading || !formData.slug || !formData.name || !formData.mapUrl}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create map'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function NewMapPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <NewMapPageContent />
    </Suspense>
  );
}

