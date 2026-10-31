import { prisma } from '@/lib/db';
import { FAILED_REPLIES_TO_DOWN, RECHECK_MS, judgeFailedReply, type DownReason, type ReplyVerdict } from '@/lib/ai-key-health';

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

/** The job a call was for: a key that does both is judged per job, so one job working does not hide the other failing. */
export type VoicePart = 'recognition' | 'speech';
const counter = (part: VoicePart) => (part === 'recognition' ? 'failedRecognition' : 'failedSpeech');

/** Marks a Working key Down, once. `part` is the job whose calls failed, null when the provider turned the whole key away. */
async function markDown(id: string, reason: DownReason, part: VoicePart | null, now: Date) {
  await prisma.voiceProvider.updateMany({
    where: { ...personal(id), downSince: null },
    data: { downSince: now, downReason: reason, downPart: part, failedRecognition: 0, failedSpeech: 0, healthCheckedAt: now },
  });
}

/**
 * What the bot server reports after using a key for one job: a call that worked, or one that failed. Returns the key's health
 * now, or null when it is not a person's key.
 */
export async function reportVoiceKeyCall(id: string, part: VoicePart, outcome: VoiceCallOutcome, now = new Date()): Promise<VoiceKeyHealth | null> {
  const key = await prisma.voiceProvider.findFirst({ where: personal(id), select: { id: true, downSince: true, downPart: true } });
  if (!key) return null;
  if (outcome.ok) {
    if (key.downSince) {
      // A Down key is Working again when the job that failed works; a key the provider turned away whole, when any job does
      if (!key.downPart || key.downPart === part) {
        await prisma.voiceProvider.updateMany({
          where: { ...personal(id), downSince: { not: null } },
          data: { downSince: null, downReason: null, downPart: null, failedRecognition: 0, failedSpeech: 0, healthCheckedAt: now },
        });
      }
    } else {
      // Only this job's failures in a row are over
      await prisma.voiceProvider.updateMany({ where: { ...personal(id), downSince: null, [counter(part)]: { gt: 0 } }, data: { [counter(part)]: 0 } });
    }
  } else {
    // A speech call's 404 is the voice that bot named (the voice is chosen per bot), not the key: it never takes the key Down
    const verdict: ReplyVerdict = part === 'speech' && outcome.status === 404 && !outcome.rejected ? { counts: false } : judgeFailedReply(outcome.status, outcome.rejected);
    if (verdict.counts && verdict.down) {
      await markDown(id, verdict.down, null, now);
      // Already Down: a failed try starts the wait again, and a clearer reason replaces a vaguer one
      await prisma.voiceProvider.updateMany({ where: { ...personal(id), downSince: { not: null } }, data: { downReason: verdict.down, downPart: null, healthCheckedAt: now } });
    } else if (verdict.counts) {
      // A failed try restarts the wait only for the job the key is Down for (or a key turned away whole): the other job
      // failing now and then does not push that job's next try back
      await prisma.voiceProvider.updateMany({
        where: { ...personal(id), downSince: { not: null }, OR: [{ downPart: null }, { downPart: part }] },
        data: { healthCheckedAt: now },
      });
      await prisma.voiceProvider.updateMany({ where: { ...personal(id), downSince: null }, data: { [counter(part)]: { increment: 1 } } });
      const after = await prisma.voiceProvider.findUnique({ where: { id }, select: { failedRecognition: true, failedSpeech: true, downSince: true } });
      const failed = after ? (part === 'recognition' ? after.failedRecognition : after.failedSpeech) : 0;
      if (after && !after.downSince && failed >= FAILED_REPLIES_TO_DOWN) await markDown(id, 'errors', part, now);
    }
  }
  const row = await prisma.voiceProvider.findUnique({ where: { id }, select: { downSince: true, downReason: true } });
  return row ? healthOf(row) : null;
}

/** Whether a Down key may be tried now: its wait is over, or its owner asked for a try. */
export const tryIsDue = (row: { downSince: Date | null; healthCheckedAt: Date | null }, now = new Date()) =>
  Boolean(row.downSince) && (!row.healthCheckedAt || row.healthCheckedAt.getTime() < now.getTime() - RECHECK_MS);

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
