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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Edit, Trash2, Loader2, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoadError, LoadingRows, SettingSwitch, StatusPill } from '../../components/ds';
import { InactivePill } from './template-bits';

interface Category {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
}

interface Template {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  philosophy: string | null;
  purpose: string | null;
  whoItsFor: string | null;
  typicalUseCases: string[];
  visibility: string;
  isFeatured: boolean;
  isActive: boolean;
  category: {
    id: string;
    slug: string;
    name: string;
    icon: string | null;
  };
  _count: {
    maps: number;
  };
}

export function TemplatesTab() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [deleteTemplate, setDeleteTemplate] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    categoryId: '',
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

  useEffect(() => {
    fetchCategories();
    fetchTemplates();
  }, []);

  async function fetchCategories() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates/categories');
      if (response.ok) {
        const data = await response.json();
        setCategories(data.categories || []);
      }
    } catch (err) {
      // Ignore errors, categories are optional
    }
  }

  async function fetchTemplates() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates');
      
      if (!response.ok) {
        throw new Error('Failed to fetch templates');
      }

      const data = await response.json();
      setTemplates(data.templates || []);
      setError(null);
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }

  function openCreateDialog() {
    setEditingTemplate(null);
    setFormData({
      categoryId: categories[0]?.id || '',
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
    setIsDialogOpen(true);
  }

  function openEditDialog(template: Template) {
    setEditingTemplate(template);
    setFormData({
      categoryId: template.category.id,
      slug: template.slug,
      name: template.name,
      shortDescription: template.shortDescription || '',
      philosophy: template.philosophy || '',
      purpose: template.purpose || '',
      whoItsFor: template.whoItsFor || '',
      typicalUseCases: template.typicalUseCases.join('\n'),
      visibility: template.visibility,
      isFeatured: template.isFeatured,
      isActive: template.isActive,
    });
    setIsDialogOpen(true);
  }

  async function handleSave() {
    try {
      setSaving(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const url = editingTemplate
        ? `/api/admin/templates/${editingTemplate.id}`
        : '/api/admin/templates';
      
      const method = editingTemplate ? 'PUT' : 'POST';
      
      // Parse typicalUseCases from newline-separated string
      const typicalUseCases = formData.typicalUseCases
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      const response = await authenticatedFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save template');
      }

      setIsDialogOpen(false);
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  function openDeleteDialog(template: Template) {
    setDeleteTemplate(template);
    setIsDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteTemplate) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/admin/templates/${deleteTemplate.id}`,
        { method: 'DELETE' }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete template');
      }

      setIsDeleteDialogOpen(false);
      setDeleteTemplate(null);
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    }
  }

  if (loading) {
    return (
      <LoadingRows label="templates" rows={3} />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="orbit-display text-lg font-bold">Templates</h2>
          <p className="text-sm text-muted-foreground">
            Manage room templates
          </p>
        </div>
        <Button variant="outline" className="h-11" onClick={openCreateDialog} disabled={categories.length === 0}>
          <Plus className="h-4 w-4 mr-2" />
          New template
        </Button>
      </div>

      {categories.length === 0 && (
        <Alert>
          <AlertDescription>
            No categories available. Please create a category first.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loadFailed ? (
        <LoadError label="templates" retry={fetchTemplates} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card p-2 sm:p-3">
          {templates.length === 0 ? (
            <div className="px-2 py-6 text-sm text-muted-foreground">
              No templates found. Create your first template.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Template key</TableHead>
                  <TableHead>Maps</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {template.category.icon && (
                          <span>{template.category.icon}</span>
                        )}
                        <span>{template.category.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {template.name}
                      {template.isFeatured && (
                        <span className="ml-2 inline-flex align-middle"><StatusPill status="featured" /></span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{template.slug}</TableCell>
                    <TableCell>{template._count.maps}</TableCell>
                    <TableCell>
                      {template.isActive ? <span className="text-sm text-muted-foreground">Active</span> : <InactivePill />}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11"
                          aria-label={`Edit ${template.name}`}
                          onClick={() => openEditDialog(template)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11"
                          aria-label={`Delete ${template.name}`}
                          onClick={() => openDeleteDialog(template)}
                          disabled={template._count.maps > 0}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-11 w-11" asChild>
                          <a href={`/api/templates/${template.slug}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${template.name} in the templates API`}>
                            <ExternalLink className="h-4 w-4" />
                          </a>
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
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate ? 'Edit template' : 'New template'}
            </DialogTitle>
            <DialogDescription>
              {editingTemplate
                ? 'Update template details'
                : 'Create a new room template'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="categoryId">Category *</Label>
              <Select
                value={formData.categoryId}
                onValueChange={(value) => setFormData({ ...formData, categoryId: value })}
              >
                <SelectTrigger className="h-11">
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
              <Label htmlFor="slug">Template key *</Label>
              <Input
                id="slug"
                className="h-11"
                value={formData.slug}
                onChange={(e) =>
                  setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })
                }
                placeholder="focus-room"
                disabled={!!editingTemplate}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                className="h-11"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Focus Room"
              />
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
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
              hint="Offered in the template library. Off: hidden."
              checked={formData.isActive}
              onChange={(checked) => setFormData({ ...formData, isActive: checked })}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button className="h-11" onClick={handleSave} disabled={saving || !formData.slug || !formData.name || !formData.categoryId}>
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
            <AlertDialogTitle>Delete template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTemplate?.name}"? This action cannot be undone.
              {deleteTemplate && deleteTemplate._count.maps > 0 && (
                <span className="block mt-2 text-destructive">
                  This template has {deleteTemplate._count.maps} map(s) and cannot be deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteTemplate?._count.maps ? deleteTemplate._count.maps > 0 : false}
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
