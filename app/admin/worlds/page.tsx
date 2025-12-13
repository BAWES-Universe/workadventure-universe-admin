'use client';

import { useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, AlertCircle, Loader2, ChevronRight } from 'lucide-react';

interface World {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  featured: boolean;
  universe: {
    id: string;
    name: string;
    slug: string;
  };
  _count: {
    rooms: number;
    members: number;
  };
}

interface Universe {
  id: string;
  name: string;
  slug: string;
}

function WorldsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [worlds, setWorlds] = useState<World[]>([]);
  const [universes, setUniverses] = useState<Universe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUniverseId, setSelectedUniverseId] = useState<string>(searchParams.get('universeId') || '');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [worldToDelete, setWorldToDelete] = useState<World | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (selectedUniverseId) {
      fetchWorlds();
    } else {
      fetchWorlds();
      fetchUniverses();
    }
  }, [selectedUniverseId]);

  async function checkAuth() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }
    } catch (err) {
      router.push('/admin/login');
    }
  }

  async function fetchWorlds() {
    try {
      setLoading(true);
      const url = selectedUniverseId
        ? `/api/admin/worlds?universeId=${selectedUniverseId}`
        : '/api/admin/worlds';
      
      const response = await fetch(url, {
        credentials: 'include',
      });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch worlds');
      }

      const data = await response.json();
      setWorlds(data.worlds || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function fetchUniverses() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/universes?limit=100');
      if (response.ok) {
        const data = await response.json();
        setUniverses(data.universes || []);
      }
    } catch (err) {
      // Ignore errors
    }
  }

  function handleDeleteClick(world: World) {
    setWorldToDelete(world);
    setDeleteDialogOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!worldToDelete) return;

    try {
      setDeleting(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/worlds/${worldToDelete.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to delete world');
      }

      setWorlds(worlds.filter(w => w.id !== worldToDelete.id));
      setDeleteDialogOpen(false);
      setWorldToDelete(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete world');
    } finally {
      setDeleting(false);
    }
  }

  function handleUniverseFilterChange(universeId: string) {
    setSelectedUniverseId(universeId);
    const url = new URL(window.location.href);
    if (universeId) {
      url.searchParams.set('universeId', universeId);
    } else {
      url.searchParams.delete('universeId');
    }
    router.push(url.pathname + url.search);
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <nav className="flex items-center space-x-2 text-sm text-muted-foreground">
        <Link href="/admin" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">Worlds</span>
      </nav>

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">Worlds</h1>
          <p className="text-muted-foreground text-lg">
            Manage worlds. Worlds belong to universes and contain rooms.
          </p>
        </div>
        <Button asChild>
          <Link href={selectedUniverseId ? `/admin/worlds/new?universeId=${selectedUniverseId}` : '/admin/worlds/new'}>
            <Plus className="mr-2 h-4 w-4" />
            Create World
          </Link>
        </Button>
      </div>

      {universes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Filter by Universe</CardTitle>
          </CardHeader>
          <CardContent>
            <Select value={selectedUniverseId} onValueChange={handleUniverseFilterChange}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="All Universes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All Universes</SelectItem>
                {universes.map((universe) => (
                  <SelectItem key={universe.id} value={universe.id}>
                    {universe.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              className="ml-4"
              onClick={fetchWorlds}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {worlds.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No worlds found</CardTitle>
            <CardDescription>
              {selectedUniverseId ? 'No worlds found in this universe.' : 'Get started by creating your first world.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={selectedUniverseId ? `/admin/worlds/new?universeId=${selectedUniverseId}` : '/admin/worlds/new'}>
                <Plus className="mr-2 h-4 w-4" />
                Create your first world
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Universe</TableHead>
                  <TableHead>Rooms</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {worlds.map((world) => (
                  <TableRow key={world.id}>
                    <TableCell className="font-medium">{world.name}</TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/universes/${world.universe.id}`}
                        className="text-primary hover:underline"
                      >
                        {world.universe.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {world._count.rooms}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={world.isPublic ? 'default' : 'secondary'}>
                          {world.isPublic ? 'Public' : 'Private'}
                        </Badge>
                        {world.featured && (
                          <Badge variant="outline">Featured</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/admin/worlds/${world.id}`}>Edit</Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteClick(world)}
                          className="text-destructive hover:text-destructive"
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete World</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{worldToDelete?.name}"? This will also delete all rooms in it. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setWorldToDelete(null);
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function WorldsPage() {
  return (
    <Suspense fallback={
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    }>
      <WorldsPageContent />
    </Suspense>
  );
}
