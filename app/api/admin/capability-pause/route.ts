import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { CAPABILITIES, getCapabilityPauses, pauseCapability, pauseReasonWords, resumeCapability, type Capability } from '@/lib/capability-pause';
import { liftWindDown, windDownStatus } from '@/lib/computer';

export const runtime = 'nodejs';

/**
 * The team's pause for each paid capability on its own: Instant Apps, Apps and computers. A command, not a setting. Super admins only.
 *
 *   GET  -> { capabilities: [{ key, name, paused, reason, words, at, ... }] }  where each stands
 *   POST { capability: 'instant' | 'apps' | 'computers', action: 'pause' | 'resume' }  takes hold at once and answers as GET does
 *
 * A paused capability takes no new work and says so kindly; what it already made stays, and work already going finishes. Computers
 * have a deeper command beside this one (the wind-down, which ends the jobs going now): resuming computers lifts both, so one tap
 * always puts them back. Instant also pauses itself when too many runs fail or a price moves: the same pause, the same resume.
 */
const bodySchema = z.object({ capability: z.enum(CAPABILITIES), action: z.enum(['pause', 'resume']) }).strict();

const NAMES: Record<Capability, string> = { instant: 'Instant Apps', apps: 'Apps', computers: 'Computers' };

const noStore = { headers: { 'Cache-Control': 'no-store' } };

async function superAdmin(request: NextRequest): Promise<{ id: string; email: string } | null> {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? { id: user.id, email: user.email as string } : null;
}

async function answer() {
  const [pauses, wind] = await Promise.all([getCapabilityPauses(), windDownStatus()]);
  const capabilities = CAPABILITIES.map((key) => {
    const pause = pauses[key];
    // Computers also stand closed while the team's wind-down is on (it closes the same door)
    const windDownOn = key === 'computers' && wind.on;
    const paused = pause.paused || windDownOn;
    const reason = pause.paused ? pause.reason : windDownOn ? 'wind_down' : null;
    return {
      key,
      name: NAMES[key],
      paused,
      reason,
      words: windDownOn && !pause.paused ? 'Wound down: every job ended and every machine stopped' : pauseReasonWords(key, pause.reason),
      at: pause.paused ? pause.at : windDownOn ? wind.since : null,
      ...(key === 'computers' ? { jobsLeft: wind.jobsLeft, machinesLeft: wind.machinesLeft } : {}),
    };
  });
  return { capabilities };
}

export async function GET(request: NextRequest) {
  try {
    if (!(await superAdmin(request))) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    return NextResponse.json(await answer(), noStore);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'pause' } });
    console.error('[Pause] Could not read where each stands:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const by = await superAdmin(request);
    if (!by) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Say which one ("instant", "apps" or "computers") and "pause" or "resume"' }, { status: 400 });
    const { capability, action } = parsed.data;
    if (action === 'pause') {
      await pauseCapability(capability, by.id);
    } else {
      await resumeCapability(capability, by.id);
      // One tap puts computers back: the deeper wind-down is lifted with the pause
      if (capability === 'computers') await liftWindDown(by.email);
    }
    return NextResponse.json(await answer(), noStore);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'pause' } });
    console.error('[Pause] The pause command failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
