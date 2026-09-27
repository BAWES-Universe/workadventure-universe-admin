'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Plus, Edit, Trash2, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoadError, LoadingRows, SettingSwitch } from '../../components/ds';
import { InactivePill } from './template-bits';

interface Category {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  order: number;
  isActive: boolean;
  _count: {
    templates: number;
  };
}

export function CategoriesTab() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deleteCategory, setDeleteCategory] = useState<Category | null>(null);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    slug: '',
    name: '',
    description: '',
    icon: '',
    order: 0,
    isActive: true,
  });

  useEffect(() => {
    fetchCategories();
  }, []);

  async function fetchCategories() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates/categories');
      
      if (!response.ok) {
        throw new Error('Failed to fetch categories');
      }

      const data = await response.json();
      setCategories(data.categories || []);
      setError(null);
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      setError(err instanceof Error ? err.message : 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }

  function openCreateDialog() {
    setEditingCategory(null);
    setFormData({
      slug: '',
      name: '',
      description: '',
      icon: '',
      order: categories.length,
      isActive: true,
    });
    setIsDialogOpen(true);
  }

  function openEditDialog(category: Category) {
    setEditingCategory(category);
    setFormData({
      slug: category.slug,
      name: category.name,
      description: category.description || '',
      icon: category.icon || '',
      order: category.order,
      isActive: category.isActive,
    });
    setIsDialogOpen(true);
  }

  async function handleSave() {
    try {
      setSaving(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const url = editingCategory
        ? `/api/admin/templates/categories/${editingCategory.id}`
        : '/api/admin/templates/categories';
      
      const method = editingCategory ? 'PUT' : 'POST';
      
      const response = await authenticatedFetch(url, {
        method,
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

      setIsDialogOpen(false);
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save category');
    } finally {
      setSaving(false);
    }
  }

  function openDeleteDialog(category: Category) {
    setDeleteCategory(category);
    setIsDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteCategory) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/admin/templates/categories/${deleteCategory.id}`,
        { method: 'DELETE' }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete category');
      }

      setIsDeleteDialogOpen(false);
      setDeleteCategory(null);
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category');
    }
  }

  if (loading) {
    return (
      <LoadingRows label="categories" rows={3} />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="orbit-display text-lg font-bold">Categories</h2>
          <p className="text-sm text-muted-foreground">
            Manage template categories
          </p>
        </div>
        <Button variant="outline" className="h-11" onClick={openCreateDialog}>
          <Plus className="h-4 w-4 mr-2" />
          New category
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loadFailed ? (
        <LoadError label="categories" retry={fetchCategories} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card p-2 sm:p-3">
          {categories.length === 0 ? (
            <div className="px-2 py-6 text-sm text-muted-foreground">
              No categories found. Create your first category.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Icon</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Category key</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Templates</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((category) => (
                  <TableRow key={category.id}>
                    <TableCell>{category.icon || '—'}</TableCell>
                    <TableCell className="font-medium">{category.name}</TableCell>
                    <TableCell className="text-muted-foreground">{category.slug}</TableCell>
                    <TableCell>{category.order}</TableCell>
                    <TableCell>{category._count.templates}</TableCell>
                    <TableCell>
                      {category.isActive ? <span className="text-sm text-muted-foreground">Active</span> : <InactivePill />}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11"
                          aria-label={`Edit ${category.name}`}
                          onClick={() => openEditDialog(category)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11"
                          aria-label={`Delete ${category.name}`}
                          onClick={() => openDeleteDialog(category)}
                          disabled={category._count.templates > 0}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingCategory ? 'Edit category' : 'New category'}
            </DialogTitle>
            <DialogDescription>
              {editingCategory
                ? 'Update category details'
                : 'Create a new template category'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="slug">Category key *</Label>
              <Input
                id="slug"
                className="h-11"
                value={formData.slug}
                onChange={(e) =>
                  setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })
                }
                placeholder="work"
                disabled={!!editingCategory}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                className="h-11"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Work Rooms"
              />
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
            <SettingSwitch
              id="isActive"
              label="Active"
              hint="Offered in the template library. Off: hidden."
              checked={formData.isActive}
              onChange={(checked) => setFormData({ ...formData, isActive: checked })}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button className="h-11" onClick={handleSave} disabled={saving || !formData.slug || !formData.name}>
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
              Are you sure you want to delete "{deleteCategory?.name}"? This action cannot be undone.
              {deleteCategory && deleteCategory._count.templates > 0 && (
                <span className="block mt-2 text-destructive">
                  This category has {deleteCategory._count.templates} template(s) and cannot be deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteCategory?._count.templates ? deleteCategory._count.templates > 0 : false}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

