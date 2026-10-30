/**
 * Voice limits (#740): what each limit is called, its recommended value and which values can be saved. No database here,
 * so the Orbit pages read the same values the server does. Saving and reading them is lib/voice-limits.ts.
 *
 * One super admin sets them for every voice-enabled bot. Nothing saved means the recommended value, and a change is read
 * by the game with no deploy.
 */

export interface VoiceLimits {
  /** Text replies kept back: of the replies one person gets in a fair usage window, about 1 in this many stay for text. */
  textReserveShare: number;
  /** Voice replies a guest gets in a window, however large the window is. */
  guestVoiceReplies: number;
  /** Longest spoken turn, in seconds of audio taken in. */
  turnSeconds: number;
  /** Longest spoken reply, in characters. */
  replyCharacters: number;
  /** Longest spoken reply, in seconds of audio made. */
  replySeconds: number;
  /** Minutes a day one bot listens for its name, all the people near it together. */
  listenMinutesPerDay: number;
  /** Seconds after a bot answers in which the person can keep going without its name. */
  followUpSeconds: number;
}

export const VOICE_LIMITS_RECOMMENDED: VoiceLimits = {
  textReserveShare: 6,
  guestVoiceReplies: 3,
  turnSeconds: 180,
  replyCharacters: 600,
  replySeconds: 60,
  listenMinutesPerDay: 60,
  followUpSeconds: 30,
};

/** The values that can be saved: anything a person might mean, nothing that would break a turn. */
export interface Range {
  min: number;
  max: number;
}

export const VOICE_RANGES: Record<keyof VoiceLimits, Range> = {
  textReserveShare: { min: 2, max: 100 },
  guestVoiceReplies: { min: 0, max: 1_000 },
  turnSeconds: { min: 5, max: 3_600 },
  replyCharacters: { min: 50, max: 20_000 },
  replySeconds: { min: 5, max: 600 },
  listenMinutesPerDay: { min: 0, max: 1_440 },
  followUpSeconds: { min: 5, max: 600 },
};

const fits = (value: unknown, range: Range): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const KEYS = Object.keys(VOICE_RANGES) as (keyof VoiceLimits)[];

/** The saved limits read back: each value that is there and fits, the recommended one for the rest. */
export function readVoiceLimits(saved: unknown): VoiceLimits {
  const out: VoiceLimits = { ...VOICE_LIMITS_RECOMMENDED };
  if (!isRecord(saved)) return out;
  for (const key of KEYS) {
    const value = saved[key];
    if (fits(value, VOICE_RANGES[key])) out[key] = value;
  }
  return out;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A change: only the limits' own names, each a whole number inside its range. Says which one is wrong. */
export function checkVoiceLimits(input: unknown): Checked<Partial<VoiceLimits>> {
  if (!isRecord(input)) return { ok: false, error: 'Expected an object' };
  const out: Partial<VoiceLimits> = {};
  for (const [key, value] of Object.entries(input)) {
    // Only the limits' own names: `constructor` and `toString` are on every object and are not limits
    if (!Object.prototype.hasOwnProperty.call(VOICE_RANGES, key)) return { ok: false, error: `Unknown limit: ${key}` };
    const range = VOICE_RANGES[key as keyof VoiceLimits];
    if (!fits(value, range)) return { ok: false, error: `${key} must be a whole number from ${range.min.toLocaleString('en')} to ${range.max.toLocaleString('en')}` };
    out[key as keyof VoiceLimits] = value;
  }
  return { ok: true, value: out };
}

/**
 * Replies kept for text out of a window of `window` replies: min(window - 1, max(1, ceil(window / share))). 30 keeps 5, 10
 * keeps 2, and a window of 1 keeps its only reply for text, so it has no voice replies at all.
 */
export function textReserve(window: number, share: number): number {
  if (!Number.isFinite(window) || window < 1) return 0;
  const whole = Math.floor(window);
  if (whole === 1) return 1;
  return Math.min(whole - 1, Math.max(1, Math.ceil(whole / share)));
}

/** Voice replies one person gets in a window of `window` replies; a guest never more than `limits.guestVoiceReplies`. */
export function voiceReplies(window: number, limits: VoiceLimits, guest: boolean): number {
  const left = Math.max(0, Math.floor(window) - textReserve(window, limits.textReserveShare));
  return guest ? Math.min(left, limits.guestVoiceReplies) : left;
}
