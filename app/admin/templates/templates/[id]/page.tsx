'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, Loader2, Plus, AlertCircle, MapPin } from 'lucide-react';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.id) {
      fetchData();
    }
  }, [params.id]);

  async function fetchData() {
    try {
      setLoading(true);
      setError(null);
      
      // Fetch template and maps in parallel
      const [templateResponse, mapsResponse] = await Promise.all([
        (await import('@/lib/client-auth')).authenticatedFetch(`/api/admin/templates/${params.id}`),
        (await import('@/lib/client-auth')).authenticatedFetch(`/api/admin/templates/maps?templateId=${params.id}`),
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
      
      // Handle maps response
      if (mapsResponse.ok) {
        const mapsData = await mapsResponse.json();
        setMaps(mapsData.maps || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load template');
    } finally {
      setLoading(false);
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
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/admin/templates/categories/${template.category.id}`}>
            <ChevronLeft className="h-4 w-4 mr-2" />
            Back to {template.category.name}
          </Link>
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
        <Button asChild>
          <Link href={`/admin/templates/maps/new?templateId=${template.id}`}>
            <Plus className="h-4 w-4 mr-2" />
            Create Map
          </Link>
        </Button>
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
        <h2 className="text-2xl font-semibold mb-4">Maps</h2>
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
    </div>
  );
}

