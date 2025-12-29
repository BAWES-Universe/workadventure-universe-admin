'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Edit, Trash2, Loader2, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

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

interface TemplateMap {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string;
  previewImageUrl: string | null;
  sizeLabel: string | null;
  orientation: string;
  tileSize: number;
  recommendedWorldTags: string[];
  isActive: boolean;
  order: number;
  template: {
    id: string;
    slug: string;
    name: string;
    category: {
      id: string;
      slug: string;
      name: string;
    };
  };
  _count: {
    rooms: number;
  };
}

export function MapsTab() {
  const [maps, setMaps] = useState<TemplateMap[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [editingMap, setEditingMap] = useState<TemplateMap | null>(null);
  const [deleteMap, setDeleteMap] = useState<TemplateMap | null>(null);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    templateId: '',
    slug: '',
    name: '',
    description: '',
    mapUrl: '',
    previewImageUrl: '',
    sizeLabel: '',
    order: 0,
    isActive: true,
  });

  useEffect(() => {
    fetchTemplates();
    fetchMaps();
  }, []);

  async function fetchTemplates() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates');
      if (response.ok) {
        const data = await response.json();
        setTemplates(data.templates || []);
      }
    } catch (err) {
      // Ignore errors
    }
  }

  async function fetchMaps() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/templates/maps');
      
      if (!response.ok) {
        throw new Error('Failed to fetch maps');
      }

      const data = await response.json();
      setMaps(data.maps || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load maps');
    } finally {
      setLoading(false);
    }
  }

  function openCreateDialog() {
    setEditingMap(null);
    setFormData({
      templateId: templates[0]?.id || '',
      slug: '',
      name: '',
      description: '',
      mapUrl: '',
      previewImageUrl: '',
      sizeLabel: '',
      order: 0,
      isActive: true,
    });
    setIsDialogOpen(true);
  }

  function openEditDialog(map: TemplateMap) {
    setEditingMap(map);
    setFormData({
      templateId: map.template.id,
      slug: map.slug,
      name: map.name,
      description: map.description || '',
      mapUrl: map.mapUrl,
      previewImageUrl: map.previewImageUrl || '',
      sizeLabel: map.sizeLabel || '',
      order: map.order,
      isActive: map.isActive,
    });
    setIsDialogOpen(true);
  }

  async function handleSave() {
    try {
      setSaving(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      const url = editingMap
        ? `/api/admin/templates/maps/${editingMap.id}`
        : '/api/admin/templates/maps';
      
      const method = editingMap ? 'PUT' : 'POST';
      
      const response = await authenticatedFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: formData.templateId,
          slug: formData.slug,
          name: formData.name,
          description: formData.description || null,
          mapUrl: formData.mapUrl,
          previewImageUrl: formData.previewImageUrl || null,
          sizeLabel: formData.sizeLabel || null,
          orientation: 'orthogonal', // Default value
          tileSize: 32, // Default value
          recommendedWorldTags: [], // Default value
          order: formData.order,
          isActive: formData.isActive,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save map');
      }

      setIsDialogOpen(false);
      await fetchMaps();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save map');
    } finally {
      setSaving(false);
    }
  }

  function openDeleteDialog(map: TemplateMap) {
    setDeleteMap(map);
    setIsDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteMap) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(
        `/api/admin/templates/maps/${deleteMap.id}`,
        { method: 'DELETE' }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete map');
      }

      setIsDeleteDialogOpen(false);
      setDeleteMap(null);
      await fetchMaps();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete map');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Template Maps</h2>
          <p className="text-sm text-muted-foreground">
            Manage template map variants
          </p>
        </div>
        <Button onClick={openCreateDialog} disabled={templates.length === 0}>
          <Plus className="h-4 w-4 mr-2" />
          Create Map
        </Button>
      </div>

      {templates.length === 0 && (
        <Alert>
          <AlertDescription>
            No templates available. Please create a template first.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All Maps</CardTitle>
        </CardHeader>
        <CardContent>
          {maps.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No maps found. Create your first map.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Rooms</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {maps.map((map) => (
                  <TableRow key={map.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{map.template.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {map.template.category.name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">{map.name}</TableCell>
                    <TableCell className="text-muted-foreground">{map.slug}</TableCell>
                    <TableCell>
                      {map.sizeLabel && (
                        <Badge variant="outline">
                          {map.sizeLabel.charAt(0).toUpperCase() + map.sizeLabel.slice(1).toLowerCase()} size
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{map._count.rooms}</TableCell>
                    <TableCell>
                      <Badge variant={map.isActive ? 'default' : 'secondary'}>
                        {map.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(map)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openDeleteDialog(map)}
                          disabled={map._count.rooms > 0}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <a href={map.mapUrl} target="_blank" rel="noopener noreferrer">
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
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingMap ? 'Edit Map' : 'Create Map'}
            </DialogTitle>
            <DialogDescription>
              {editingMap
                ? 'Update map details'
                : 'Create a new template map variant'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="templateId">Template *</Label>
              <Select
                value={formData.templateId}
                onValueChange={(value) => setFormData({ ...formData, templateId: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>
                      {tpl.category.name} - {tpl.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug *</Label>
              <Input
                id="slug"
                value={formData.slug}
                onChange={(e) =>
                  setFormData({ ...formData, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })
                }
                placeholder="small-focus"
                disabled={!!editingMap}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Small Focus Room"
              />
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
              <Label htmlFor="mapUrl">Map URL *</Label>
              <Input
                id="mapUrl"
                type="url"
                value={formData.mapUrl}
                onChange={(e) => setFormData({ ...formData, mapUrl: e.target.value })}
                placeholder="https://example.com/map.tmj"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="previewImageUrl">Preview Image URL</Label>
              <Input
                id="previewImageUrl"
                type="url"
                value={formData.previewImageUrl}
                onChange={(e) => setFormData({ ...formData, previewImageUrl: e.target.value })}
                placeholder="https://example.com/preview.png"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sizeLabel">Size Label</Label>
                <Select
                  value={formData.sizeLabel || undefined}
                  onValueChange={(value) => setFormData({ ...formData, sizeLabel: value })}
                >
                  <SelectTrigger>
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
                  type="number"
                  value={formData.order}
                  onChange={(e) => setFormData({ ...formData, order: parseInt(e.target.value) || 0 })}
                />
              </div>
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
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !formData.slug || !formData.name || !formData.templateId || !formData.mapUrl}>
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
            <AlertDialogTitle>Delete Map</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteMap?.name}"? This action cannot be undone.
              {deleteMap && deleteMap._count.rooms > 0 && (
                <span className="block mt-2 text-destructive">
                  This map has {deleteMap._count.rooms} room(s) and cannot be deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMap?._count.rooms ? deleteMap._count.rooms > 0 : false}
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
