'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useWorkAdventure } from '../workadventure-context';
import { MapPin, Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface CurrentRoom {
  id: string;
  slug: string;
  name: string;
  mapUrl: string | null;
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
  _count?: {
    favorites?: number;
  };
}

export default function CurrentLocation() {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const [playUri, setPlayUri] = useState<string | null>(null);
  const [mapURL, setMapURL] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [room, setRoom] = useState<CurrentRoom | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);

  useEffect(() => {
    // Check super admin status
    async function checkSuperAdmin() {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          setIsSuperAdmin(data.user?.isSuperAdmin || false);
        }
      } catch (err) {
        // Silently fail - not critical for this component
      }
    }

    checkSuperAdmin();
  }, []);

  useEffect(() => {
    if (!isReady || !wa) {
      setLoading(isLoading);
      return;
    }

    async function getRoomInfo() {
      if (!wa) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        await wa.onInit();

        const roomIdValue = wa.room.id as string | undefined;
        const mapURLValue = wa.room.mapURL as string | undefined;

        if (roomIdValue) {
          setPlayUri(roomIdValue);
          // Fetch room details from admin API using the full play URL
          try {
            const { authenticatedFetch } = await import('@/lib/client-auth');
            const response = await authenticatedFetch(
              `/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent(roomIdValue)}`,
            );

            if (response.ok) {
              const data = await response.json();
              setRoom(data as CurrentRoom);
              setRoomError(null);
            } else {
              setRoom(null);
              setRoomError('Unable to resolve current room from play URL.');
            }
          } catch (err) {
            console.error('[CurrentLocation] Failed to resolve room from playUri:', err);
            setRoom(null);
            setRoomError('Unable to resolve current room from play URL.');
          }
        }

        setMapURL(mapURLValue || null);
      } catch (err) {
        console.error('[CurrentLocation] Failed to get room info:', err);
      } finally {
        setLoading(false);
      }
    }

    getRoomInfo();
  }, [wa, isReady, isLoading]);

  if (error || (!isReady && !isLoading)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Current Location
          </CardTitle>
          <CardDescription>
            Your current location in the Universe
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Not Available</AlertTitle>
            <AlertDescription>
              Universe API is not available. This feature only works when the admin page is loaded in a Universe iframe.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (loading || isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Current Location
          </CardTitle>
          <CardDescription>
            Your current location in the Universe
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const content = (
    <Card className="group relative flex h-full flex-col overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-background shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-secondary/20 opacity-0 transition-opacity group-hover:opacity-100" />
      <CardContent className="relative flex h-full flex-col p-5">
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border bg-muted">
            <MapPin className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="truncate text-base font-semibold leading-tight">
              Current room
            </h3>
            {room ? (
              <>
                <p className="truncate text-xs text-muted-foreground">
                  {room.world.universe.name} · {room.world.name}
                </p>
                <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                  {room.slug}
                </p>
                {isSuperAdmin && (room.mapUrl || mapURL) && (
                  <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                    Map: {room.mapUrl || mapURL}
                  </p>
                )}
              </>
            ) : roomError ? (
              <p className="truncate text-xs text-muted-foreground">
                {roomError}
              </p>
            ) : playUri ? (
              <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                {playUri}
              </p>
            ) : (
              <p className="truncate text-xs text-muted-foreground">
                No room information available.
              </p>
            )}
          </div>
        </div>
        <div className="mt-auto pt-2 text-xs text-muted-foreground">
          <span className="text-[11px] uppercase tracking-wide">
            Your current location in the Universe
          </span>
        </div>
      </CardContent>
    </Card>
  );

  if (room) {
    return (
      <Link
        href={`/admin/rooms/${room.id}`}
        className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {content}
      </Link>
    );
  }
  return content;
}

