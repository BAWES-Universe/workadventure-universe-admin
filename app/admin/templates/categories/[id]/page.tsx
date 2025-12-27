'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { ChevronLeft, Loader2, Plus, Edit, Trash2, AlertCircle, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Category {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  order: number;
  isActive: boolean;
  _count?: {
    templates: number;
  };
}

interface Template {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  isFeatured: boolean;
  isActive: boolean;
  _count: {
    maps: number;
  };
}

export default function CategoryDetailPage() {
  const router = useRouter();
  const params = useParams();
  const [category, setCategory] = useState<Category | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    icon: '',
    order: 0,
    isActive: true,
  });

  useEffect(() => {
    // Reset super admin state when params change
    setIsSuperAdmin(false);
    if (params.id) {
      fetchData();
    }
  }, [params.id]);

  async function fetchData() {
    try {
      setLoading(true);
      setError(null);
      
      // Check if user is super admin
      let userIsSuperAdmin = false;
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const authResponse = await authenticatedFetch('/api/auth/me');
        if (authResponse.ok) {
          const authData = await authResponse.json();
          // Explicitly check for true value
          userIsSuperAdmin = authData.user?.isSuperAdmin === true;
        }
      } catch {
        // Not authenticated, continue as regular user
        userIsSuperAdmin = false;
      }
      // Always set the state explicitly
      setIsSuperAdmin(userIsSuperAdmin);
      
      // Fetch category - try admin endpoint first if super admin, otherwise use public list
      let categoryData: any = null;
      let categorySlug: string | null = null;
      
      if (userIsSuperAdmin) {
        try {
          const { authenticatedFetch } = await import('@/lib/client-auth');
          const categoryResponse = await authenticatedFetch(`/api/admin/templates/categories/${params.id}`);
          if (categoryResponse.ok) {
            const data = await categoryResponse.json();
            categoryData = data.category;
            categorySlug = data.category.slug;
          }
        } catch {
          // Fall through to public API
        }
      }
      
      // If not found via admin API, try public categories list
      if (!categoryData) {
        const categoriesResponse = await fetch('/api/templates/categories');
        if (categoriesResponse.ok) {
          const categoriesData = await categoriesResponse.json();
          const foundCategory = categoriesData.categories.find((cat: any) => cat.id === params.id);
          if (foundCategory) {
            categoryData = {
              ...foundCategory,
              order: foundCategory.order || 0,
              isActive: true,
            };
            categorySlug = foundCategory.slug;
          } else {
            router.push('/admin/templates');
            return;
          }
        } else {
          router.push('/admin/templates');
          return;
        }
      }
      
      setCategory(categoryData);
      if (userIsSuperAdmin) {
        setFormData({
          name: categoryData.name,
          description: categoryData.description || '',
          icon: categoryData.icon || '',
          order: categoryData.order,
          isActive: categoryData.isActive,
        });
      }
      
      // Fetch templates using public API with category slug
      if (categorySlug) {
        const templatesResponse = await fetch(`/api/templates?category=${categorySlug}`);
        if (templatesResponse.ok) {
          const templatesData = await templatesResponse.json();
          setTemplates(templatesData.templates || []);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load category');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!category) return;

    try {
      setSaving(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/templates/categories/${category.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          description: formData.description || null,
          icon: formData.icon || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save category');
      }

      const data = await response.json();
      const updatedCategory = data.category;
      
      // Update category state immediately
      setCategory({
        ...updatedCategory,
        _count: category._count, // Preserve _count if it exists
      });

      setIsEditDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save category');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!category) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/templates/categories/${category.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete category');
      }

      router.push('/admin/templates');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category');
      setIsDeleteDialogOpen(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!category) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Category not found</AlertTitle>
          <AlertDescription>
            The category you're looking for doesn't exist.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/admin/templates">
            <ChevronLeft className="h-4 w-4 mr-2" />
            Back to Categories
          </Link>
        </Button>
        {isSuperAdmin === true && (
          <Button variant="outline" onClick={() => setIsEditDialogOpen(true)}>
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg border-border/70 border bg-muted text-2xl">
              {category.icon || <FolderOpen className="h-6 w-6 text-muted-foreground" />}
            </div>
            <div>
              <h1 className="text-4xl font-bold tracking-tight">{category.name}</h1>
              <p className="text-muted-foreground text-lg font-mono">{category.slug}</p>
            </div>
          </div>
          {category.description && (
            <p className="text-muted-foreground mt-2">{category.description}</p>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-semibold">Templates</h2>
          {isSuperAdmin && (
            <Button asChild>
              <Link href={`/admin/templates/templates/new?categoryId=${category.id}`}>
                <Plus className="h-4 w-4 mr-2" />
                Create Template
              </Link>
            </Button>
          )}
        </div>
        {templates.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No templates yet</CardTitle>
              <CardDescription>
                Create your first template in this category.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href={`/admin/templates/templates/new?categoryId=${category.id}`}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create your first template
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <Link
                key={template.id}
                href={`/admin/templates/templates/${template.id}`}
                className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Card
                  className={cn(
                    'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                    'hover:-translate-y-1 hover:shadow-lg',
                  )}
                >
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-pink-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

                  <div className="relative flex flex-col h-full p-5">
                    <div className="mb-4">
                      <h3 className="truncate text-base font-semibold leading-tight mb-1">
                        {template.name}
                      </h3>
                      <p className="truncate text-xs font-mono text-muted-foreground mb-2">
                        {template.slug}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {isSuperAdmin && (
                          <Badge variant={template.isActive ? 'default' : 'secondary'}>
                            {template.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        )}
                        {template.isFeatured && (
                          <Badge variant="outline">Featured</Badge>
                        )}
                      </div>
                    </div>

                    {template.shortDescription && (
                      <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                        {template.shortDescription}
                      </p>
                    )}

                    <div className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-muted-foreground">
                      <FolderOpen className="h-3.5 w-3.5" />
                      <span>
                        {template._count.maps} {template._count.maps === 1 ? 'map' : 'maps'}
                      </span>
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader className="relative">
            <DialogTitle>Edit Category</DialogTitle>
            <DialogDescription>Update category details</DialogDescription>
            <Button
              variant="destructive"
              size="sm"
              className="absolute top-0 right-0"
              onClick={() => {
                setIsEditDialogOpen(false);
                setIsDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="icon">Icon (Emoji)</Label>
              <Input
                id="icon"
                value={formData.icon}
                onChange={(e) => setFormData({ ...formData, icon: e.target.value })}
                maxLength={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="order">Order</Label>
              <Input
                id="order"
                type="number"
                value={formData.order}
                onChange={(e) => setFormData({ ...formData, order: parseInt(e.target.value) || 0 })}
              />
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !formData.name}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Category</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{category.name}"? This action cannot be undone.
              {templates.length > 0 && (
                <span className="block mt-2 text-destructive font-semibold">
                  ⚠️ Warning: This will also delete {templates.length} template(s) and all their maps. This cannot be undone!
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete{templates.length > 0 ? ' All' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

