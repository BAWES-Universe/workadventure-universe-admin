'use client';

import HerePanel from './components/here-panel';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import { LiveStrip } from './components/live/live-now';
import { useGetStartedOnOrbit } from './components/orbit/get-started-on-orbit';
import { MembershipsRow, StarsRow, UniversesRow } from './components/orbit/rows';
import { useLive } from './hooks/use-live';
import { ReportsAlert } from './components/world-safety';
import { NoticesAlert } from './components/notices-alert';

/**
 * Orbit is here and now: who is live right now (one line, on top), an invitation waiting for you, notices from Orbit
 * (a key of yours is down), reports waiting in worlds you run, your timeline (the room you're in, the one before it
 * and the rooms you were in lately), Get started until it's done, then your stars, your universes and the universes
 * you joined, each a row that scrolls sideways with the busiest first. Hidden, Get started leaves a row at the bottom
 * that brings it back. Everything out there is in Space.
 */
export default function AdminDashboard() {
  const live = useLive();
  const getStarted = useGetStartedOnOrbit();

  return (
    <div className="orbit-home">
      <h1 className="sr-only">Orbit</h1>
      {live && <LiveStrip view={live} />}
      <PendingInvitationsAlert />
      <NoticesAlert />
      <ReportsAlert />
      <HerePanel live={live} />
      {getStarted.guide}
      <StarsRow live={live} />
      <UniversesRow live={live} />
      <MembershipsRow live={live} />
      {getStarted.comesBack}
    </div>
  );
}
