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

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  world: {
    id: string;
    name: string;
    universe: {
      id: string;
      name: string;
    };
  };
  _count: {
    favorites: number;
  };
}

interface World {
  id: string;
  name: string;
  universe: {
    id: string;
    name: string;
  };
}

function RoomsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorldId, setSelectedWorldId] = useState<string>(searchParams.get('worldId') || 'all');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [roomToDelete, setRoomToDelete] = useState<Room | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    fetchRooms();
    if (selectedWorldId === 'all' || !selectedWorldId) {
      fetchWorlds();
    }
  }, [selectedWorldId]);

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

  async function fetchRooms() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const actualWorldId = selectedWorldId === 'all' ? '' : selectedWorldId;
      const url = actualWorldId
        ? `/api/admin/rooms?worldId=${actualWorldId}`
        : '/api/admin/rooms';
      
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch rooms');
      }

      const data = await response.json();
      setRooms(data.rooms || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function fetchWorlds() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/worlds?limit=100');
      if (response.ok) {
        const data = await response.json();
        setWorlds(data.worlds || []);
      }
    } catch (err) {
      // Ignore errors
    }
  }

  function handleDeleteClick(room: Room) {
    setRoomToDelete(room);
    setDeleteDialogOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!roomToDelete) return;

    try {
      setDeleting(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${roomToDelete.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to delete room');
      }

      setRooms(rooms.filter(r => r.id !== roomToDelete.id));
      setDeleteDialogOpen(false);
      setRoomToDelete(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete room');
    } finally {
      setDeleting(false);
    }
  }

  function handleWorldFilterChange(worldId: string) {
    const actualId = worldId === 'all' ? '' : worldId;
    setSelectedWorldId(worldId);
    const url = new URL(window.location.href);
    if (actualId) {
      url.searchParams.set('worldId', actualId);
    } else {
      url.searchParams.delete('worldId');
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
        <span className="text-foreground">Rooms</span>
      </nav>

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">Rooms</h1>
          <p className="text-muted-foreground text-lg">
            Manage rooms. Rooms belong to worlds.
          </p>
        </div>
        <Button asChild>
          <Link href={selectedWorldId && selectedWorldId !== 'all' ? `/admin/rooms/new?worldId=${selectedWorldId}` : '/admin/rooms/new'}>
            <Plus className="mr-2 h-4 w-4" />
            Create Room
          </Link>
        </Button>
      </div>

      {worlds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Filter by World</CardTitle>
          </CardHeader>
          <CardContent>
            <Select value={selectedWorldId || 'all'} onValueChange={handleWorldFilterChange}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="All Worlds" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Worlds</SelectItem>
                {worlds.map((world) => (
                  <SelectItem key={world.id} value={world.id}>
                    {world.universe.name} / {world.name}
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
              onClick={fetchRooms}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {rooms.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No rooms found</CardTitle>
            <CardDescription>
              {selectedWorldId && selectedWorldId !== 'all' ? 'No rooms found in this world.' : 'Get started by creating your first room.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={selectedWorldId && selectedWorldId !== 'all' ? `/admin/rooms/new?worldId=${selectedWorldId}` : '/admin/rooms/new'}>
                <Plus className="mr-2 h-4 w-4" />
                Create your first room
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
                  <TableHead>World</TableHead>
                  <TableHead>Universe</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rooms.map((room) => (
                  <TableRow key={room.id}>
                    <TableCell className="font-medium">{room.name}</TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/worlds/${room.world.id}`}
                        className="text-primary hover:underline"
                      >
                        {room.world.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/universes/${room.world.universe.id}`}
                        className="text-primary hover:underline"
                      >
                        {room.world.universe.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={room.isPublic ? 'default' : 'secondary'}>
                        {room.isPublic ? 'Public' : 'Private'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/admin/rooms/${room.id}`}>Edit</Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteClick(room)}
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
            <DialogTitle>Delete Room</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{roomToDelete?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setRoomToDelete(null);
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

export default function RoomsPage() {
  return (
    <Suspense fallback={
      <div className="space-y-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    }>
      <RoomsPageContent />
    </Suspense>
  );
}
