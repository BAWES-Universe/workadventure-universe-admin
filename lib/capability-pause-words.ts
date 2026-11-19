import type { Capability } from '@/lib/capability-pause';

/** What each capability is, in the words the team sees on the Pause rows (people never see these). */
export const CAPABILITY_ABOUT: Record<Capability, string> = {
  instant: 'Apps that work without connecting anything. Universe pays for each run.',
  apps: 'Apps people connect with one tap, like Gmail and Calendar.',
  computers: 'The computers Bricks use for jobs on websites and files.',
};

/** What a pause does, said once under the rows. */
export const PAUSE_NOTE = 'A paused one takes no new work, and Bricks say so kindly. What was already made stays, and work already going finishes.';

/** What a person is told by their Brick while it is paused (kept here so the team can read the same words the game says). */
export const PAUSED_LINE: Record<Capability, string> = {
  instant: 'Instant Apps are paused for a while, so that was not done.',
  apps: 'Apps are paused for a while, so that was not done.',
  computers: 'Computers are paused for a while, so that was not started.',
};

/** The wind-down is "on" the moment it starts; it is only done when nothing is left, and until then the words say what is. */
export function windDownWords(jobsLeft: number, machinesLeft: number): string {
  if (jobsLeft <= 0 && machinesLeft <= 0) return 'Wound down: every job ended and every machine stopped';
  const left = [jobsLeft > 0 ? `${jobsLeft} ${jobsLeft === 1 ? 'job' : 'jobs'} still ending` : null, machinesLeft > 0 ? `${machinesLeft} ${machinesLeft === 1 ? 'machine' : 'machines'} still stopping` : null].filter(Boolean);
  return `Winding down: ${left.join(', ')}`;
}
