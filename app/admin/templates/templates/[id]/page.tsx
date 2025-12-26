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
import { ChevronLeft, Loader2, Plus, Edit, Trash2, AlertCircle, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

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
}

interface TemplateMap {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string;
  sizeLabel: string | null;
  isActive: boolean;
  order: number;
  _count: {
    rooms: number;
  };
}

export default function TemplateDetailPage() {
  const router = useRouter();
  const params = useParams();
  const [template, setTemplate] = useState<Template | null>(null);
  const [maps, setMaps] = useState<TemplateMap[]>([]);
  const [categories, setCategories] = useState<Array<{ id: string; name: string; icon: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    categoryId: '',
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
    if (params.id) {
      fetchData();
    }
  }, [params.id]);

  async function fetchData() {
    try {
      setLoading(true);
      setError(null);
      
      // Fetch template, maps, and categories in parallel
      const [templateResponse, mapsResponse, categoriesResponse] = await Promise.all([
        (await import('@/lib/client-auth')).authenticatedFetch(`/api/admin/templates/${params.id}`),
        (await import('@/lib/client-auth')).authenticatedFetch(`/api/admin/templates/maps?templateId=${params.id}`),
        (await import('@/lib/client-auth')).authenticatedFetch('/api/admin/templates/categories'),
      ]);
      
      // Handle template response
      if (!templateResponse.ok) {
        if (templateResponse.status === 404) {
          router.push('/admin/templates');
          return;
        }
        throw new Error('Failed to fetch template');
      }

      const templateData = await templateResponse.json();
      setTemplate(templateData.template);
      setFormData({
        categoryId: templateData.template.category.id,
        name: templateData.template.name,
        shortDescription: templateData.template.shortDescription || '',
        philosophy: templateData.template.philosophy || '',
        purpose: templateData.template.purpose || '',
        whoItsFor: templateData.template.whoItsFor || '',
        typicalUseCases: templateData.template.typicalUseCases.join('\n'),
        visibility: templateData.template.visibility,
        isFeatured: templateData.template.isFeatured,
        isActive: templateData.template.isActive,
      });
      
      // Handle maps response
      if (mapsResponse.ok) {
        const mapsData = await mapsResponse.json();
        setMaps(mapsData.maps || []);
      }

      // Handle categories response
      if (categoriesResponse.ok) {
        const categoriesData = await categoriesResponse.json();
        setCategories(categoriesData.categories || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load template');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!template) return;

    try {
      setSaving(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      
      // Parse typicalUseCases from newline-separated string
      const typicalUseCases = formData.typicalUseCases
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      const response = await authenticatedFetch(`/api/admin/templates/${template.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryId: formData.categoryId,
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

      setIsEditDialogOpen(false);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!template) return;

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/templates/${template.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete template');
      }

      router.push(`/admin/templates/categories/${template.category.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
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

  if (!template) {
    return (
      <div className="space-y-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Template not found</AlertTitle>
          <AlertDescription>
            The template you're looking for doesn't exist.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/admin/templates/categories/${template.category.id}`}>
            <ChevronLeft className="h-4 w-4 mr-2" />
            Back to {template.category.name}
          </Link>
        </Button>
        <Button variant="outline" onClick={() => setIsEditDialogOpen(true)}>
          <Edit className="h-4 w-4 mr-2" />
          Edit
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg border bg-muted text-2xl">
              {template.category.icon || <MapPin className="h-6 w-6 text-muted-foreground" />}
            </div>
            <div>
              <h1 className="text-4xl font-bold tracking-tight">{template.name}</h1>
              <p className="text-muted-foreground text-lg font-mono">{template.slug}</p>
            </div>
          </div>
          {template.shortDescription && (
            <p className="text-muted-foreground mt-2">{template.shortDescription}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Badge variant={template.isActive ? 'default' : 'secondary'}>
              {template.isActive ? 'Active' : 'Inactive'}
            </Badge>
            {template.isFeatured && <Badge variant="outline">Featured</Badge>}
            <Badge variant="outline">{template.visibility}</Badge>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Template Details */}
      {(template.philosophy || template.purpose || template.whoItsFor || template.typicalUseCases.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {template.philosophy && (
              <div>
                <h3 className="font-semibold mb-1">Philosophy</h3>
                <p className="text-sm text-muted-foreground">{template.philosophy}</p>
              </div>
            )}
            {template.purpose && (
              <div>
                <h3 className="font-semibold mb-1">Purpose</h3>
                <p className="text-sm text-muted-foreground">{template.purpose}</p>
              </div>
            )}
            {template.whoItsFor && (
              <div>
                <h3 className="font-semibold mb-1">Who It's For</h3>
                <p className="text-sm text-muted-foreground">{template.whoItsFor}</p>
              </div>
            )}
            {template.typicalUseCases.length > 0 && (
              <div>
                <h3 className="font-semibold mb-1">Typical Use Cases</h3>
                <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                  {template.typicalUseCases.map((useCase, idx) => (
                    <li key={idx}>{useCase}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Maps */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-semibold">Maps</h2>
          <Button asChild>
            <Link href={`/admin/templates/maps/new?templateId=${template.id}`}>
              <Plus className="h-4 w-4 mr-2" />
              Create Map
            </Link>
          </Button>
        </div>
        {maps.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No maps yet</CardTitle>
              <CardDescription>
                Create your first map variant for this template.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href={`/admin/templates/maps/new?templateId=${template.id}`}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create your first map
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {maps.map((map) => (
              <Link
                key={map.id}
                href={`/admin/templates/maps/${map.id}`}
                className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Card
                  className={cn(
                    'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
                    'hover:-translate-y-1 hover:shadow-lg',
                  )}
                >
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-green-500/10 via-transparent to-emerald-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

                  <div className="relative flex flex-col h-full p-5">
                    <div className="mb-4">
                      <h3 className="truncate text-base font-semibold leading-tight mb-1">
                        {map.name}
                      </h3>
                      <p className="truncate text-xs font-mono text-muted-foreground mb-2">
                        {map.slug}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant={map.isActive ? 'default' : 'secondary'}>
                          {map.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                        {map.sizeLabel && (
                          <Badge variant="outline">{map.sizeLabel}</Badge>
                        )}
                      </div>
                    </div>

                    {map.description && (
                      <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                        {map.description}
                      </p>
                    )}

                    <div className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5" />
                      <span>
                        {map._count.rooms} {map._count.rooms === 1 ? 'room' : 'rooms'} using this map
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
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader className="relative">
            <DialogTitle>Edit Template</DialogTitle>
            <DialogDescription>Update template details</DialogDescription>
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
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shortDescription">Short Description</Label>
              <Textarea
                id="shortDescription"
                value={formData.shortDescription}
                onChange={(e) => setFormData({ ...formData, shortDescription: e.target.value })}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="philosophy">Philosophy</Label>
              <Textarea
                id="philosophy"
                value={formData.philosophy}
                onChange={(e) => setFormData({ ...formData, philosophy: e.target.value })}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="purpose">Purpose</Label>
              <Textarea
                id="purpose"
                value={formData.purpose}
                onChange={(e) => setFormData({ ...formData, purpose: e.target.value })}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="whoItsFor">Who It's For</Label>
              <Textarea
                id="whoItsFor"
                value={formData.whoItsFor}
                onChange={(e) => setFormData({ ...formData, whoItsFor: e.target.value })}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="typicalUseCases">Typical Use Cases (one per line)</Label>
              <Textarea
                id="typicalUseCases"
                value={formData.typicalUseCases}
                onChange={(e) => setFormData({ ...formData, typicalUseCases: e.target.value })}
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !formData.name || !formData.categoryId}>
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
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{template?.name}"? This action cannot be undone.
              {maps.length > 0 && (
                <span className="block mt-2 text-destructive font-semibold">
                  ⚠️ Warning: This will also delete {maps.length} map(s). This cannot be undone!
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
              Delete{maps.length > 0 ? ' All' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

