'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Loader2, Plus, Edit, Trash2, AlertCircle } from 'lucide-react';
import { EmptyCard, EntityCard, LoadError, PageHeader, SectionHeader, SettingSwitch, Settings, StatLine, StatusPill, count } from '../../../components/ds';
import { InactivePill } from '../../components/template-bits';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

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
  philosophy: string | null;
  isFeatured: boolean;
  isActive: boolean;
  _count: {
    maps: number;
  };
}

export default function CategoryDetailPage() {
  const replacePage = useReplacePage();
  const params = useParams();
  const categoryId = params?.id as string;
  const [category, setCategory] = useState<Category | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templatesFailed, setTemplatesFailed] = useState(false);

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
    if (categoryId) {
      fetchData();
    } else {
      setLoading(false);
      setError('Category ID is required');
    }
  }, [categoryId]);

  // Reset formData when edit dialog opens, so a cancelled edit doesn't come back
  useEffect(() => {
    if (isEditDialogOpen && category) {
      setFormData({
        name: category.name,
        description: category.description || '',
        icon: category.icon || '',
        order: category.order,
        isActive: category.isActive,
      });
    }
  }, [isEditDialogOpen, category]);

  async function fetchData() {
    try {
      setLoading(true);
      setError(null);
      setTemplatesFailed(false);
      
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
          const categoryResponse = await authenticatedFetch(`/api/admin/templates/categories/${categoryId}`);
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
          const foundCategory = categoriesData.categories.find((cat: any) => cat.id === categoryId);
          if (foundCategory) {
            categoryData = {
              ...foundCategory,
              order: foundCategory.order || 0,
              isActive: true,
            };
            categorySlug = foundCategory.slug;
          } else {
            replacePage('/admin/templates');
            return;
          }
        } else {
          replacePage('/admin/templates');
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
        } else {
          setTemplatesFailed(true);
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

      replacePage('/admin/templates');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category');
      setIsDeleteDialogOpen(false);
    }
  }

  if (!categoryId) {
    return (
      <div className="flex items-center justify-center py-12">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Invalid Category</AlertTitle>
          <AlertDescription>
            Category ID is missing from the URL.
          </AlertDescription>
        </Alert>
      </div>
    );
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
      <PageHeader
        kind="category"
        title={category.icon ? `${category.icon} ${category.name}` : category.name}
        context={category.description ? <span className="text-sm text-muted-foreground">{category.description}</span> : undefined}
        status={isSuperAdmin && !category.isActive ? <InactivePill /> : undefined}
        actions={
          isSuperAdmin === true ? (
            <>
              <Button asChild className="h-11">
                <Link href={`/admin/templates/templates/new?categoryId=${category.id}`}>
                  <Plus className="h-4 w-4 mr-2" />
                  New template
                </Link>
              </Button>
              <Button variant="outline" className="h-11" onClick={() => setIsEditDialogOpen(true)}>
                <Edit className="h-4 w-4 mr-2" />
                Edit category
              </Button>
            </>
          ) : undefined
        }
      />

      {isSuperAdmin && (
        <p className="text-xs text-muted-foreground">
          Category key <code className="rounded bg-muted px-1 text-foreground">{category.slug}</code>
          {' · '}Order {category.order}
        </p>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="category-templates">
        <SectionHeader id="category-templates" title="Templates" count={templatesFailed ? undefined : templates.length} />
        {templatesFailed ? (
          <LoadError label="this category’s templates" retry={fetchData} />
        ) : templates.length === 0 ? (
          <EmptyCard
            kind="template"
            title="No templates yet"
            text={isSuperAdmin ? 'Create the first template in this category.' : 'This category has no templates yet.'}
            href={isSuperAdmin ? `/admin/templates/templates/new?categoryId=${category.id}` : undefined}
            action={isSuperAdmin ? 'Create a template' : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <EntityCard
                key={template.id}
                href={`/admin/templates/templates/${template.id}`}
                kind="template"
                title={template.name}
                description={template.shortDescription}
                pills={
                  template.isFeatured || (isSuperAdmin && !template.isActive) ? (
                    <>
                      {template.isFeatured && <StatusPill status="featured" />}
                      {isSuperAdmin && !template.isActive && (
                        <InactivePill />
                      )}
                    </>
                  ) : undefined
                }
                meta={
                  <>
                    {template.philosophy && (
                      <p className="border-l-2 border-muted-foreground/30 pl-3 text-xs italic leading-relaxed text-foreground/80">
                        &ldquo;{template.philosophy}&rdquo;
                      </p>
                    )}
                    <StatLine items={[count(template._count.maps, 'map')]} />
                  </>
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit category</DialogTitle>
            <DialogDescription>Change how this category shows in the template library.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                className="h-11"
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
              <Label htmlFor="icon">Icon (emoji)</Label>
              <Input
                id="icon"
                className="h-11"
                value={formData.icon}
                onChange={(e) => setFormData({ ...formData, icon: e.target.value })}
                maxLength={2}
              />
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
            <Settings label="Visibility">
              <SettingSwitch
                id="isActive"
                label="Active"
                hint="Shown in the template library. Off: hidden from people creating rooms."
                checked={formData.isActive}
                onChange={(checked) => setFormData({ ...formData, isActive: checked })}
              />
            </Settings>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="h-11 text-destructive hover:text-destructive sm:mr-auto"
              onClick={() => {
                setIsEditDialogOpen(false);
                setIsDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
            <Button variant="outline" className="h-11" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button className="h-11" onClick={handleSave} disabled={saving || !formData.name}>
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
            <AlertDialogTitle>Delete category</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{category.name}"? This action cannot be undone.
              {templates.length > 0 && (
                <span className="block mt-2 text-destructive font-semibold">
                  This will also delete {templates.length} template(s) and all their maps. This cannot be undone!
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

