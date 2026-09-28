'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Plus, Edit, Trash2, AlertCircle } from 'lucide-react';
import { EmptyCard, InContext, LoadError, PageHeader, SectionHeader, SettingSwitch, Settings, StatLine, StatusPill, count } from '../../../components/ds';
import { FactPill, InactivePill, MapCard } from '../../components/template-bits';

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
  previewImageUrl: string | null;
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
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mapsFailed, setMapsFailed] = useState(false);

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
      setMapsFailed(false);
      
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
      
      // Fetch template using public API (by slug if we have it, or by ID from admin API if super admin)
      let templateData: any = null;
      
      // Try to get template slug first - if we have template ID, we need to find its slug
      // For now, try public API with template ID lookup, or use admin API if super admin
      if (userIsSuperAdmin) {
        // Super admin can use admin API for full data
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const [templateResponse, mapsResponse, categoriesResponse] = await Promise.all([
          authenticatedFetch(`/api/admin/templates/${params.id}`),
          authenticatedFetch(`/api/admin/templates/maps?templateId=${params.id}`),
          authenticatedFetch('/api/admin/templates/categories'),
        ]);
        
        if (!templateResponse.ok) {
          if (templateResponse.status === 404) {
            router.push('/admin/templates');
            return;
          }
          throw new Error('Failed to fetch template');
        }

        templateData = await templateResponse.json();
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
        
        if (mapsResponse.ok) {
          const mapsData = await mapsResponse.json();
          setMaps(mapsData.maps || []);
        } else {
          setMapsFailed(true);
        }

        if (categoriesResponse.ok) {
          const categoriesData = await categoriesResponse.json();
          setCategories(categoriesData.categories || []);
        }
      } else {
        // Regular users use public API - need to find template by ID
        // First, get all templates and find the one with matching ID
        const templatesResponse = await fetch('/api/templates');
        if (templatesResponse.ok) {
          const templatesData = await templatesResponse.json();
          const foundTemplate = templatesData.templates.find((t: any) => t.id === params.id);
          if (foundTemplate) {
            // Fetch full template details by slug
            const templateDetailResponse = await fetch(`/api/templates/${foundTemplate.slug}`);
            if (templateDetailResponse.ok) {
              const detailData = await templateDetailResponse.json();
              setTemplate(detailData.template);
              setMaps(detailData.template.maps || []);
            } else {
              router.push('/admin/templates');
              return;
            }
          } else {
            router.push('/admin/templates');
            return;
          }
        } else {
          router.push('/admin/templates');
          return;
        }
        
        // Fetch categories for regular users
        const categoriesResponse = await fetch('/api/templates/categories');
        if (categoriesResponse.ok) {
          const categoriesData = await categoriesResponse.json();
          setCategories(categoriesData.categories || []);
        }
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

      const data = await response.json();
      const updatedTemplate = data.template;
      
      // Update template state immediately
      setTemplate({
        ...updatedTemplate,
      });

      setIsEditDialogOpen(false);
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
      <PageHeader
        kind="template"
        title={template.name}
        context={
          <InContext
            parts={[
              {
                label: template.category.icon ? `${template.category.icon} ${template.category.name}` : template.category.name,
                href: `/admin/templates/categories/${template.category.id}`,
              },
            ]}
          />
        }
        status={
          <>
            {template.isFeatured && <StatusPill status="featured" />}
            {isSuperAdmin && !template.isActive && <InactivePill />}
          </>
        }
        actions={
          isSuperAdmin === true ? (
            <>
              <Button asChild className="h-11">
                <Link href={`/admin/templates/maps/new?templateId=${template.id}`}>
                  <Plus className="h-4 w-4 mr-2" />
                  New map
                </Link>
              </Button>
              <Button variant="outline" className="h-11" onClick={() => setIsEditDialogOpen(true)}>
                <Edit className="h-4 w-4 mr-2" />
                Edit template
              </Button>
            </>
          ) : undefined
        }
      >
        {template.shortDescription && <p className="max-w-3xl text-sm text-foreground/80">{template.shortDescription}</p>}
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Template Details */}
      {(template.philosophy || template.purpose || template.whoItsFor || template.typicalUseCases.length > 0 || isSuperAdmin) && (
        <section aria-labelledby="template-about">
          <SectionHeader id="template-about" title="About" />
          <div className="space-y-4 rounded-2xl border bg-card p-4 sm:p-5">
            {template.philosophy && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Philosophy</h3>
                <div className="border-l-2 border-muted-foreground/30 pl-4">
                  <p className="text-sm italic text-muted-foreground leading-relaxed">
                    &ldquo;{template.philosophy}&rdquo;
                  </p>
                </div>
              </div>
            )}
            {template.purpose && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">Purpose</h3>
                <p className="text-sm text-muted-foreground">{template.purpose}</p>
              </div>
            )}
            {template.whoItsFor && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">Who it’s for</h3>
                <p className="text-sm text-muted-foreground">{template.whoItsFor}</p>
              </div>
            )}
            {template.typicalUseCases.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Typical use cases</h3>
                <div className="flex flex-wrap gap-2">
                  {template.typicalUseCases.map((useCase, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center rounded-md bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                    >
                      {useCase}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {isSuperAdmin && (
              <p className="text-xs text-muted-foreground">
                Template key <code className="rounded bg-muted px-1 text-foreground">{template.slug}</code>
                {' · '}
                {template.visibility === 'private' ? 'Private' : 'Public'}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Maps */}
      <section aria-labelledby="template-maps">
        <SectionHeader id="template-maps" title="Maps" count={mapsFailed ? undefined : maps.length} />
        {mapsFailed ? (
          <LoadError label="this template’s maps" retry={fetchData} />
        ) : maps.length === 0 ? (
          <EmptyCard
            kind="map"
            title="No maps yet"
            text={isSuperAdmin ? 'Add the first map for this template.' : 'This template has no maps yet.'}
            href={isSuperAdmin ? `/admin/templates/maps/new?templateId=${template.id}` : undefined}
            action={isSuperAdmin ? 'Create a map' : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {maps.map((map) => (
              <MapCard
                key={map.id}
                href={`/admin/templates/maps/${map.id}`}
                title={map.name}
                previewImageUrl={map.previewImageUrl}
                description={map.description}
                pills={
                  map.sizeLabel || (isSuperAdmin && !map.isActive) ? (
                    <>
                      {map.sizeLabel && (
                        <FactPill>{map.sizeLabel.charAt(0).toUpperCase() + map.sizeLabel.slice(1).toLowerCase()} size</FactPill>
                      )}
                      {isSuperAdmin && !map.isActive && <InactivePill />}
                    </>
                  ) : undefined
                }
                meta={<StatLine items={[`${count(map._count?.rooms || 0, 'room')} using this map`]} />}
              />
            ))}
          </div>
        )}
      </section>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit template</DialogTitle>
            <DialogDescription>Change how this template shows in the library.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
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
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shortDescription">Short description</Label>
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
              <Label htmlFor="whoItsFor">Who it’s for</Label>
              <Textarea
                id="whoItsFor"
                value={formData.whoItsFor}
                onChange={(e) => setFormData({ ...formData, whoItsFor: e.target.value })}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="typicalUseCases">Typical use cases (one per line)</Label>
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
            <Button className="h-11" onClick={handleSave} disabled={saving || !formData.name || !formData.categoryId}>
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
              Are you sure you want to delete "{template?.name}"? This action cannot be undone.
              {maps.length > 0 && (
                <span className="block mt-2 text-destructive font-semibold">
                  This will also delete {maps.length} map(s). This cannot be undone!
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

