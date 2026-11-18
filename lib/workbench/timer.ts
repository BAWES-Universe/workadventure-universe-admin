import { sweepCodeJobs } from '@/lib/workbench/executor';

/** How often Orbit looks after code jobs on its own. A job that is lost is ended within this and the time it takes to see it is lost. */
const EVERY_MS = 30_000;

const SLOT = Symbol.for('universe.codejob.sweep');
const slot = globalThis as unknown as Record<symbol, ReturnType<typeof setInterval> | undefined>;

/** Starts the sweep timer once for this process (a second call does nothing). It never keeps the process alive and never throws. */
export function startCodeJobSweep(): void {
  if (slot[SLOT]) return;
  let running = false;
  const timer = setInterval(() => {
    // One sweep at a time in this process; another process sweeping at the same moment is safe (every step moves a job only once)
    if (running) return;
    running = true;
    sweepCodeJobs()
      .catch((error) => console.error('[CodeJob] Sweep failed:', error instanceof Error ? error.message : 'unknown'))
      .finally(() => {
        running = false;
      });
  }, EVERY_MS);
  timer.unref?.();
  slot[SLOT] = timer;
}
