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
import { ImageUpload } from '@/components/templates/ImageUpload';

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
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    mapUrl: '',
    previewImageUrl: '',
    sizeLabel: '',
    order: 0,
    isActive: true,
  });

  useEffect(() => {
    // Reset super admin state when params change
    setIsSuperAdmin(false);
    if (params.id) {
      fetchMap();
    }
  }, [params.id]);

  // Reset formData when edit dialog opens
  useEffect(() => {
    if (isEditDialogOpen && map) {
      setFormData({
        name: map.name,
        description: map.description || '',
        mapUrl: map.mapUrl,
        previewImageUrl: map.previewImageUrl || '',
        sizeLabel: map.sizeLabel ? map.sizeLabel.toLowerCase() : '',
        order: map.order,
        isActive: map.isActive,
      });
    }
  }, [isEditDialogOpen, map]);

  async function fetchMap() {
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
      
      let mapData: any = null;
      
      if (userIsSuperAdmin) {
        // Super admin can use admin API for full data
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
        mapData = data.map;
      } else {
        // Regular users use public API - need to find map by searching through templates
        const templatesResponse = await fetch('/api/templates');
        if (!templatesResponse.ok) {
          throw new Error('Failed to fetch templates');
        }
        
        const templatesData = await templatesResponse.json();
        let foundMap: any = null;
        let foundTemplate: any = null;
        
        // Search through all templates to find the map
        for (const template of templatesData.templates || []) {
          // Fetch full template details to get maps
          const templateDetailResponse = await fetch(`/api/templates/${template.slug}`);
          if (templateDetailResponse.ok) {
            const detailData = await templateDetailResponse.json();
            const map = detailData.template.maps.find((m: any) => m.id === params.id);
            if (map) {
              foundMap = map;
              foundTemplate = detailData.template;
              break;
            }
          }
        }
        
        if (!foundMap) {
          router.push('/admin/templates');
          return;
        }
        
        // Transform the map data to match the expected structure
        mapData = {
          id: foundMap.id,
          slug: foundMap.slug,
          name: foundMap.name,
          description: foundMap.description,
          mapUrl: foundMap.mapUrl,
          previewImageUrl: foundMap.previewImageUrl,
          sizeLabel: foundMap.sizeLabel,
          order: foundMap.order,
          isActive: true, // Public API only returns active maps
          _count: {
            rooms: foundMap._count?.rooms || 0,
          },
          template: {
            id: foundTemplate.id,
            slug: foundTemplate.slug,
            name: foundTemplate.name,
            category: foundTemplate.category,
          },
        };
      }

      setMap(mapData);
      setFormData({
        name: mapData.name,
        description: mapData.description || '',
        mapUrl: mapData.mapUrl,
        previewImageUrl: mapData.previewImageUrl || '',
        sizeLabel: mapData.sizeLabel ? mapData.sizeLabel.toLowerCase() : '',
        order: mapData.order,
        isActive: mapData.isActive,
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
      
      const response = await authenticatedFetch(`/api/admin/templates/maps/${map.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description || null,
          mapUrl: formData.mapUrl,
          previewImageUrl: formData.previewImageUrl || null,
          sizeLabel: formData.sizeLabel && formData.sizeLabel.trim() !== '' ? formData.sizeLabel.toLowerCase() : null,
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

      const data = await response.json();
      const updatedMap = data.map;
      
      // Update map state immediately
      setMap({
        ...updatedMap,
        _count: map._count, // Preserve _count if it exists
      });

      setIsEditDialogOpen(false);
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
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/admin/templates/templates/${map.template.id}`}>
            <ChevronLeft className="h-4 w-4 mr-2" />
            Back to {map.template.name}
          </Link>
        </Button>
        {isSuperAdmin && (
          <Button variant="outline" onClick={() => setIsEditDialogOpen(true)}>
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
        )}
      </div>

      <div className="space-y-1">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">{map.name}</h1>
          <div className="flex items-center gap-1.5 mt-2">
            {map.template.category.icon && (
              <span className="text-sm">{map.template.category.icon}</span>
            )}
            <p className="text-xs text-muted-foreground">
              {map.template.category.name}
            </p>
          </div>
        </div>
        {map.description && (
          <p className="text-muted-foreground mt-2">{map.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {isSuperAdmin && (
            <Badge variant={map.isActive ? 'default' : 'secondary'}>
              {map.isActive ? 'Active' : 'Inactive'}
            </Badge>
          )}
          {map.sizeLabel && (
            <Badge variant="secondary">
              {map.sizeLabel} size
            </Badge>
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

      {/* Map Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="border-0">
          <CardHeader>
            <CardTitle className="text-xl">Map Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="font-semibold mb-1">Template</h3>
              <p className="text-sm text-muted-foreground">
                {map.template.category.name} - {map.template.name}
              </p>
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
          </CardContent>
        </Card>

        <Card className="border-0">
          <CardHeader>
            <CardTitle className="text-xl">Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span>
                {map._count.rooms} {map._count.rooms === 1 ? 'room' : 'rooms'} using this map
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader className="relative">
            <DialogTitle>Edit Map</DialogTitle>
            <DialogDescription>Update map details</DialogDescription>
            <Button
              variant="destructive"
              size="sm"
              className="absolute top-0 right-0"
              onClick={() => {
                setIsEditDialogOpen(false);
                setIsDeleteDialogOpen(true);
              }}
              disabled={map._count.rooms > 0}
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
              <ImageUpload
                value={formData.previewImageUrl}
                onChange={(url) => setFormData({ ...formData, previewImageUrl: url })}
                mapId={map.id}
                disabled={saving}
              />
              <div className="text-xs text-muted-foreground">
                Or enter a URL manually:
              </div>
              <Input
                id="previewImageUrl"
                type="url"
                value={formData.previewImageUrl}
                onChange={(e) => setFormData({ ...formData, previewImageUrl: e.target.value })}
                placeholder="https://example.com/preview.png"
                disabled={saving}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sizeLabel">Size Label</Label>
                <Select
                  key={`size-select-${map?.id}-${map?.sizeLabel || 'empty'}`}
                  value={formData.sizeLabel && formData.sizeLabel.trim() !== '' ? formData.sizeLabel : undefined}
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

