'use client';

import { useState } from 'react';
import HerePanel from './components/here-panel';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import RecentlyVisited from './components/recently-visited';

/**
 * Orbit is here and now: an invitation waiting for you, the room you're in and the one before it, and the rooms you
 * were in lately. What's yours is on You; everything out there is in Space.
 */
export default function AdminDashboard() {
  // The rooms under Where you are (here, and just before), so Recently visited doesn't repeat them.
  const [shownRoomIds, setShownRoomIds] = useState<string[]>([]);

  return (
    <div className="orbit-home">
      <h1 className="sr-only">Orbit</h1>
      <PendingInvitationsAlert />
      <HerePanel onShown={setShownRoomIds} />
      <RecentlyVisited excludeRoomIds={shownRoomIds} />
    </div>
  );
}
