'use client';

import { LiveNowView } from '../components/live/live-now';
import { LoadingRows } from '../components/ds';
import { useLive } from '../hooks/use-live';

/** Live now, all of it: every room with people in it right now, and everyone online, as you may see them. */
export default function LivePage() {
  const live = useLive();
  return (
    <div className="grid min-w-0 gap-6">
      <h1 className="sr-only">Live now</h1>
      {live === undefined ? (
        <LoadingRows label="who is online" rows={3} />
      ) : live === null ? (
        <p className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground" role="status">
          Live now can’t reach the game right now. It shows up again on its own.
        </p>
      ) : (
        <LiveNowView view={live} layout="all" />
      )}
    </div>
  );
}
