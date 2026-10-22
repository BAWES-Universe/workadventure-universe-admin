import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { kindInfo } from '@/lib/ai-key-kinds';
import { probeChat, probeModels, type ProbeFailure } from '@/lib/ai-key-models';
import { addNotice, clearNotices } from '@/lib/notices';

/**
 * Is a personal key working, and what do its bots do while it isn't (#374). A key is Down after two replies in a row
 * fail, or one failed check, and a key the provider rejects counts at once. Universe checks a Down key again every
 * 5 minutes (the next time one of its bots needs it after that) and the key switches back by itself. The key's owner
 * gets one notice per outage. Server providers are never touched: they have no owner and no health.
 */
export const RECHECK_MS = 5 * 60_000;
/** How long a bot's request waits for a check of its Down key (Stop replying) before it rests; the check carries on. */
export const CHECK_WAIT_MS = 8_000;
export const FAILED_REPLIES_TO_DOWN = 2;

export type IfDown = 'universe-ai' | 'stop';
export const IF_DOWN_VALUES: readonly IfDown[] = ['universe-ai', 'stop'];
export const isIfDown = (value: unknown): value is IfDown => IF_DOWN_VALUES.includes(value as IfDown);

/** Why a key is Down: nobody answered, the provider rejected the key, or its replies kept failing. */
export type DownReason = 'stopped' | 'rejected' | 'errors';

/** The one line visitors see from a bot that is resting because its key is down and its owner chose Stop replying. */
export const RESTING_LINE = 'I’m resting right now. Try me again later.';

const KIND_NOTICE = 'ai-key-down';
const noticePrefix = (providerId: string) => `down:${providerId}:`;

export interface KeyRow {
  providerId: string;
  name: string;
  ownerId: string | null;
  endpoint: string | null;
  apiKeyEncrypted: string | null;
  settings: unknown;
  downSince: Date | null;
  ifDown: string;
  healthCheckedAt: Date | null;
  /** The model it was added with, and why it is Down: a key that went Down on failed replies is only trusted again once a chat call works. */
  model?: string | null;
  downReason?: string | null;
}

/** Writes the notice for the person who owns the key; the own-computer wording says conversations leave the computer. */
async function tellOwner(key: KeyRow, since: Date, reason: DownReason) {
  if (!key.ownerId) return;
  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  const own = info?.group === 'own-computer';
  const what = reason === 'rejected' ? `${info?.label ?? 'The provider'} stopped accepting this key.` : `${info?.label ?? 'It'} stopped answering.`;
  const meanwhile =
    key.ifDown === 'stop'
      ? 'Bots on it are resting until it’s back.'
      : own
        ? 'Bots on it reply on Universe AI until it’s back, so their conversations leave your computer meanwhile.'
        : 'Bots on it reply on Universe AI until it’s back.';
  try {
    await addNotice({
      userId: key.ownerId,
      kind: KIND_NOTICE,
      dedupeKey: `${noticePrefix(key.providerId)}${since.toISOString()}`,
      title: `${key.name} is down`,
      badge: 'Down',
      body: `${what} ${meanwhile} Universe checks every 5 minutes and switches back by itself.`,
      href: '/admin/you/ai-keys',
    });
  } catch (error) {
    console.error('[AiKeys] Could not tell the key owner:', error instanceof Error ? error.message : 'unknown');
  }
}

/** Marks a Working key Down, once: only the call that flips it writes the notice. Returns true if it flipped. */
export async function markDown(key: KeyRow, reason: DownReason, now = new Date()): Promise<boolean> {
  const flipped = await prisma.botsAiProvider.updateMany({
    where: { providerId: key.providerId, ownerId: { not: null }, downSince: null },
    data: { downSince: now, downReason: reason, failedReplies: 0, healthCheckedAt: now },
  });
  if (flipped.count === 0) return false;
  await tellOwner(key, now, reason);
  return true;
}

/** Dismisses the "is down" notice of a key that is being removed, so it doesn't point at a key that no longer exists. */
export async function clearDownNotice(ownerId: string, providerId: string): Promise<void> {
  await clearNotices(ownerId, KIND_NOTICE, noticePrefix(providerId));
}

