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
import { Plus, Edit, Trash2, Loader2, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import Link from 'next/link';

interface TemplateMap {
  id: string;
  slug: string;
  name: string;
  mapUrl: string;
  sizeLabel: string | null;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMaps();
  }, []);

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
        <Button asChild>
          <Link href="/admin/templates/maps/new">
            <Plus className="h-4 w-4 mr-2" />
            Create Map
          </Link>
        </Button>
      </div>

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
                      {map.sizeLabel && <Badge variant="outline">{map.sizeLabel}</Badge>}
                    </TableCell>
                    <TableCell>{map._count.rooms}</TableCell>
                    <TableCell>
                      <Badge variant={map.isActive ? 'default' : 'secondary'}>
                        {map.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/admin/templates/maps/${map.id}`}>
                            <Edit className="h-4 w-4" />
                          </Link>
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
    </div>
  );
}

