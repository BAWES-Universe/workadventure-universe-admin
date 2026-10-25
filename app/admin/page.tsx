'use client';

import HerePanel from './components/here-panel';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import { LiveStrip } from './components/live/live-now';
import { GetStartedOnOrbit } from './components/orbit/get-started-on-orbit';
import { useLive } from './hooks/use-live';
import { ReportsAlert } from './components/world-safety';
import { NoticesAlert } from './components/notices-alert';

/**
 * Orbit is here and now: who is live right now (one line, on top), an invitation waiting for you, Get started until
 * it's done, notices from Orbit (a key of yours is down), reports waiting in worlds you run, and your timeline: the
 * room you're in, the one before it and the rooms you were in lately. What's yours is on You; everything out there is
 * in Space.
 */
export default function AdminDashboard() {
  const live = useLive();

  return (
    <div className="orbit-home">
      <h1 className="sr-only">Orbit</h1>
      {live && <LiveStrip view={live} />}
      <PendingInvitationsAlert />
      <NoticesAlert />
      <GetStartedOnOrbit />
      <ReportsAlert />
      <HerePanel live={live} />
    </div>
  );
}