/** Marks a Down key Working and clears its notice. Returns true if it flipped. */
export async function markWorking(key: Pick<KeyRow, 'providerId' | 'ownerId'>, now = new Date()): Promise<boolean> {
  const flipped = await prisma.botsAiProvider.updateMany({
    where: { providerId: key.providerId, ownerId: { not: null }, downSince: { not: null } },
    data: { downSince: null, downReason: null, failedReplies: 0, healthCheckedAt: now },
  });
  if (flipped.count === 0) return false;
  if (key.ownerId) {
    try {
      await clearNotices(key.ownerId, KIND_NOTICE, noticePrefix(key.providerId));
    } catch (error) {
      console.error('[AiKeys] Could not clear the notice:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return true;
}

export type KeyCheck = { ok: true } | { ok: false; reason: DownReason; message: string } | { ok: false; busy: true; message: string };

/**
 * Asks the key's provider for its model list with the saved key: the same check Add key runs. A key that went Down on
 * failed or rejected replies must also get one tiny chat reply from its saved model, because a model list can answer
 * while chat does not (a key that may list models but not chat is rejected on every reply).
 */
export async function checkKey(key: KeyRow): Promise<KeyCheck> {
  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  if (!info) return { ok: false, reason: 'stopped', message: 'This key’s type is not known.' };
  let apiKey: string | undefined;
  try {
    apiKey = key.apiKeyEncrypted ? decryptApiKey(key.apiKeyEncrypted) : undefined;
  } catch {
    return { ok: false, reason: 'rejected', message: 'The saved key can’t be read. Add it again.' };
  }
  const address = key.endpoint ?? undefined;
  const models = await probeModels({ kind: info.kind, address, apiKey });
  if (!models.ok) return failed(models);
  if (key.downSince && (key.downReason === 'errors' || key.downReason === 'rejected') && key.model) {
    const chat = await probeChat({ kind: info.kind, address, apiKey, model: key.model });
    if (!chat.ok) return failed(chat);
  }
  return { ok: true };
}

function failed(result: { message: string; reason: ProbeFailure }): KeyCheck {
  // The provider answered that it is busy: that says nothing about the key, so it is left as it is
  if (result.reason === 'busy') return { ok: false, busy: true, message: result.message };
  return { ok: false, reason: result.reason === 'rejected' ? 'rejected' : 'stopped', message: result.message };
}

const KEY_SELECT = {
  providerId: true,
  name: true,
  ownerId: true,
  endpoint: true,
  apiKeyEncrypted: true,
  settings: true,
  downSince: true,
  ifDown: true,
  healthCheckedAt: true,
  model: true,
  downReason: true,
} as const;

/** Checks the key now and updates its state: Working if it answers, Down if not. Used by Check now and the 5-minute recheck. */
export async function checkAndRecord(key: KeyRow): Promise<KeyCheck> {
  const result = await checkKey(key);
  if ('busy' in result) {
    // Neither Working nor Down is proven: keep the state, and look again at the next due check
    await prisma.botsAiProvider.updateMany({ where: { providerId: key.providerId }, data: { healthCheckedAt: new Date() } });
    return result;
  }
  if (result.ok) {
    await markWorking(key);
    await prisma.botsAiProvider.updateMany({ where: { providerId: key.providerId }, data: { healthCheckedAt: new Date() } });
  } else if (!(await markDown(key, result.reason))) {
    // Already Down: only a rejection changes why. Anything else keeps the reason it went Down with, because a key that went
    // Down on failed replies must keep being checked by a chat reply, not just the model list.
    await prisma.botsAiProvider.updateMany({
      where: { providerId: key.providerId },
      data: result.reason === 'rejected' ? { healthCheckedAt: new Date(), downReason: 'rejected' } : { healthCheckedAt: new Date() },
    });
  }
  return result;
}

/**
 * A reply on a personal key worked or failed (the bot server tells us, by bot id, only for replies it really sent
 * through the key). A success clears a run of failures; two failures in a row, or a rejection, mark the key Down. A Down
 * key is not on the replies' path, so only a check brings it back.
 */
export async function recordReply(providerId: string, outcome: { ok: true } | { ok: false; rejected?: boolean }): Promise<void> {
  const key = await prisma.botsAiProvider.findFirst({ where: { providerId, ownerId: { not: null } }, select: { ...KEY_SELECT, failedReplies: true } });
  if (!key) return;
  // Already Down: replies are not going through this key now, so a report says nothing new
  if (key.downSince) return;
  if (outcome.ok) {
    if (key.failedReplies > 0) await prisma.botsAiProvider.updateMany({ where: { providerId }, data: { failedReplies: 0 } });
    return;
  }
  if (outcome.rejected) {
    await markDown(key, 'rejected');
    return;
  }
  const bumped = await prisma.botsAiProvider.update({ where: { providerId }, data: { failedReplies: { increment: 1 } }, select: { failedReplies: true } });
  if (bumped.failedReplies >= FAILED_REPLIES_TO_DOWN) await markDown(key, 'errors');
}

/**
 * If the key is Down and has not been checked for 5 minutes, checks it (one request claims the check, so a busy bot does
 * not make a pile of them). Returns the key as it is after. With Stop replying the answer waits for the check, so a key
 * that came back is used at once; with Universe AI answering meanwhile, it does not.
 */
export async function recheckIfDue(key: KeyRow, now = new Date()): Promise<KeyRow> {
  if (!key.downSince) return key;
  const due = !key.healthCheckedAt || now.getTime() - key.healthCheckedAt.getTime() >= RECHECK_MS;
  if (!due) return key;
  const claimed = await prisma.botsAiProvider.updateMany({
    where: {
      providerId: key.providerId,
      downSince: { not: null },
      OR: [{ healthCheckedAt: null }, { healthCheckedAt: { lt: new Date(now.getTime() - RECHECK_MS) } }],
    },
    data: { healthCheckedAt: now },
  });
  if (claimed.count === 0) return key;
  const running = checkAndRecord(key).catch((error) => {
    console.error('[AiKeys] Recheck failed:', error instanceof Error ? error.message : 'unknown');
  });
  if (key.ifDown !== 'stop') {
    void running;
    return key;
  }
  // A provider that hangs must not hold the bot's request for the whole probe time: past the wait the key stays as it is
  // (so the bot rests) and the check goes on in the background and records its result.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    running.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), CHECK_WAIT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!finished) return key;
  return (await prisma.botsAiProvider.findUnique({ where: { providerId: key.providerId }, select: KEY_SELECT })) ?? key;
}
