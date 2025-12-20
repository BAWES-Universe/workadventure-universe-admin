'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2, Star, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StarredRoom {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mapUrl: string | null;
  wamUrl: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  isStarred: boolean;
  starCount: number;
  favoritedAt: string;
  world: {
    id: string;
    name: string;
    slug: string;
    universe: {
      id: string;
      name: string;
      slug: string;
    };
  };
}

function StarredRoomCard({ 
  room, 
  onToggleStar 
}: { 
  room: StarredRoom; 
  onToggleStar: (roomId: string) => Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);

  const handleToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setToggling(true);
    await onToggleStar(room.id);
    setToggling(false);
  };

  return (
    <Card
      className={cn(
        'group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all',
        'hover:-translate-y-1 hover:shadow-lg',
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-transparent to-sky-500/20 opacity-0 transition-opacity group-hover:opacity-100" />

      <div className="relative flex h-full flex-col p-5">
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted">
            <MapPin className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="truncate text-base font-semibold leading-tight">
              <Link
                href={`/admin/rooms/${room.id}`}
                className="hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {room.name}
              </Link>
            </h3>
            <p className="truncate text-xs font-mono text-muted-foreground">
              {room.world.universe.name} · {room.world.name}
            </p>
          </div>
        </div>

        {room.description && (
          <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
            {room.description}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between pt-3">
          <div className="text-xs text-muted-foreground">
            Starred {new Date(room.favoritedAt).toLocaleDateString()}
          </div>
          <Button
            variant={room.isStarred ? "default" : "outline"}
            size="sm"
            onClick={handleToggle}
            disabled={toggling}
            className="flex items-center gap-1.5"
          >
            {toggling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Star className={`h-3.5 w-3.5 ${room.isStarred ? 'fill-current' : ''}`} />
            )}
            {room.starCount || 0}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function MyStarsPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [starredRooms, setStarredRooms] = useState<StarredRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkAuthAndLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkAuthAndLoad() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/auth/me');
      if (!response.ok) {
        router.push('/admin/login');
        return;
      }

      await fetchStarredRooms();
    } catch (err) {
      router.push('/admin/login');
    } finally {
      setCheckingAuth(false);
    }
  }

  async function fetchStarredRooms() {
    try {
      setLoading(true);
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/stars/rooms');

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/admin/login');
          return;
        }
        throw new Error('Failed to fetch starred rooms');
      }

      const data = await response.json();
      setStarredRooms(data.rooms || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleStar(roomId: string) {
    // Find the room
    const room = starredRooms.find((r) => r.id === roomId);
    if (!room) return;

    const previousIsStarred = room.isStarred;
    const previousStarCount = room.starCount;

    // Optimistic update - in My Stars page, all rooms are starred, so toggling will unstar
    // Remove from list optimistically when unstarring
    setStarredRooms((prev) => prev.filter((r) => r.id !== roomId));

    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/rooms/${roomId}/favorite`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to toggle star');
      }

      const data = await response.json();

      // If unstarred (which is expected when toggling from starred list), it's already removed
      // If somehow starred again, re-add it (shouldn't happen but handle it)
      if (data.isStarred) {
        setStarredRooms((prev) => [
          ...prev,
          { ...room, isStarred: data.isStarred, starCount: data.starCount },
        ]);
      }
      // Otherwise, room stays removed (which is correct for unstarred state)
    } catch (err) {
      // Revert on error - re-add the room
      setStarredRooms((prev) => [
        ...prev,
        { ...room, isStarred: previousIsStarred, starCount: previousStarCount },
      ]);
      alert(err instanceof Error ? err.message : 'Failed to toggle star');
    }
  }

  if (checkingAuth) {
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
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight">My Stars</h1>
          <p className="text-muted-foreground text-lg">
            Rooms you've starred for quick access.
          </p>
        </div>
      </div>

      <section className="space-y-4">
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
                onClick={fetchStarredRooms}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {loading && starredRooms.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </CardContent>
          </Card>
        ) : starredRooms.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No starred rooms yet</CardTitle>
              <CardDescription>
                Star rooms you like to find them quickly here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="default" asChild>
                <Link href="/admin/discover/rooms">
                  Discover Rooms
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {starredRooms.map((room) => (
              <StarredRoomCard
                key={room.id}
                room={room}
                onToggleStar={handleToggleStar}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

