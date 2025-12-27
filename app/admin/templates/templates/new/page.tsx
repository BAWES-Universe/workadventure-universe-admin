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
import { ChevronRight, AlertCircle, Loader2 } from 'lucide-react';

interface Category {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
}

function NewTemplatePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const categoryIdParam = searchParams.get('categoryId');
  
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  
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
        router.push('/admin/templates');
        return;
      }
    } catch (err) {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchCategories() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates/categories');
      if (response.ok) {
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
      }
    } catch (err) {
      // Ignore errors
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
      router.push(`/admin/templates/templates/${data.id}`);
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
    <div className="space-y-8">
      <nav className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Link href="/admin" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href="/admin/templates" className="hover:text-foreground">
          Template Management
        </Link>
        {categoryIdParam && selectedCategory && (
          <>
            <ChevronRight className="h-4 w-4" />
            <Link href={`/admin/templates/categories/${categoryIdParam}`} className="hover:text-foreground">
              {selectedCategory.name}
            </Link>
          </>
        )}
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">New Template</span>
      </nav>

      <div className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">Create Template</h1>
        <p className="text-muted-foreground text-lg">
          Create a new room template.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {categories.length === 0 && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No Categories</AlertTitle>
          <AlertDescription>
            Please create a category first.{' '}
            <Link href="/admin/templates/categories/new" className="underline font-medium">
              Create Category
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Template Details</CardTitle>
          <CardDescription>
            Enter the details for your new template.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="categoryId">Category *</Label>
              <Select
                value={formData.categoryId}
                onValueChange={(value) => setFormData({ ...formData, categoryId: value })}
              >
                <SelectTrigger>
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
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
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
              <Label htmlFor="slug">Slug *</Label>
              <Input
                id="slug"
                value={formData.slug}
                onChange={(e) => {
                  setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') });
                  setSlugManuallyEdited(true);
                }}
                placeholder="focus-room"
                required
              />
              <p className="text-xs text-muted-foreground">
                URL-friendly identifier (lowercase, hyphens only)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="shortDescription">Short Description</Label>
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
              <Label htmlFor="whoItsFor">Who It's For</Label>
              <Textarea
                id="whoItsFor"
                value={formData.whoItsFor}
                onChange={(e) => setFormData({ ...formData, whoItsFor: e.target.value })}
                placeholder="Who should use this template..."
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="typicalUseCases">Typical Use Cases (one per line)</Label>
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
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="isFeatured"
                checked={formData.isFeatured}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, isFeatured: checked === true })
                }
              />
              <Label htmlFor="isFeatured" className="font-normal cursor-pointer">
                Featured
              </Label>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, isActive: checked === true })
                }
              />
              <Label htmlFor="isActive" className="font-normal cursor-pointer">
                Active
              </Label>
            </div>

            <div className="flex gap-4">
              <Button type="submit" disabled={loading || !formData.slug || !formData.name || !formData.categoryId}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Template'
                )}
              </Button>
              <Button type="button" variant="outline" asChild>
                <Link href={categoryIdParam ? `/admin/templates/categories/${categoryIdParam}` : '/admin/templates'}>
                  Cancel
                </Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
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

