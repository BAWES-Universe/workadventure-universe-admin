'use client';

import { useState } from 'react';
import { Loader2, Navigation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authenticatedFetch } from '@/lib/client-auth';
import { useWorkAdventure } from '../workadventure-context';

/**
 * "Visit" for a universe or a world: Orbit's server picks the first room this person can enter
 * (`/api/admin/landing-room`), and the game goes there through the WorkAdventure API, as the room page's Visit does.
 * When there is nowhere to go, the reason is shown in place of the button.
 */
export default function VisitPlaceButton({ universeId, worldId }: { universeId?: string; worldId?: string }) {
  const { isReady, navigateToRoom } = useWorkAdventure();
  const [visiting, setVisiting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function visit() {
    setVisiting(true);
    setMessage(null);
    try {
      const query = universeId ? `universeId=${encodeURIComponent(universeId)}` : `worldId=${encodeURIComponent(worldId ?? '')}`;
      const response = await authenticatedFetch(`/api/admin/landing-room?${query}`);
      const data = (await response.json().catch(() => ({}))) as { roomUrl?: unknown; message?: unknown };
      if (response.ok && typeof data.roomUrl === 'string') {
        await navigateToRoom(data.roomUrl);
        return;
      }
      setMessage(typeof data.message === 'string' ? data.message : 'This place could not be visited.');
    } catch {
      setMessage('This place could not be visited.');
    } finally {
      setVisiting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="default"
        size="sm"
        onClick={() => void visit()}
        disabled={visiting || !isReady}
        title={!isReady ? 'WorkAdventure API not available (only works in iframe)' : undefined}
      >
        {visiting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Navigation className="mr-2 h-4 w-4" />}
        Visit
      </Button>
      {message && <p className="text-sm text-muted-foreground" role="status">{message}</p>}
    </div>
  );
}
