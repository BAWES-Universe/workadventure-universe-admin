'use client';

import { useState } from 'react';
import HerePanel from './components/here-panel';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import RecentlyVisited from './components/recently-visited';
import { LiveStrip } from './components/live/live-now';
import { GetStartedOnOrbit } from './components/orbit/get-started-on-orbit';
import { useLive } from './hooks/use-live';
import { ReportsAlert } from './components/world-safety';

/**
 * Orbit is here and now: who is live right now (one line, on top), an invitation waiting for you, Get started until
 * it's done, reports waiting in worlds you run, the room you're in and the one before it, and the rooms you were in
 * lately. What's yours is on You; everything out there is in Space.
 */
export default function AdminDashboard() {
  // The rooms under Where you are (here, and just before), so Recently visited doesn't repeat them.
  const [shownRoomIds, setShownRoomIds] = useState<string[]>([]);
  const live = useLive();

  return (
    <div className="orbit-home">
      <h1 className="sr-only">Orbit</h1>
      {live && <LiveStrip view={live} />}
      <PendingInvitationsAlert />
      <GetStartedOnOrbit />
      <ReportsAlert />
      <HerePanel onShown={setShownRoomIds} />
      <RecentlyVisited excludeRoomIds={shownRoomIds} />
    </div>
  );
}
