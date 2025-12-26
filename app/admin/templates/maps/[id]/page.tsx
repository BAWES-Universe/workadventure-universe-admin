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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, Loader2, Edit, Trash2, AlertCircle, MapPin, ExternalLink } from 'lucide-react';

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
  order: number;
  isActive: boolean;
  template: {
    id: string;
    slug: string;
    name: string;
    category: {
      id: string;
      slug: string;
      name: string;
      icon: string | null;
    };
  };
  _count: {
    rooms: number;
  };
}

export default function MapDetailPage() {
  const router = useRouter();
  const params = useParams();
  const [map, setMap] = useState<TemplateMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    mapUrl: '',
    previewImageUrl: '',
    sizeLabel: '',
    orientation: 'orthogonal',
    tileSize: 32,
    recommendedWorldTags: '',
    order: 0,
    isActive: true,
  });

  useEffect(() => {
    if (params.id) {
      fetchMap();
    }
  }, [params.id]);

  async function fetchMap() {
    try {
      setLoading(true);
      setError(null);
      
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/templates/maps/${params.id}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          router.push('/admin/templates');
          return;
        }
        throw new Error('Failed to fetch map');
      }

      const data = await response.json();
      setMap(data.map);
      setFormData({
        name: data.map.name,
        description: data.map.description || '',
        mapUrl: data.map.mapUrl,
        previewImageUrl: data.map.previewImageUrl || '',
        sizeLabel: data.map.sizeLabel || '',
        orientation: data.map.orientation,
        tileSize: data.map.tileSize,
        recommendedWorldTags: data.map.recommendedWorldTags.join('\n'),
        order: data.map.order,
        isActive: data.map.isActive,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load map');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!map) return;

    try {
      setSaving(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      // Parse recommendedWorldTags from newline-separated string
      const recommendedWorldTags = formData.recommendedWorldTags
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      const response = await authenticatedFetch(`/api/admin/templates/maps/${map.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description || null,
          mapUrl: formData.mapUrl,
          previewImageUrl: formData.previewImageUrl || null,
          sizeLabel: formData.sizeLabel || null,
          orientation: formData.orientation,
          tileSize: formData.tileSize,
          recommendedWorldTags,
          order: formData.order,
          isActive: formData.isActive,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save map');
      }

      setIsEditDialogOpen(false);
      await fetchMap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save map');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!map) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/templates/maps/${map.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete map');
      }

      router.push(`/admin/templates/templates/${map.template.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete map');
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

  if (!map) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Map not found</AlertTitle>
          <AlertDescription>
            The map you're looking for doesn't exist.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/admin/templates/templates/${map.template.id}`}>
            <ChevronLeft className="h-4 w-4 mr-2" />
            Back to {map.template.name}
          </Link>
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg border bg-muted text-2xl">
              {map.template.category.icon || <MapPin className="h-6 w-6 text-muted-foreground" />}
            </div>
            <div>
              <h1 className="text-4xl font-bold tracking-tight">{map.name}</h1>
              <p className="text-muted-foreground text-lg font-mono">{map.slug}</p>
            </div>
          </div>
          {map.description && (
            <p className="text-muted-foreground mt-2">{map.description}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Badge variant={map.isActive ? 'default' : 'secondary'}>
              {map.isActive ? 'Active' : 'Inactive'}
            </Badge>
            {map.sizeLabel && <Badge variant="outline">{map.sizeLabel}</Badge>}
            <Badge variant="outline">{map.orientation}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setIsEditDialogOpen(true)}>
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
          <Button
            variant="destructive"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={map._count.rooms > 0}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Map Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Map Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="font-semibold mb-1">Template</h3>
              <p className="text-sm text-muted-foreground">
                {map.template.category.name} - {map.template.name}
              </p>
            </div>
            <div>
              <h3 className="font-semibold mb-1">Map URL</h3>
              <a
                href={map.mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline break-all flex items-center gap-1"
              >
                {map.mapUrl}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {map.previewImageUrl && (
              <div>
                <h3 className="font-semibold mb-1">Preview Image</h3>
                <a
                  href={map.previewImageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline break-all flex items-center gap-1"
                >
                  {map.previewImageUrl}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            <div>
              <h3 className="font-semibold mb-1">Technical Details</h3>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>Orientation: {map.orientation}</p>
                <p>Tile Size: {map.tileSize}px</p>
                <p>Order: {map.order}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span>
                {map._count.rooms} {map._count.rooms === 1 ? 'room' : 'rooms'} using this map
              </span>
            </div>
            {map.recommendedWorldTags.length > 0 && (
              <div className="mt-4">
                <h3 className="font-semibold mb-2">Recommended World Tags</h3>
                <div className="flex flex-wrap gap-2">
                  {map.recommendedWorldTags.map((tag, idx) => (
                    <Badge key={idx} variant="outline">{tag}</Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Map</DialogTitle>
            <DialogDescription>Update map details</DialogDescription>
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
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="previewImageUrl">Preview Image URL</Label>
              <Input
                id="previewImageUrl"
                type="url"
                value={formData.previewImageUrl}
                onChange={(e) => setFormData({ ...formData, previewImageUrl: e.target.value })}
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
                <Label htmlFor="orientation">Orientation</Label>
                <Select
                  value={formData.orientation}
                  onValueChange={(value) => setFormData({ ...formData, orientation: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="orthogonal">Orthogonal</SelectItem>
                    <SelectItem value="isometric">Isometric</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tileSize">Tile Size</Label>
                <Input
                  id="tileSize"
                  type="number"
                  value={formData.tileSize}
                  onChange={(e) => setFormData({ ...formData, tileSize: parseInt(e.target.value) || 32 })}
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
            </div>
            <div className="space-y-2">
              <Label htmlFor="recommendedWorldTags">Recommended World Tags (one per line)</Label>
              <Textarea
                id="recommendedWorldTags"
                value={formData.recommendedWorldTags}
                onChange={(e) => setFormData({ ...formData, recommendedWorldTags: e.target.value })}
                rows={3}
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
            <Button onClick={handleSave} disabled={saving || !formData.name || !formData.mapUrl}>
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
              Are you sure you want to delete "{map.name}"? This action cannot be undone.
              {map._count.rooms > 0 && (
                <span className="block mt-2 text-destructive">
                  This map has {map._count.rooms} room(s) and cannot be deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={map._count.rooms > 0}
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

