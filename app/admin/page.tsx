'use client';

import HerePanel from './components/here-panel';
import PendingInvitationsAlert from './components/pending-invitations-alert';
import { LiveStrip } from './components/live/live-now';
import { useGetStartedOnOrbit } from './components/orbit/get-started-on-orbit';
import { MembershipsRow, StarsRow, UniversesRow } from './components/orbit/rows';
import { useLive } from './hooks/use-live';
import { ReportsAlert } from './components/world-safety';
import { NoticesAlert } from './components/notices-alert';
import { GitHubSetupRow, useGitHubSetup } from './components/github-setup-row';
import { useIsSuperAdmin } from './admin-bootstrap-context';

/**
 * Orbit is here and now: who is live right now (one line, on top), an invitation waiting for you, notices from Orbit
 * (a key of yours is down), reports waiting in worlds you run, your timeline (the room you're in, the one before it
 * and the rooms you were in lately), Get started until it's done, then your stars, your universes and the universes
 * you joined, each a row that scrolls sideways with the busiest first. Hidden, Get started leaves a row at the bottom
 * that brings it back. Everything out there is in Space.
 *
 * For super admins, also "GitHub for Universe" (the one-time GitHub App setup, game #2041): under the alerts until it is
 * done, a quiet row at the bottom after.
 */
export default function AdminDashboard() {
  const live = useLive();
  const getStarted = useGetStartedOnOrbit();
  const gitHubMade = useGitHubSetup(useIsSuperAdmin());

  return (
    <div className="orbit-home">
      <h1 className="sr-only">Orbit</h1>
      {live && <LiveStrip view={live} />}
      <PendingInvitationsAlert />
      <NoticesAlert />
      <ReportsAlert />
      {gitHubMade === false && <GitHubSetupRow made={false} />}
      <HerePanel live={live} />
      {getStarted.guide}
      <StarsRow live={live} />
      <UniversesRow live={live} />
      <MembershipsRow live={live} />
      {gitHubMade === true && <GitHubSetupRow made />}
      {getStarted.comesBack}
    </div>
  );
}
