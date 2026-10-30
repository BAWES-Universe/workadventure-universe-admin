import { prisma } from '@/lib/db';
import { FAILED_REPLIES_TO_DOWN, RECHECK_MS, judgeFailedReply, type DownReason } from '@/lib/ai-key-health';

/**
 * Is a person's voice key working (#749), and what do its bots do while it isn't: they carry on in text until it is back (the
 * owner can move a bot to Universe AI's voice in its profile; nothing switches by itself). The same rules as a text key
 * (lib/ai-key-health.ts): a key the provider rejects, or that is out of credit or has lost its model, is Down at once; other
 * failed calls count and two in a row mark it Down. A Down key is tried again at most every 5 minutes, and only when a bot
 * needs it: the bot server's next spoken turn is the try (lib/bot-voice.ts hands out one at a time), and it switches back as
 * soon as a call works. Orbit calls no provider. Server providers are never touched: they have no owner and no health.
 */
export type { DownReason };

/** What the bot server saw when it used a key: it worked, or it failed with the HTTP status the provider answered (none: a dropped connection or a timeout). */
export type VoiceCallOutcome = { ok: true } | { ok: false; status?: number; rejected?: boolean };

export interface VoiceKeyHealth {
  status: 'working' | 'down';
  downSince: string | null;
  downReason: DownReason | null;
}

const asDownReason = (value: string | null): DownReason =>
  value === 'rejected' || value === 'errors' || value === 'credit' || value === 'model' ? value : 'stopped';

export const healthOf = (row: { downSince: Date | null; downReason: string | null }): VoiceKeyHealth => ({
  status: row.downSince ? 'down' : 'working',
  downSince: row.downSince ? row.downSince.toISOString() : null,
  downReason: row.downSince ? asDownReason(row.downReason) : null,
});

const personal = (id: string) => ({ id, ownerId: { not: null } });

/** Marks a Working key Down, once. */
async function markDown(id: string, reason: DownReason, now: Date) {
  await prisma.voiceProvider.updateMany({ where: { ...personal(id), downSince: null }, data: { downSince: now, downReason: reason, failedCalls: 0, healthCheckedAt: now } });
}

/**
 * What the bot server reports after using a key: a call that worked, or one that failed. Returns the key's health now, or
 * null when it is not a person's key.
 */
export async function reportVoiceKeyCall(id: string, outcome: VoiceCallOutcome, now = new Date()): Promise<VoiceKeyHealth | null> {
  const key = await prisma.voiceProvider.findFirst({ where: personal(id), select: { id: true } });
  if (!key) return null;
  if (outcome.ok) {
    await prisma.voiceProvider.updateMany({
      where: { ...personal(id), OR: [{ downSince: { not: null } }, { failedCalls: { gt: 0 } }] },
      data: { downSince: null, downReason: null, failedCalls: 0, healthCheckedAt: now },
    });
  } else {
    const verdict = judgeFailedReply(outcome.status, outcome.rejected);
    if (verdict.counts && verdict.down) {
      await markDown(id, verdict.down, now);
      // Already Down: a failed try starts the wait again, and a clearer reason replaces a vaguer one
      await prisma.voiceProvider.updateMany({ where: { ...personal(id), downSince: { not: null } }, data: { downReason: verdict.down, healthCheckedAt: now } });
    } else if (verdict.counts) {
      await prisma.voiceProvider.updateMany({ where: { ...personal(id), downSince: { not: null } }, data: { healthCheckedAt: now } });
      await prisma.voiceProvider.updateMany({ where: { ...personal(id), downSince: null }, data: { failedCalls: { increment: 1 } } });
      const after = await prisma.voiceProvider.findUnique({ where: { id }, select: { failedCalls: true, downSince: true } });
      if (after && !after.downSince && after.failedCalls >= FAILED_REPLIES_TO_DOWN) await markDown(id, 'errors', now);
    }
  }
  const row = await prisma.voiceProvider.findUnique({ where: { id }, select: { downSince: true, downReason: true } });
  return row ? healthOf(row) : null;
}

/**
 * Hands out the one try a Down key gets every 5 minutes: true for the caller that may use it, false for everyone else until
 * the wait is over. A key that isn't Down needs no try.
 */
export async function claimVoiceKeyTry(id: string, now = new Date()): Promise<boolean> {
  const claimed = await prisma.voiceProvider.updateMany({
    where: { ...personal(id), downSince: { not: null }, OR: [{ healthCheckedAt: null }, { healthCheckedAt: { lt: new Date(now.getTime() - RECHECK_MS) } }] },
    data: { healthCheckedAt: now },
  });
  return claimed.count > 0;
}

/** The owner asks for a try now: the next bot that needs the key is allowed one, without waiting out the 5 minutes. */
export async function askForVoiceKeyTry(ownerId: string, id: string): Promise<boolean> {
  const asked = await prisma.voiceProvider.updateMany({ where: { id, ownerId, downSince: { not: null } }, data: { healthCheckedAt: null } });
  return asked.count > 0;
}
