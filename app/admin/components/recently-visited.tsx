'use client';

import { useState, useEffect } from 'react';
import { useWorkAdventure } from '../workadventure-context';
import RecentRoomCard from './recent-room-card';
import { Loader2 } from 'lucide-react';

interface RecentRoom {
  roomId: string;
  roomName: string;
  roomSlug: string;
  roomDescription: string | null;
  roomMapUrl: string | null;
  roomFavorites: number;
  worldId: string;
  worldName: string;
  worldSlug: string;
  universeId: string;
  universeName: string;
  universeSlug: string;
  accessedAt: string;
}

export default function RecentlyVisited() {
  const { wa, isReady, isLoading } = useWorkAdventure();
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [hasCheckedCurrentRoom, setHasCheckedCurrentRoom] = useState(false);

  useEffect(() => {
    async function getCurrentRoomId() {
      // If WorkAdventure is not available or still loading, mark as checked and proceed
      if (!isReady || !wa) {
        // Give it a moment to initialize, then mark as checked
        if (!isLoading) {
          setTimeout(() => setHasCheckedCurrentRoom(true), 1000);
        }
        return;
      }

      try {
        await wa.onInit();
        const roomIdValue = wa.room.id as string | undefined;

        if (roomIdValue) {
          // Fetch room details to get the room ID
          try {
            const { authenticatedFetch } = await import('@/lib/client-auth');
            const response = await authenticatedFetch(
              `/api/admin/rooms/from-play-uri?playUri=${encodeURIComponent(roomIdValue)}`,
            );

            if (response.ok) {
              const data = await response.json();
              setCurrentRoomId(data.id);
            }
          } catch (err) {
            console.error('[RecentlyVisited] Failed to resolve current room:', err);
          }
        }
        setHasCheckedCurrentRoom(true);
      } catch (err) {
        console.error('[RecentlyVisited] Failed to get room info:', err);
        setHasCheckedCurrentRoom(true);
      }
    }

    if (isReady && wa) {
      getCurrentRoomId();
    } else if (!isLoading) {
      // If WorkAdventure is not available, wait a bit then mark as checked
      const timeout = setTimeout(() => {
        setHasCheckedCurrentRoom(true);
      }, 1000);
      return () => clearTimeout(timeout);
    }
  }, [wa, isReady, isLoading]);

  useEffect(() => {
    async function fetchRecentRooms() {
      if (!hasCheckedCurrentRoom) {
        return; // Wait until we've checked for current room
      }

      try {
        setLoading(true);
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const excludeParam = currentRoomId ? `&excludeRoomId=${encodeURIComponent(currentRoomId)}` : '';
        const response = await authenticatedFetch(
          `/api/admin/rooms/recent?limit=2${excludeParam}`,
        );

        if (response.ok) {
          const data = await response.json();
          setRecentRooms(data.rooms || []);
        }
      } catch (err) {
        console.error('[RecentlyVisited] Failed to fetch recent rooms:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchRecentRooms();
  }, [currentRoomId, hasCheckedCurrentRoom]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (recentRooms.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {recentRooms.map((room) => (
        <RecentRoomCard
          key={room.roomId}
          room={{
            roomId: room.roomId,
            roomName: room.roomName,
            roomSlug: room.roomSlug,
            worldId: room.worldId,
            worldName: room.worldName,
            worldSlug: room.worldSlug,
            universeId: room.universeId,
            universeName: room.universeName,
            universeSlug: room.universeSlug,
            accessedAt: new Date(room.accessedAt),
          }}
        />
      ))}
    </div>
  );
}

