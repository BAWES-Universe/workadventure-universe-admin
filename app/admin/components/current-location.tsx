'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useWorkAdventure } from '../workadventure-context';
import { MapPin, Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function CurrentLocation() {
  const { wa, isReady, isLoading, error } = useWorkAdventure();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [mapURL, setMapURL] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        
        const roomIdValue = wa.room.id;
        const mapURLValue = wa.room.mapURL;
        
        setRoomId(roomIdValue);
        setMapURL(mapURLValue);
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
            Your current location in WorkAdventure
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Not Available</AlertTitle>
            <AlertDescription>
              WorkAdventure API is not available. This feature only works when the admin page is loaded in a WorkAdventure iframe.
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
            Your current location in WorkAdventure
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="h-5 w-5" />
          Current Location
        </CardTitle>
        <CardDescription>
          Your current location in WorkAdventure
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {roomId && (
          <div>
            <dt className="text-sm font-medium text-muted-foreground mb-1">Room ID</dt>
            <dd className="text-sm font-mono bg-muted px-2 py-1 rounded break-all">{roomId}</dd>
          </div>
        )}
        {mapURL && (
          <div>
            <dt className="text-sm font-medium text-muted-foreground mb-1">Map URL</dt>
            <dd className="text-sm break-all">
              <a 
                href={mapURL} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {mapURL}
              </a>
            </dd>
          </div>
        )}
        {!roomId && !mapURL && (
          <p className="text-sm text-muted-foreground">No room information available.</p>
        )}
      </CardContent>
    </Card>
  );
}

