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
import { EmptyCard, InContext, LoadError, LoadingRows, PageHeader, SettingSwitch, Settings } from '../../../components/ds';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

interface Category {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
}

function NewTemplatePageContent() {
  const router = useRouter();
  const replacePage = useReplacePage();
  const searchParams = useSearchParams();
  const categoryIdParam = searchParams.get('categoryId');
  
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [categoriesStatus, setCategoriesStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  
  const [formData, setFormData] = useState({
    categoryId: categoryIdParam || '',
    slug: '',
    name: '',
    shortDescription: '',
    philosophy: '',
    purpose: '',
    whoItsFor: '',
    typicalUseCases: '',
    visibility: 'public',
    isFeatured: false,
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
    fetchCategories();
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

  async function fetchCategories() {
    setCategoriesStatus('loading');
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates/categories');
      if (!response.ok) {
        setCategoriesStatus('error');
        return;
      }
      const data = await response.json();
      setCategories(data.categories || []);
      // Only set categoryId from URL param if it's a valid UUID and exists in categories
      if (categoryIdParam) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(categoryIdParam)) {
          const categoryExists = data.categories?.some((cat: Category) => cat.id === categoryIdParam);
          if (categoryExists && !formData.categoryId) {
            setFormData(prev => ({ ...prev, categoryId: categoryIdParam }));
          }
        }
      }
      setCategoriesStatus('ready');
    } catch {
      setCategoriesStatus('error');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!formData.categoryId) {
      setError('Category is required');
      setLoading(false);
      return;
    }

    // Validate that categoryId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(formData.categoryId)) {
      setError('Invalid category ID. Please select a category from the dropdown.');
      setLoading(false);
      return;
    }

    try {
      // Parse typicalUseCases from newline-separated string
      const typicalUseCases = formData.typicalUseCases
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      const payload = {
        categoryId: formData.categoryId,
        slug: formData.slug,
        name: formData.name,
        shortDescription: formData.shortDescription || null,
        philosophy: formData.philosophy || null,
        purpose: formData.purpose || null,
        whoItsFor: formData.whoItsFor || null,
        typicalUseCases,
        visibility: formData.visibility,
        isFeatured: formData.isFeatured,
        isActive: formData.isActive,
      };
      
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        let errorMessage = data.error || 'Failed to create template';
        // Include validation details if available
        if (data.message) {
          errorMessage = `${errorMessage}: ${data.message}`;
        } else if (data.details && Array.isArray(data.details)) {
          const details = data.details.map((issue: any) => 
            `${issue.path.join('.')}: ${issue.message}`
          ).join(', ');
          errorMessage = `${errorMessage} (${details})`;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      replacePage(`/admin/templates/templates/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create template');
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

  const selectedCategory = categories.find(c => c.id === formData.categoryId);

  return (
    <div className="space-y-6">
      <PageHeader
        kind="template"
        title="New template"
        context={
          selectedCategory ? (
            <InContext parts={[{ label: selectedCategory.name, href: `/admin/templates/categories/${selectedCategory.id}` }]} />
          ) : (
            <span className="text-sm text-muted-foreground">A room template people can start a room from. Add its maps after creating it.</span>
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

      {categoriesStatus === 'loading' && <LoadingRows label="categories" rows={1} />}
      {categoriesStatus === 'error' && <LoadError label="categories" retry={fetchCategories} />}
      {categoriesStatus === 'ready' && categories.length === 0 && (
        <EmptyCard
          kind="category"
          title="A template belongs to a category."
          text="There are no categories yet. Create one first."
          href="/admin/templates/categories/new"
          action="Create a category"
        />
      )}

      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="categoryId">
              Category <span className="text-destructive">*</span>
            </Label>
            <Select
              value={formData.categoryId}
              onValueChange={(value) => setFormData({ ...formData, categoryId: value })}
            >
              <SelectTrigger id="categoryId" className="h-11">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.icon && <span className="mr-2">{cat.icon}</span>}
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
              placeholder="Focus Room"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="slug">
              Template key <span className="text-destructive">*</span>
            </Label>
            <Input
              id="slug"
              className="h-11"
              value={formData.slug}
              onChange={(e) => {
                setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') });
                setSlugManuallyEdited(true);
              }}
              placeholder="focus-room"
              required
            />
            <p className="text-xs text-muted-foreground">
              Used by the templates API. Lowercase letters, numbers and dashes.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="shortDescription">Short description</Label>
            <Textarea
              id="shortDescription"
              value={formData.shortDescription}
              onChange={(e) => setFormData({ ...formData, shortDescription: e.target.value })}
              placeholder="A room designed for focused work..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="philosophy">Philosophy</Label>
            <Textarea
              id="philosophy"
              value={formData.philosophy}
              onChange={(e) => setFormData({ ...formData, philosophy: e.target.value })}
              placeholder="The design philosophy behind this template..."
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="purpose">Purpose</Label>
            <Textarea
              id="purpose"
              value={formData.purpose}
              onChange={(e) => setFormData({ ...formData, purpose: e.target.value })}
              placeholder="What this template is designed for..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="whoItsFor">Who it’s for</Label>
            <Textarea
              id="whoItsFor"
              value={formData.whoItsFor}
              onChange={(e) => setFormData({ ...formData, whoItsFor: e.target.value })}
              placeholder="Who should use this template..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="typicalUseCases">Typical use cases (one per line)</Label>
            <Textarea
              id="typicalUseCases"
              value={formData.typicalUseCases}
              onChange={(e) => setFormData({ ...formData, typicalUseCases: e.target.value })}
              placeholder="Deep work sessions&#10;Team meetings&#10;Client presentations"
              rows={4}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="visibility">Visibility</Label>
            <Select
              value={formData.visibility}
              onValueChange={(value) => setFormData({ ...formData, visibility: value })}
            >
              <SelectTrigger id="visibility" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="private">Private</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Settings label="Library">
            <SettingSwitch
              id="isFeatured"
              label="Featured"
              hint="Shown first in the template library."
              checked={formData.isFeatured}
              onChange={(checked) => setFormData({ ...formData, isFeatured: checked })}
            />
            <SettingSwitch
              id="isActive"
              label="Active"
              hint="Offered to people creating rooms. Off: hidden from the library."
              checked={formData.isActive}
              onChange={(checked) => setFormData({ ...formData, isActive: checked })}
            />
          </Settings>

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11" asChild>
              <Link href={categoryIdParam ? `/admin/templates/categories/${categoryIdParam}` : '/admin/templates'}>
                Cancel
              </Link>
            </Button>
            <Button type="submit" className="h-11" disabled={loading || !formData.slug || !formData.name || !formData.categoryId}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create template'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function NewTemplatePage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <NewTemplatePageContent />
    </Suspense>
  );
}

